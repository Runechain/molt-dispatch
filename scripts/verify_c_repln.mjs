// Verify chunk c-repln (reputation + lifecycle + dashboard hardening), security audit.
//
// Proves:
//   A. reputation.trustScore() UNPROVEN prior sits BELOW FUEL.repThreshold (0.4) so a
//      fresh id can't clear the fuel/secondary-review gate or out-rank workers with history.
//   B. Laplace smoothing still applies once a worker has history (an all-accepted worker
//      scores well above the threshold; an all-bad worker scores below it).
//   C. lifecycle.acceptJob() routes ANY low-trust result through needs_review regardless of
//      result.provider (the worker-controlled field) — incl. a NON-bedrock provider.
//   D. A trusted worker's non-bedrock result is NOT held (no false-positive review).
//   E. The bedrock fuel-charge path still settles for a trusted worker (no regression).
//   F. dashboard/app.js escapes worker/job/event fields (static source assertions).
//
// Run with an isolated data dir + port:
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7103 node scripts/verify_c_repln.mjs

import './_env.mjs'; // must be first
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startBroker } from '../src/broker/server.mjs';
import { getDb, now } from '../src/broker/db.mjs';
import { trustScore, recordEvent, UNPROVEN_PRIOR } from '../src/broker/reputation.mjs';
import { getBalance, PRIMARY_ACCOUNT } from '../src/broker/fuel.mjs';
import { FUEL, BROKER } from '../src/shared/config.mjs';

const base = BROKER.url;
let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`ok  ${msg}`);
  pass++;
};
async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const server = startBroker();
await new Promise((r) => setTimeout(r, 150));

