// Integration test for the heterogeneous, fault-tolerant grid (PLAN Phase 1).
// Drives a real in-process broker over HTTP and asserts:
//   1. inference job type runs end-to-end (no repo/worktree/merge)
//   2. checkpoint + resumable handoff (a dropped job resumes from partial state)
//   3. continuation routing avoids re-handing a dropped job to the worker that dropped it
//   4. reputation records lease_expired (dropper) + accepted/resumed_successfully (finisher)
//   5. team-gating: POST endpoints reject without an API key, accept with one
//
// Run with an isolated data dir + port:
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7099 node scripts/verify_grid.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read
import assert from 'node:assert/strict';
import { startBroker, sweepLeases } from '../src/broker/server.mjs';
import { getDb, now } from '../src/broker/db.mjs';
import { createKey } from '../src/broker/keys.mjs';
import { creditFuel, PRIMARY_ACCOUNT } from '../src/broker/fuel.mjs';
import { BROKER } from '../src/shared/config.mjs';

const base = BROKER.url;
let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`ok  ${msg}`);
  pass++;
};

async function post(path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(path) {
  const res = await fetch(`${base}${path}`);
  return res.json();
}

const server = startBroker();
await new Promise((r) => setTimeout(r, 150)); // let it bind

try {
  // Fund the primary account so Bedrock workers can claim (Phase 2: budget gate).
  creditFuel(PRIMARY_ACCOUNT, 500, 'grid-test seed balance');

  // Two heterogeneous workers, both inference-capable. B also advertises a bedrock model,
  // so continuation should prefer B (the funded backstop) and avoid A (the dropper).
  await post('/workers/register', {
    worker_id: 'worker-A',
    owner_id: 'A',
    trust_tier: 4,
    max_slots: 1,
    manifest: { capabilities: ['inference'], models: [{ provider: 'local', model: 'qwen2.5:32b' }] },
  });
  await post('/workers/register', {
    worker_id: 'worker-B',
    owner_id: 'B',
    trust_tier: 4,
    max_slots: 1,
    manifest: { capabilities: ['inference'], models: [{ provider: 'bedrock', model: 'claude-3-haiku' }] },
  });
  ok(true, 'registered two heterogeneous inference workers');

  // 1. Inference objective -> single inference job, pending, no repo.
  const created = await post('/objectives', {
    title: 'test inference',
    prompt: 'Write a haiku about ledgers.',
    contract: { objective_type: 'inference' },
  });
  const jobId = created.body.jobs[0].id;
  ok(created.body.jobs.length === 1, 'inference objective planned exactly one job');
  const jobRow = getDb().prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  ok(jobRow.type === 'inference' && jobRow.capability_required === 'inference', 'job is type/capability inference');
  ok(jobRow.status === 'pending', 'inference job is immediately pending (no dependencies)');

  // 2. Worker A claims, gets no checkpoint (fresh), then posts partial progress.
  const claimA = await post('/jobs/claim', { worker_id: 'worker-A', capabilities: ['inference'], trust_tier: 4, max_slots: 1, active_slots: 0 });
  ok(claimA.body.job?.job_id === jobId, 'worker-A claimed the job');
  ok(claimA.body.job.checkpoint === null, 'fresh claim carries no checkpoint');
  const leaseA = claimA.body.job.lease_token;
  const cp = await post(`/jobs/${jobId}/checkpoint`, { lease_token: leaseA, state: { partial: 'Ledgers in moonlight' } });
  ok(cp.body.ok && cp.body.seq === 1, 'worker-A saved a checkpoint (partial progress)');

  // 3. Simulate A dropping: expire the lease, then sweep.
  getDb().prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(now() - 1000, jobId);
  sweepLeases();
  const afterSweep = getDb().prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  ok(afterSweep.status === 'pending', 'dropped job requeued to pending');
  ok(afterSweep.last_failed_worker_id === 'worker-A', 'broker remembers worker-A dropped it');

  // 4. Continuation routing: A is excluded while B (capable, online) exists.
  const reclaimA = await post('/jobs/claim', { worker_id: 'worker-A', capabilities: ['inference'], trust_tier: 4, max_slots: 1, active_slots: 0 });
  ok(reclaimA.body.job === null || reclaimA.body.job === undefined, 'dropper (worker-A) is not re-handed the job while another worker can take it');

  // 5. Worker B claims and RESUMES from the checkpoint.
  const claimB = await post('/jobs/claim', { worker_id: 'worker-B', capabilities: ['inference'], trust_tier: 4, max_slots: 1, active_slots: 0 });
  ok(claimB.body.job?.job_id === jobId, 'worker-B (backstop) claimed the continuation');
  ok(claimB.body.job.checkpoint?.partial === 'Ledgers in moonlight', 'handoff: worker-B resumes from worker-A partial, not from zero');
  const leaseB = claimB.body.job.lease_token;

  // 6. Worker B completes it.
  const submit = await post(`/jobs/${jobId}/result`, {
    lease_token: leaseB,
    status: 'completed',
    output: 'Ledgers in moonlight / every debt a silver thread / dawn redacts the page',
    provider: 'bedrock',
    model: 'claude-3-haiku',
    confidence: 0.85,
  });
  ok(submit.body.verdict?.pass === true, 'completed inference result passes validation -> accepted');

  // 7. Reputation: A penalized for the drop; B credited for accept + resume.
  const rep = getDb().prepare('SELECT worker_id, event_type, provider FROM reputation_events ORDER BY id').all();
  ok(rep.some((r) => r.worker_id === 'worker-A' && r.event_type === 'lease_expired'), 'reputation: worker-A recorded a lease_expired (drop)');
  ok(rep.some((r) => r.worker_id === 'worker-B' && r.event_type === 'accepted' && r.provider === 'bedrock'), 'reputation: worker-B accepted, tagged provider=bedrock');
  ok(rep.some((r) => r.worker_id === 'worker-B' && r.event_type === 'resumed_successfully'), 'reputation: worker-B credited for a successful resume');

  // 8. The single job's worker is fresh (unproven), so its result is HELD for secondary review
  //    (verify-don't-trust: an unproven worker can't self-approve work to the merge queue).
  const objs = await get('/objectives');
  ok(objs[0].status === 'ready_for_approval', 'objective is ready_for_approval after the single job accepts');
  let approved = await post(`/objectives/${objs[0].id}/approve`);
  ok(approved.status === 409 && approved.body.needs_review, 'a fresh worker\'s result is HELD: approve blocked pending secondary review');
  await post(`/objectives/${objs[0].id}/release`); // secondary review clears the hold
  approved = await post(`/objectives/${objs[0].id}/approve`);
  ok(approved.body.status === 'approved', 'after the hold clears, the repo-less inference objective approves without merge');

  // 9. Auth posture. SAFE DEFAULT (no MOLT_OPEN_GRID): MOLT_AUTH=1 gates every mutating endpoint,
  //    workers included. Opt-in MOLT_OPEN_GRID=1 opens worker endpoints but operator/spend stays gated.
  process.env.MOLT_AUTH = '1';
  const workerGated = await post('/workers/register', { worker_id: 'worker-C', manifest: { capabilities: ['inference'] } });
  ok(workerGated.status === 401, 'auth on (default): worker register requires a key');
  process.env.MOLT_OPEN_GRID = '1';
  const workerOpen = await post('/workers/register', { worker_id: 'worker-C', manifest: { capabilities: ['inference'] } });
  ok(workerOpen.status === 200, 'MOLT_OPEN_GRID=1: worker register opens (no key)');
  const opStillGated = await post('/objectives', { title: 'auth-test' });
  ok(opStillGated.status === 401, 'open grid still gates operator endpoint (POST /objectives)');
  delete process.env.MOLT_OPEN_GRID;
  const k = createKey({ name: 'test' });
  const opWithKey = await post('/objectives', { title: 'auth-test' }, k.key);
  ok(opWithKey.status === 200, 'auth on: operator endpoint accepted with a valid key');
  const opBadKey = await post('/objectives', { title: 'auth-test' }, 'mk_bogus.deadbeef');
  ok(opBadKey.status === 401, 'auth on: a bogus API key is rejected on operator endpoints');
  process.env.MOLT_AUTH = '0';

  console.log(`\nAll grid checks passed (${pass}).`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  server.close();
  process.exit(1);
}
