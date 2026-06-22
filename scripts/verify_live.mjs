// Live end-to-end: spawn a real broker + a real worker daemon (mock provider), submit an
// inference objective via the API, and confirm the worker claims it, runs the provider, and
// writes a completion artifact. Proves the daemon -> provider -> artifact path (CLI/worker),
// complementing verify_grid.mjs (broker internals).
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7098 node scripts/verify_live.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER, PATHS } from '../src/shared/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(ROOT, 'bin', 'molt.mjs');
const env = { ...process.env };
const children = [];
const spawnMolt = (args) => {
  const c = spawn('node', [bin, ...args], { env, stdio: 'inherit' });
  children.push(c);
  return c;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => children.forEach((c) => { try { c.kill('SIGKILL'); } catch {} });

async function waitFor(fn, { tries = 40, gap = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    await sleep(gap);
  }
  return null;
}

try {
  spawnMolt(['broker', 'start']);
  const up = await waitFor(async () => (await fetch(`${BROKER.url}/health`)).ok);
  if (!up) throw new Error('broker did not come up');
  console.log('ok  broker up');

  const created = await (await fetch(`${BROKER.url}/objectives`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'live test', prompt: 'Summarize the grid in one line.', contract: { objective_type: 'inference' } }),
  })).json();
  const objId = created.objective_id;
  const jobId = created.jobs[0].id;
  console.log(`ok  inference objective ${objId} created (${jobId})`);

  spawnMolt(['worker', 'start', '--adapters', 'mock']);

  const done = await waitFor(async () => {
    const jobs = await (await fetch(`${BROKER.url}/jobs?objective=${objId}`)).json();
    return jobs.every((j) => j.status === 'accepted') ? jobs : null;
  });
  if (!done) throw new Error('job was not accepted in time');
  console.log('ok  worker claimed, ran provider, broker accepted the result');

  const artifact = join(PATHS.artifacts, jobId, 'completion.txt');
  if (!existsSync(artifact)) throw new Error(`no completion artifact at ${artifact}`);
  console.log('ok  completion artifact written:');
  console.log('    ' + readFileSync(artifact, 'utf8').trim());

  console.log('\nLive loop passed.');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  cleanup();
  process.exit(1);
}