try {
  // ---- A. UNPROVEN prior is below the fuel/secondary-review gate. ----
  ok(UNPROVEN_PRIOR < FUEL.repThreshold, `UNPROVEN_PRIOR (${UNPROVEN_PRIOR}) < FUEL.repThreshold (${FUEL.repThreshold})`);
  ok(UNPROVEN_PRIOR < 0.5, 'UNPROVEN_PRIOR is below the old neutral 0.5 prior');
  ok(trustScore('fresh-id', 'inference') === UNPROVEN_PRIOR, 'zero-history worker returns the unproven prior');
  ok(trustScore('fresh-id', 'inference') < FUEL.repThreshold, 'fresh id cannot clear the fuel threshold');

  // ---- B. Laplace smoothing still rewards real history; bad history stays sub-threshold. ----
  for (let i = 0; i < 8; i++) recordEvent('good-worker', 'inference', 'accepted', null, {});
  const goodTrust = trustScore('good-worker', 'inference');
  ok(goodTrust > FUEL.repThreshold, `all-accepted worker rises above threshold (${goodTrust.toFixed(3)})`);
  ok(goodTrust > UNPROVEN_PRIOR, 'history out-ranks an unproven id');
  // Laplace check: 8 accepted / (8 bad+acc + 2) -> (8+1)/(8+2)=0.9
  ok(Math.abs(goodTrust - 0.9) < 1e-9, 'Laplace-smoothed accepted ratio is exactly (acc+1)/(total+2)');

  for (let i = 0; i < 5; i++) recordEvent('bad-worker', 'inference', 'rejected', null, {});
  const badTrust = trustScore('bad-worker', 'inference');
  ok(badTrust < FUEL.repThreshold, `all-rejected worker stays below threshold (${badTrust.toFixed(3)})`);

  // ---- C. Low-trust NON-bedrock result is held for review regardless of provider. ----
  // This is the core of audit item #2: the hold must NOT be skippable by declaring a
  // non-bedrock provider. Manufacture a worker whose EARNED trust is below the threshold
  // (accumulated drops) so it stays sub-threshold even after the +1 accept on this job.
  await post('/workers/register', {
    worker_id: 'lowrep-local',
    owner_id: 'LRL',
    max_slots: 2,
    manifest: { capabilities: ['inference'], models: [{ provider: 'local', model: 'qwen2.5:32b' }] },
  });
  for (let i = 0; i < 6; i++) recordEvent('lowrep-local', 'inference', 'lease_expired', null, {});
  ok(trustScore('lowrep-local', 'inference') < FUEL.repThreshold, 'lowrep-local earned trust is below threshold');
  const objC = await post('/objectives', {
    title: 'low-trust non-bedrock',
    prompt: 'Summarize the audit in one line.',
    contract: { objective_type: 'inference' },
  });
  const jobC = objC.body.jobs[0].id;
  const tokenC = 'lease_c';
  getDb().prepare("UPDATE jobs SET status='claimed', lease_token=?, lease_until=?, assigned_worker_id=?, updated_at=? WHERE id=?")
    .run(tokenC, now() + 9999999, 'lowrep-local', now(), jobC);
  const subC = await post(`/jobs/${jobC}/result`, {
    lease_token: tokenC,
    status: 'completed',
    output: 'The audit hardens the broker against sybil and provider-spoofed review skips.',
    provider: 'local', // worker-controlled: NOT bedrock — must NOT let it skip the hold
    model: 'qwen2.5:32b',
    confidence: 0.9,
  });
  ok(subC.body.verdict?.pass === true, 'low-trust non-bedrock result passes validation');
  const objCRow = getDb().prepare('SELECT * FROM objectives WHERE id=?').get(objC.body.objective_id);
  ok(objCRow.needs_review === 1, 'low-trust NON-bedrock result is routed through needs_review (provider cannot skip the hold)');
  const chargeC = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='charge'").get(jobC);
  ok(chargeC === undefined, 'non-bedrock result settles no fuel (free provider)');

  // ---- D. Trusted worker non-bedrock result is NOT held (no false positive). ----
  await post('/workers/register', {
    worker_id: 'trusted-local',
    owner_id: 'TL',
    max_slots: 2,
    manifest: { capabilities: ['inference'], models: [{ provider: 'local', model: 'qwen2.5:32b' }] },
  });
  for (let i = 0; i < 10; i++) recordEvent('trusted-local', 'inference', 'accepted', null, {});
  ok(trustScore('trusted-local', 'inference') >= FUEL.repThreshold, 'trusted-local is above threshold');
  const objD = await post('/objectives', {
    title: 'trusted non-bedrock',
    prompt: 'One-line summary please.',
    contract: { objective_type: 'inference' },
  });
  const jobD = objD.body.jobs[0].id;
  const tokenD = 'lease_d';
  getDb().prepare("UPDATE jobs SET status='claimed', lease_token=?, lease_until=?, assigned_worker_id=?, updated_at=? WHERE id=?")
    .run(tokenD, now() + 9999999, 'trusted-local', now(), jobD);
  const subD = await post(`/jobs/${jobD}/result`, {
    lease_token: tokenD,
    status: 'completed',
    output: 'A concise one-line summary of the requested content goes here for the test.',
    provider: 'local',
    model: 'qwen2.5:32b',
    confidence: 0.95,
  });
  ok(subD.body.verdict?.pass === true, 'trusted non-bedrock result passes validation');
  const objDRow = getDb().prepare('SELECT * FROM objectives WHERE id=?').get(objD.body.objective_id);
  ok(objDRow.needs_review !== 1, 'trusted non-bedrock result is NOT held for review (no false positive)');

  // ---- E. Trusted worker bedrock result still settles fuel (no regression). ----
  await post('/fuel/credit', { amount_cents: 500, note: 'c-repln settle test' });
  await post('/workers/register', {
    worker_id: 'trusted-bedrock',
    owner_id: 'TB',
    max_slots: 2,
    manifest: { capabilities: ['inference'], models: [{ provider: 'bedrock', model: 'claude-3-haiku' }] },
  });
  for (let i = 0; i < 10; i++) recordEvent('trusted-bedrock', 'inference', 'accepted', null, {});
  const objE = await post('/objectives', {
    title: 'trusted bedrock settle',
    prompt: 'Summarize x402 briefly.',
    contract: { objective_type: 'inference' },
  });
  const jobE = objE.body.jobs[0].id;
  const tokenE = 'lease_e';
  getDb().prepare("UPDATE jobs SET status='claimed', lease_token=?, lease_until=?, assigned_worker_id=?, updated_at=? WHERE id=?")
    .run(tokenE, now() + 9999999, 'trusted-bedrock', now(), jobE);
  const balBefore = getBalance(PRIMARY_ACCOUNT);
  const subE = await post(`/jobs/${jobE}/result`, {
    lease_token: tokenE,
    status: 'completed',
    output: 'x402 is a micropayment protocol for AI resource access via USDC.',
    provider: 'bedrock',
    model: 'claude-3-haiku',
    confidence: 0.92,
  });
  ok(subE.body.verdict?.pass === true, 'trusted bedrock result passes validation');
  const objERow = getDb().prepare('SELECT * FROM objectives WHERE id=?').get(objE.body.objective_id);
  ok(objERow.needs_review !== 1, 'trusted bedrock result is NOT held for review');
  const chargeE = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='charge'").get(jobE);
  ok(chargeE !== undefined && chargeE.amount_cents < 0, 'trusted bedrock result settles a fuel charge (debit)');
  ok(getBalance(PRIMARY_ACCOUNT) < balBefore, 'balance decreased after bedrock charge settled');

  // ---- F. dashboard/app.js escapes worker/job/event fields (static source check). ----
  const appPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'app.js');
  const src = readFileSync(appPath, 'utf8');
  ok(/escapeHtml\(w\.id\)/.test(src), 'dashboard escapes w.id');
  ok(/escapeHtml\(w\.active_slots\)/.test(src) && /escapeHtml\(w\.max_slots\)/.test(src), 'dashboard escapes w.active_slots / w.max_slots');
  ok(/escapeHtml\(w\.trust_tier\)/.test(src), 'dashboard escapes w.trust_tier');
  ok(/escapeHtml\(r\.capability\)/.test(src), 'dashboard escapes reputation capability');
  ok(/escapeHtml\(j\.id\)/.test(src), 'dashboard escapes j.id');
  ok(/escapeHtml\(e\.event_type\)/.test(src) && /escapeHtml\(e\.entity_id\)/.test(src), 'dashboard escapes event fields');
  // badge() must escape its status before interpolation.
  ok(/function badge[\s\S]{0,160}escapeHtml/.test(src), 'badge() escapes the status value');
  // No remaining raw `${w.id}` / `${j.id}` / `${e.entity_id}` interpolations.
  ok(!/\$\{w\.id\}/.test(src) && !/\$\{j\.id\}/.test(src) && !/\$\{e\.entity_id\}/.test(src), 'no raw unescaped id interpolations remain');

  console.log(`\nAll c-repln checks passed (${pass}).`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  server.close();
  process.exit(1);
}
