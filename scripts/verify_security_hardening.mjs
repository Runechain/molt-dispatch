// $0 verification of the verify-don't-trust hardening (security audit fixes #18/#20). Fresh temp DB.
// Proves: trust is gated on EARNED reputation (not self-declared trust_tier); a reviewer can't
// claim or pass the review of an implementation it authored; the review rubric schema (previously
// never applied) is enforced.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'moltsec-'));

const { getDb, now } = await import('../src/broker/db.mjs');
const { claimableJobsFor } = await import('../src/broker/scheduler.mjs');
const { validateResult } = await import('../src/broker/validator.mjs');
const { recordEvent } = await import('../src/broker/reputation.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

const d = getDb();
let oseq = 0, jseq = 0;
function obj() { const id = `O-${++oseq}`; d.prepare(`INSERT INTO objectives(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)`).run(id, id, 'in_progress', now(), now()); return id; }
function job(objId, { type = 'code.implementation', cap = type, status = 'pending', worker = null, trustReq = 0 } = {}) {
  const id = `J-${++jseq}`;
  d.prepare(`INSERT INTO jobs(id,objective_id,type,title,capability_required,status,assigned_worker_id,trust_required,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, objId, type, id, cap, status, worker, trustReq, now(), now());
  return id;
}
const dep = (jobId, dependsOn) => d.prepare(`INSERT INTO job_dependencies(job_id,depends_on_job_id) VALUES(?,?)`).run(jobId, dependsOn);
const VALID_RUBRIC = { correctness: 5, scope_control: 5, maintainability: 5, security: 5, test_coverage: 5, confidence: 5, recommendation: 'approve', summary: 'lgtm', objections: [] };
const reviewResult = (review) => ({ lease_token: 't', status: 'completed', review });

console.log('#18 — trust gate uses EARNED reputation, not self-declared trust_tier');
{
  const o = obj();
  const j = job(o, { trustReq: 0.6 }); // job needs reputation >= 0.6 for code.implementation
  // A worker that LIES with trust_tier:99 but has zero history (trustScore prior 0.5) must NOT pass.
  const liar = { id: 'LIAR', capabilities: ['code.implementation'], trust_tier: 99 };
  ok(!claimableJobsFor(liar).some((x) => x.id === j), 'self-declared trust_tier:99 does NOT bypass the trust gate');
  // Earn reputation, then it qualifies.
  recordEvent('PROVEN', 'code.implementation', 'accepted', 'J-x');
  recordEvent('PROVEN', 'code.implementation', 'accepted', 'J-y');
  const proven = { id: 'PROVEN', capabilities: ['code.implementation'], trust_tier: 0 };
  ok(claimableJobsFor(proven).some((x) => x.id === j), 'a worker with earned reputation clears the gate');
}

console.log('#20 — reviewer independence at CLAIM (scheduler)');
{
  const o = obj();
  const impl = job(o, { type: 'code.implementation', status: 'accepted', worker: 'AUTHOR' });
  const review = job(o, { type: 'code.review', cap: 'code.review', status: 'pending' });
  dep(review, impl);
  ok(!claimableJobsFor({ id: 'AUTHOR', capabilities: ['code.review'] }).some((x) => x.id === review), 'the implementation author CANNOT claim the review of its own work');
  ok(claimableJobsFor({ id: 'OTHER', capabilities: ['code.review'] }).some((x) => x.id === review), 'an independent worker CAN claim the review');
}

console.log('#20 — reviewer independence at RESULT (validator, authoritative)');
{
  const o = obj();
  const impl = job(o, { type: 'code.implementation', status: 'accepted', worker: 'AUTHOR' });
  const review = job(o, { type: 'code.review', cap: 'code.review', status: 'claimed', worker: 'AUTHOR' }); // author self-graded
  dep(review, impl);
  const reviewJob = d.prepare('SELECT * FROM jobs WHERE id=?').get(review);
  let v = await validateResult(reviewJob, reviewResult(VALID_RUBRIC), { contract: {} });
  ok(v.pass === false && v.reasons.some((r) => /not independent/.test(r)), 'a self-graded all-5s review is REJECTED (reviewer == implementer)');

  // Same review, but claimed by an independent reviewer → passes.
  d.prepare(`UPDATE jobs SET assigned_worker_id='REVIEWER' WHERE id=?`).run(review);
  const reviewJob2 = d.prepare('SELECT * FROM jobs WHERE id=?').get(review);
  v = await validateResult(reviewJob2, reviewResult(VALID_RUBRIC), { contract: {} });
  ok(v.pass === true, 'an independent reviewer with a valid rubric passes');
}

console.log('#20 — review rubric schema is ENFORCED (was defined but never applied)');
{
  const o = obj();
  const impl = job(o, { type: 'code.implementation', status: 'accepted', worker: 'AUTHOR' });
  const review = job(o, { type: 'code.review', cap: 'code.review', status: 'claimed', worker: 'REVIEWER' });
  dep(review, impl);
  const reviewJob = d.prepare('SELECT * FROM jobs WHERE id=?').get(review);
  // A bare "approve" with no scored dimensions used to pass; now it's malformed → rejected.
  let v = await validateResult(reviewJob, reviewResult({ recommendation: 'approve' }), { contract: {} });
  ok(v.pass === false && v.reasons.some((r) => /rubric/.test(r)), 'a rubric missing the scored dimensions is rejected');
  // Out-of-range score rejected.
  v = await validateResult(reviewJob, reviewResult({ ...VALID_RUBRIC, correctness: 99 }), { contract: {} });
  ok(v.pass === false, 'an out-of-range score is rejected');
  // A review job with NO rubric at all is rejected (used to be silently skipped).
  v = await validateResult(reviewJob, { lease_token: 't', status: 'completed' }, { contract: {} });
  ok(v.pass === false, 'a review job with no rubric at all is rejected (no silent skip)');
}

console.log(`\n✅ security hardening: ${passed} checks passed`);
