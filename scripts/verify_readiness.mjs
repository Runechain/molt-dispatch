// Readiness probe: proves /readiness answers "can the grid DISTRIBUTE the work it holds?", not just
// "is the broker alive?". The signal we care about is STARVATION — pending, dependency-ready jobs
// whose capability no ONLINE worker advertises — which from the outside looks like an empty queue.
//   1. pending work + no capable online worker  => starved / not ready (+ capability_gap)
//   2. an idle capable worker joins             => draining / ready (claimable_now)
//   3. the capable worker is busy, more work     => saturated / ready (capacity pressure, not starved)
//   4. the worker's heartbeat goes stale         => starved / not ready again (liveness drives readiness)
//   5. on a gated broker, anonymous gets only the coarse verdict (no backlog/capability detail)
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7104 node scripts/verify_readiness.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read
import assert from 'node:assert/strict';
import { startBroker } from '../src/broker/server.mjs';
import { getDb, now } from '../src/broker/db.mjs';
import { BROKER, DEFAULTS } from '../src/shared/config.mjs';

const base = BROKER.url;
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`ok  ${msg}`); pass++; };

async function post(path, body) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json().catch(() => ({}));
}
const readiness = async () => (await fetch(`${base}/readiness`)).json();
const gapFor = (r, cap) => (r.capability_gaps || []).find((g) => g.capability === cap);

const server = startBroker();
await new Promise((r) => setTimeout(r, 150)); // let it bind

try {
  // A pending inference job with NO worker online -> the grid is holding work it cannot distribute.
  const obj1 = await post('/objectives', { title: 'r1', prompt: 'Write a haiku.', contract: { objective_type: 'inference' } });
  assert.equal(obj1.jobs.length, 1, 'inference objective created one job');
  let r = await readiness();
  ok(r.ready === false && r.status === 'starved', 'pending work + zero workers => NOT ready (starved)');
  ok(r.jobs.starved === 1 && r.jobs.pending_total === 1, 'the starved job is counted');
  ok(gapFor(r, 'inference')?.pending === 1, 'capability_gap names inference as the unmet capability');

  // An idle, inference-capable worker joins -> the work becomes claimable.
  await post('/workers/register', { worker_id: 'w-inf', owner_id: 'op', max_slots: 1, manifest: { capabilities: ['inference'] } });
  r = await readiness();
  ok(r.ready === true && r.status === 'draining', 'an idle capable worker => ready (draining)');
  ok(r.jobs.claimable_now === 1 && r.jobs.starved === 0, 'the job is now claimable, nothing starved');
  ok(r.workers.online === 1 && r.workers.idle === 1, 'roster shows one idle online worker');
  ok(!gapFor(r, 'inference'), 'no capability gap once a capable worker is online');

  // The worker claims that job (now busy, 0 free slots); a SECOND inference objective arrives.
  const claim = await post('/jobs/claim', { worker_id: 'w-inf' });
  ok(claim.job && claim.job.objective_id === obj1.objective_id, 'worker claimed the first job (now busy)');
  await post('/objectives', { title: 'r2', prompt: 'Write another haiku.', contract: { objective_type: 'inference' } });
  r = await readiness();
  ok(r.ready === true && r.status === 'saturated', 'capable-but-busy + new work => ready (saturated, not starved)');
  ok(r.jobs.saturated === 1 && r.jobs.starved === 0, 'the new job waits on CAPACITY, not capability');
  ok(r.workers.busy === 1 && r.workers.idle === 0, 'roster shows the worker busy');

  // The worker's heartbeat goes stale (it left without notice) -> the pending job is starved again.
  getDb().prepare('UPDATE workers SET last_heartbeat=? WHERE id=?').run(now() - (DEFAULTS.workerStaleSeconds + 5) * 1000, 'w-inf');
  r = await readiness();
  ok(r.ready === false && r.status === 'starved', 'a stale (vanished) worker => NOT ready again — liveness drives readiness');
  ok(r.workers.online === 0, 'the stale worker is off the online roster');
  ok(gapFor(r, 'inference')?.pending >= 1, 'capability_gap reappears for the abandoned pending work');

  // On a gated broker an anonymous caller gets ONLY the coarse verdict — no backlog/capability leak.
  process.env.MOLT_AUTH = '1';
  const coarse = await readiness();
  process.env.MOLT_AUTH = '';
  ok(coarse.status === 'starved' && coarse.ready === false, 'anonymous coarse view still carries the verdict');
  ok(coarse.jobs === undefined && coarse.workers === undefined && coarse.capability_gaps === undefined, 'coarse view withholds backlog + capability detail');

  console.log(`\nReadiness probe passed (${pass} checks).`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nFAILED:', err?.message || err);
  try { server.close(); } catch { /* ignore */ }
  process.exit(1);
}
