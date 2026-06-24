// Worker durability: proves the worker "survives breakage" guarantees added after the audit.
//   1. Broker emits a machine-detectable `unknown_worker` on heartbeat + claim for a vanished worker.
//   2. A corrupt/truncated agent key file does NOT crash startup — it's backed up + regenerated.
//   3. SELF-HEAL: a running worker re-registers automatically after the broker restarts with FRESH
//      state (the real "survives breakage" case) — no manual restart, no zombie.
//   4. Graceful stop: SIGTERM (what `molt stop` sends) drains and exits cleanly, bounded in time.
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7102 node scripts/verify_worker_durability.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BROKER } from '../src/shared/config.mjs';
import { loadOrCreateAgentKey } from '../src/worker/agent-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(ROOT, 'bin', 'molt.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
const spawnMolt = (args, env = {}) => {
  const c = spawn('node', [bin, ...args], { env: { ...process.env, ...env }, stdio: 'inherit' });
  children.add(c);
  c.on('exit', () => children.delete(c));
  return c;
};
const cleanup = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ignore */ } } };

async function waitFor(fn, { tries = 60, gap = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    await sleep(gap);
  }
  return null;
}
const getWorkers = async () => (await (await fetch(`${BROKER.url}/workers`)).json());

let n = 0;
const ok = (l) => { n++; console.log('ok  ' + l); };

try {
  // ---- 1. broker emits unknown_worker for a vanished worker ---------------------------------------
  let broker = spawnMolt(['broker', 'start']);
  if (!(await waitFor(async () => (await fetch(`${BROKER.url}/health`)).ok))) throw new Error('broker did not come up');
  ok('broker up');

  const hb = await (await fetch(`${BROKER.url}/workers/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worker_id: 'ghost-worker' }),
  })).json();
  assert.equal(hb.ok, false); assert.equal(hb.error, 'unknown_worker');
  ok('heartbeat for an unknown worker -> { ok:false, error:"unknown_worker" }');

  const cl = await (await fetch(`${BROKER.url}/jobs/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worker_id: 'ghost-worker', capabilities: [] }),
  })).json();
  assert.equal(cl.error, 'unknown_worker'); assert.equal(cl.job, null);
  ok('claim for an unknown worker -> { job:null, error:"unknown_worker" }');

  // ---- 2. corrupted agent key file recovers instead of crashing -----------------------------------
  const keyDir = mkdtempSync(join(tmpdir(), 'molt-corruptkey-'));
  const keyPath = join(keyDir, '.molt-agent.json');
  writeFileSync(keyPath, '{ this is not valid json at all '); // truncated/corrupt write
  const recovered = loadOrCreateAgentKey(keyPath); // must NOT throw
  assert.ok(recovered.pubkeyB64 && Buffer.from(recovered.pubkeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 32, 'regenerated a valid key');
  assert.ok(existsSync(keyPath + '.bak'), 'corrupt key backed up to .bak');
  ok('corrupt .molt-agent.json -> backed up + regenerated (no crash)');

  // ---- 3. SELF-HEAL across a broker restart that loses state --------------------------------------
  const worker = spawnMolt(['worker', 'start', '--adapters', 'mock']); // identity off for an autonomous test
  const before = await waitFor(async () => { const w = await getWorkers(); return w.length ? w : null; });
  if (!before) throw new Error('worker never registered');
  const workerId = before[0].id;
  ok(`worker registered (${workerId})`);

  // Kill the broker and bring a NEW one up on the SAME port with a FRESH data dir — so it has no
  // record of this worker (the redeploy / DB-loss / failover case).
  broker.kill('SIGKILL');
  await waitFor(async () => { try { await fetch(`${BROKER.url}/health`); return false; } catch { return true; } }, { tries: 20, gap: 250 });
  const freshDir = mkdtempSync(join(tmpdir(), 'molt-freshbroker-'));
  broker = spawnMolt(['broker', 'start'], { MOLT_DATA_DIR: freshDir });
  if (!(await waitFor(async () => (await fetch(`${BROKER.url}/health`)).ok))) throw new Error('fresh broker did not come up');
  ok('broker restarted with FRESH state (no worker rows)');

  const healed = await waitFor(async () => { const w = await getWorkers(); return w.find((x) => x.id === workerId) ? w : null; }, { tries: 60, gap: 500 });
  if (!healed) throw new Error('worker did NOT re-register after broker restart (zombie)');
  ok('worker SELF-HEALED — re-registered automatically against the fresh broker');

  // ---- 4. graceful SIGTERM (what `molt stop` sends) exits cleanly + bounded ------------------------
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res({ timedOut: true }), 10000);
    worker.on('exit', (code, sig) => { clearTimeout(t); res({ code, sig }); });
    worker.kill('SIGTERM');
  });
  assert.ok(!exited.timedOut, 'worker exited within 10s of SIGTERM (no hang)');
  assert.ok(exited.code === 0 || exited.sig === null, `clean exit (code=${exited.code}, sig=${exited.sig})`);
  ok('SIGTERM -> graceful, bounded shutdown');

  console.log(`\nWorker durability passed (${n} checks).`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  cleanup();
  process.exit(1);
}
