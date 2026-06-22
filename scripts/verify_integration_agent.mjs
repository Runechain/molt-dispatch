// $0 verification of the integration agent — the deliberation-backed judgment over the floor.
// Injects a mock infer (no real models). Proves the verdict drives the run-gate: release lets
// the dependent run, hold/escalate keep it gated even though the floor is satisfied, escalate
// also flags needs_review, a broken panel fails safe to hold, and unconfigured = floor behavior.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'moltintg-'));

const { getDb, now } = await import('../src/broker/db.mjs');
const od = await import('../src/broker/objective-deps.mjs');
const agent = await import('../src/broker/agents/integration-agent.mjs');
const { claimableJobsFor } = await import('../src/broker/scheduler.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

const d = getDb();
let oseq = 0;
let jseq = 0;
function obj(sourceIssue, status = 'in_progress', prUrl = null) {
  const id = `O-${++oseq}`;
  d.prepare(`INSERT INTO objectives(id,title,status,source_issue,pr_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, `obj ${id}`, status, sourceIssue, prUrl, now(), now());
  return id;
}
function job(objectiveId) {
  const id = `J-${++jseq}`;
  d.prepare(`INSERT INTO jobs(id,objective_id,type,title,capability_required,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, objectiveId, 'code.implementation', `job ${id}`, 'code.implementation', 'pending', now(), now());
  return id;
}
const WORKER = { id: 'W1', capabilities: ['code.implementation'], trust_tier: 0 };
const canClaim = (jobId) => claimableJobsFor(WORKER).some((j) => j.id === jobId);

// Mock infer: cheap personas return text; the premium judge returns the per-test verdict JSON.
function mockInfer(verdict) {
  return async ({ tier, role }) => {
    if (role === 'judge') return { text: typeof verdict === 'string' ? verdict : JSON.stringify(verdict) };
    return { text: `[${role}] argument` };
  };
}

// Build an approved upstream A (PR open) + dependent B that the floor already considers satisfied.
function scenario() {
  const A = obj(100 + oseq, 'approved', 'https://github.com/x/y/pull/9'); // PR mode: approved != merged
  const B = obj(200 + oseq, 'in_progress');
  od.recordObjectiveDeps(B, Number(d.prepare('SELECT source_issue s FROM objectives WHERE id=?').get(B).s), [
    d.prepare('SELECT source_issue s FROM objectives WHERE id=?').get(A).s,
  ]);
  od.resolveAndGate();
  const jb = job(B);
  return { A, B, jb };
}

console.log('integration agent — release lets the dependent run');
{
  const { A, B, jb } = scenario();
  agent.setIntegrationInfer(mockInfer({ decision: 'release', winner: 'optimist', confidence: 0.8, rationale: 'upstream merged' }));
  ok(agent.integrationConfigured(), 'agent configured');
  const r = await agent.integrateUpstreamApproved(A);
  ok(r.dependents[0].decision === 'release', 'verdict = release');
  ok(od.objectivesOnHold().has(B) === false, 'no hold placed');
  ok(canClaim(jb) === true, "dependent's job becomes claimable");
}

console.log('integration agent — hold keeps it gated though the floor is satisfied');
{
  const { A, B, jb } = scenario();
  ok(od.objectiveDepsSatisfied(B) === true, 'floor alone would release (upstream approved)');
  agent.setIntegrationInfer(mockInfer({ decision: 'hold', confidence: 0.4, rationale: 'PR not merged yet' }));
  const r = await agent.integrateUpstreamApproved(A);
  ok(r.dependents[0].decision === 'hold', 'verdict = hold');
  ok(od.objectivesOnHold().has(B) === true, 'agent places a run-hold');
  ok(canClaim(jb) === false, 'scheduler refuses the job despite a satisfied floor');
}

console.log('integration agent — escalate gates AND flags needs_review');
{
  const { A, B, jb } = scenario();
  agent.setIntegrationInfer(mockInfer({ decision: 'escalate', escalate: true, escalateReason: 'merge conflict risk', confidence: 0.2 }));
  const r = await agent.integrateUpstreamApproved(A);
  ok(r.dependents[0].escalate === true, 'verdict = escalate');
  ok(canClaim(jb) === false, 'dependent held from running');
  ok(d.prepare('SELECT needs_review n FROM objectives WHERE id=?').get(B).n === 1, 'needs_review flagged for the human');
}

console.log('integration agent — a broken panel fails safe to escalate (held)');
{
  const { A, B, jb } = scenario();
  agent.setIntegrationInfer(async ({ role }) => { if (role === 'judge') throw new Error('judge provider down'); return { text: 'x' }; });
  const r = await agent.integrateUpstreamApproved(A);
  ok(r.dependents[0].escalate === true && /fail|error|down/i.test(r.dependents[0].reason || ''), 'panel failure escalates, not releases');
  ok(canClaim(jb) === false, 'dependent stays gated on panel failure');
}

console.log('integration agent — unconfigured falls back to the deterministic floor');
{
  const { A, B, jb } = scenario();
  agent.setIntegrationInfer(null);
  ok(agent.integrationConfigured() === false, 'agent disabled');
  const r = await agent.integrateUpstreamApproved(A);
  ok(r.dependents[0].decision === 'release', 'floor releases on approval');
  ok(canClaim(jb) === true, 'dependent runs under the deterministic floor');
}

console.log('integration agent — dependent is PRE-HELD across the deliberation (no leak window)');
{
  const { A, B } = scenario();
  let heldDuringJudge = null;
  agent.setIntegrationInfer(async ({ role }) => {
    if (role === 'judge') { heldDuringJudge = od.objectivesOnHold().has(B); return { text: JSON.stringify({ decision: 'release', confidence: 0.9, rationale: 'ok' }) }; }
    return { text: 'arg' };
  });
  await agent.integrateUpstreamApproved(A);
  ok(heldDuringJudge === true, 'dependent is held DURING deliberation, closing the TOCTOU window');
  ok(od.objectivesOnHold().has(B) === false, 'release verdict clears the pre-hold afterward');
}

console.log('integration agent — operator release recovers an escalated dependent');
{
  const { A, B, jb } = scenario();
  agent.setIntegrationInfer(mockInfer({ decision: 'escalate', escalate: true, escalateReason: 'conflict', confidence: 0.2 }));
  await agent.integrateUpstreamApproved(A);
  ok(canClaim(jb) === false && d.prepare('SELECT needs_review n FROM objectives WHERE id=?').get(B).n === 1, 'escalated: held + needs_review');
  // Simulate POST /objectives/:id/release (the operator merged the upstream PR).
  od.clearObjectiveHold(B); od.clearNeedsReview(B); od.applyObjectiveGatingStatus(B);
  ok(d.prepare('SELECT needs_review n FROM objectives WHERE id=?').get(B).n === 0, 'release clears needs_review');
  ok(canClaim(jb) === true, 'release re-enables the dependent — escape hatch works');
}

console.log('integration agent — hold does not drag a non-pre-terminal dependent backwards');
{
  const { A, B } = scenario();
  d.prepare(`UPDATE objectives SET status='ready_for_approval' WHERE id=?`).run(B);
  agent.setIntegrationInfer(mockInfer({ decision: 'hold', confidence: 0.4, rationale: 'wait' }));
  await agent.integrateUpstreamApproved(A);
  ok(d.prepare('SELECT status s FROM objectives WHERE id=?').get(B).s === 'ready_for_approval', 'ready_for_approval status preserved');
  ok(od.objectivesOnHold().has(B) === true, 'but dep_hold still tightens the run-gate');
}

console.log(`\n✅ integration agent: ${passed} checks passed`);
