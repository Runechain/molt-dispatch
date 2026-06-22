// $0 verification of the deterministic inter-objective dependency floor — fresh temp DB,
// no network, no models. Proves: parsing, the conservative scheduler gate, approve-unlock,
// forward/unresolved refs, cycle-breaking (no deadlock), self-dep + ambiguity guards,
// liveness surfacing, and fail-park.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'moltdeps-'));

const { getDb, now } = await import('../src/broker/db.mjs');
const deps = await import('../src/broker/objective-deps.mjs');
const { claimableJobsFor } = await import('../src/broker/scheduler.mjs');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
};

const d = getDb();
let oseq = 0;
let jseq = 0;
function obj(sourceIssue, status = 'in_progress') {
  const id = `O-${++oseq}`;
  d.prepare(`INSERT INTO objectives(id,title,status,source_issue,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(id, `obj ${id}`, status, sourceIssue, now(), now());
  return id;
}
function job(objectiveId, status = 'pending') {
  const id = `J-${++jseq}`;
  d.prepare(`INSERT INTO jobs(id,objective_id,type,title,capability_required,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, objectiveId, 'code.implementation', `job ${id}`, 'code.implementation', status, now(), now());
  return id;
}
const WORKER = { id: 'W1', capabilities: ['code.implementation'], trust_tier: 0 };
const canClaim = (jobId) => claimableJobsFor(WORKER).some((j) => j.id === jobId);
const setStatus = (id, s) => d.prepare(`UPDATE objectives SET status=? WHERE id=?`).run(s, id);

console.log('parsing "Depends on #N"');
{
  ok(JSON.stringify(deps.parseDependencyIssues('Depends on #103')) === '[103]', 'single "Depends on #103"');
  ok(JSON.stringify(deps.parseDependencyIssues('Blocked by #5, #6')) === '[5,6]', 'comma list "Blocked by #5, #6"');
  ok(JSON.stringify(deps.parseDependencyIssues('depends on #103 and #104')) === '[103,104]', 'inline "and" list');
  ok(deps.parseDependencyIssues('see #9 for context').length === 0, 'stray "#9" without trigger phrase is ignored');
  ok(deps.parseDependencyIssues('').length === 0 && deps.parseDependencyIssues(null).length === 0, 'empty/null safe');
}

console.log('conservative gate + approve-unlock');
{
  const A = obj(103);
  const B = obj(102);
  deps.recordObjectiveDeps(B, 102, deps.parseDependencyIssues('Depends on #103'));
  const r = deps.resolveAndGate();
  ok(r.resolved === 1, 'edge #102->#103 resolved');
  ok(deps.objectiveDepsSatisfied(B) === false, 'B not satisfied while A is in_progress (conservative)');
  ok(d.prepare(`SELECT status FROM objectives WHERE id=?`).get(B).status === 'blocked', 'B objective status flips to blocked');

  const jb = job(B);
  ok(canClaim(jb) === false, "scheduler refuses to hand out B's job while A unsatisfied");

  setStatus(A, 'approved');
  const unblocked = deps.onUpstreamApproved(A);
  ok(unblocked.includes(B), 'approving A unblocks B');
  ok(deps.objectiveDepsSatisfied(B) === true, 'B satisfied once A is approved');
  ok(canClaim(jb) === true, "scheduler now hands out B's job");
  ok(d.prepare(`SELECT status FROM objectives WHERE id=?`).get(B).status === 'in_progress', 'B status restored to in_progress');
}

console.log('forward / unresolved references');
{
  const B2 = obj(202);
  deps.recordObjectiveDeps(B2, 202, [203]); // #203 not imported yet
  deps.resolveAndGate();
  ok(deps.objectiveDepsSatisfied(B2) === false, 'unresolved upstream keeps dependent blocked');
  const live = deps.unsatisfiedDepsFor(B2);
  ok(live.length === 1 && live[0].upstream_status === 'unresolved', 'liveness surfaces "unresolved" upstream');

  const A2 = obj(203); // now it arrives
  const r = deps.resolveAndGate();
  ok(r.resolved === 1, 'late-arriving upstream binds on the next resolve pass');
  ok(deps.objectiveDepsSatisfied(B2) === false, 'still blocked until the now-bound upstream is approved');
  setStatus(A2, 'approved');
  deps.onUpstreamApproved(A2);
  ok(deps.objectiveDepsSatisfied(B2) === true, 'forward-ref dependent unblocks after upstream approval');
}

console.log('cycle is broken, never deadlocked');
{
  const C1 = obj(301);
  const C2 = obj(302);
  deps.recordObjectiveDeps(C1, 301, [302]);
  deps.recordObjectiveDeps(C2, 302, [301]);
  const r = deps.resolveAndGate();
  ok(r.cycles.length >= 1, 'cycle detected and at least one back-edge dropped');
  const cycleEdges = d.prepare(`SELECT COUNT(*) c FROM objective_dependencies WHERE status='cycle' AND objective_id IN (?,?)`).get(C1, C2).c;
  ok(cycleEdges === 1, 'exactly one edge dropped to break the 2-cycle');
  // With one edge dropped, the two objectives cannot BOTH be permanently wedged.
  const blocked = deps.objectivesWithUnsatisfiedDeps();
  ok(!(blocked.has(C1) && blocked.has(C2)), 'cycle does not deadlock both objectives');
}

console.log('guards: self-dep + ambiguous issue');
{
  const S = obj(401);
  const recorded = deps.recordObjectiveDeps(S, 401, [401]); // depends on itself
  ok(recorded === 0, 'self-dependency is dropped at record time');
  ok(d.prepare(`SELECT COUNT(*) c FROM objective_dependencies WHERE objective_id=?`).get(S).c === 0, 'no self-edge persisted');

  obj(500); // two objectives share source_issue 500
  obj(500);
  const X = obj(null);
  deps.recordObjectiveDeps(X, null, [500]);
  const r = deps.resolveAndGate();
  ok(r.resolved >= 1, 'ambiguous issue still binds (to the earliest) without crashing');
}

console.log('permanent upstream failure parks dependents (surfaced, not cascaded)');
{
  const A3 = obj(601);
  const B3 = obj(602);
  deps.recordObjectiveDeps(B3, 602, [601]);
  deps.resolveAndGate();
  setStatus(A3, 'failed');
  const parked = deps.onUpstreamFailed(A3);
  ok(parked.includes(B3), 'failed upstream surfaces dependent for the operator');
  ok(deps.objectiveDepsSatisfied(B3) === false, 'dependent stays parked (re-running A3 can still unblock it)');
  const evt = d.prepare(`SELECT COUNT(*) c FROM events WHERE entity_id=? AND event_type='dependency_failed'`).get(B3).c;
  ok(evt === 1, 'dependency_failed event emitted for liveness');
}

console.log(`\n✅ objective dependency floor: ${passed} checks passed`);
