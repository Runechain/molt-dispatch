// Worker liveness: proves the roster is HEARTBEAT-DERIVED, not a "has-ever-registered" list.
// The grid is pull-based and workers are ephemeral — we never poll them. Instead:
//   1. A registered worker shows online while its heartbeat is fresh.
//   2. Once it stops heartbeating for workerStaleSeconds it drops to offline on the next /workers
//      read — immediately, without waiting for the sweep (listWorkers derives liveness on read).
//   3. The background sweep flips the stored status + emits a `worker_offline` event.
//   4. A returning worker's heartbeat brings it straight back online (rejoin).
//
//   MOLT_WORKER_STALE_SECONDS=1 MOLT_PORT=7103 node scripts/verify_worker_liveness.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read
process.env.MOLT_WORKER_STALE_SECONDS ||= '1'; // age out fast so the test stays quick

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER } from '../src/shared/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(ROOT, 'bin', 'molt.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
const cleanup = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ignore */ } } };

async function waitFor(fn, { tries = 60, gap = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    await sleep(gap);
  }
  return null;
}
const jget = async (p) => (await fetch(`${BROKER.url}${p}`)).json();
const jpost = async (p, body) =>
  (await fetch(`${BROKER.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const findWorker = (ws, id) => ws.find((w) => w.id === id);

let n = 0;
const ok = (l) => { n++; console.log('ok  ' + l); };

try {
  const broker = spawn('node', [bin, 'broker', 'start'], { env: process.env, stdio: 'inherit' });
  children.add(broker);
  if (!(await waitFor(async () => (await fetch(`${BROKER.url}/health`)).ok))) throw new Error('broker did not come up');
  ok('broker up');

  const ID = 'liveness-worker-1';
  await jpost('/workers/register', { worker_id: ID, manifest: { capabilities: ['inference'] } });

  // 1. fresh heartbeat => online
  let w = findWorker(await jget('/workers'), ID);
  assert.ok(w, 'registered worker appears on the roster');
  assert.equal(w.online, true, 'fresh worker is online');
  assert.equal(w.status, 'online', 'fresh worker status is online');
  ok('a freshly-registered worker is online');

  // 2. stop heartbeating past the stale window => derived offline on the next read (no sweep wait)
  await sleep(1500); // > MOLT_WORKER_STALE_SECONDS
  w = findWorker(await jget('/workers'), ID);
  assert.equal(w.online, false, 'stale worker derived offline immediately on /workers read');
  assert.equal(w.status, 'offline', 'stale worker status reads offline');
  ok('a worker that stops heartbeating drops to offline (heartbeat-derived, no polling)');

  // 3. the background sweep emits a worker_offline event into the stream
  const offlineEvt = await waitFor(
    async () => (await jget('/events?limit=50')).find((e) => e.event_type === 'worker_offline' && e.entity_id === ID),
    { tries: 50, gap: 500 } // sweep cadence is leaseSweepSeconds (~15s)
  );
  assert.ok(offlineEvt, 'sweep emitted a worker_offline event');
  ok('the sweep emits worker_offline + flips the stored status');

  // 4. the worker comes back: a heartbeat brings it straight back online (rejoin)
  const hb = await jpost('/workers/heartbeat', { worker_id: ID });
  assert.notEqual(hb.error, 'unknown_worker', 'heartbeat accepted for a known-but-stale worker');
  w = findWorker(await jget('/workers'), ID);
  assert.equal(w.online, true, 'a returning heartbeat brings the worker back online');
  ok('a returning worker rejoins the online roster on its next heartbeat');

  console.log(`\nWorker liveness passed (${n} checks).`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\nFAILED:', err?.message || err);
  cleanup();
  process.exit(1);
}
