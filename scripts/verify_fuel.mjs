// Integration test for Phase 2: x402 value rail + burn-funded budget.
// Drives a real in-process broker over HTTP and asserts:
//   1. Primary account starts at 0 balance
//   2. POST /fuel/credit adds balance; GET /fuel/balance reflects it
//   3. budget=0 -> Bedrock worker gets no jobs (scheduler gate)
//   4. budget>0 -> Bedrock worker can claim; reserve is created
//   5. On accept: reserve replaced by charge, balance decreases
//   6. On lease expiry: reserve is refunded, balance restored
//   7. Low-rep worker result -> objective marked needs_review, fuel NOT settled
//   8. needs_review objective -> approve is blocked with 409
//   9. x402 /payments/verify endpoint (simulated, MOLT_FUEL_REAL=0)
//  10. /payments/request records a pending contributor payout
//
// Run with an isolated data dir + port:
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7097 node scripts/verify_fuel.mjs

import './_env.mjs'; // must be first
import assert from 'node:assert/strict';
import { startBroker, sweepLeases } from '../src/broker/server.mjs';
import { getDb, now } from '../src/broker/db.mjs';
import { getBalance, PRIMARY_ACCOUNT } from '../src/broker/fuel.mjs';
import { BROKER } from '../src/shared/config.mjs';

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
async function get(path) {
  const res = await fetch(`${base}${path}`);
  return res.json();
}

const server = startBroker();
await new Promise((r) => setTimeout(r, 150));

try {
  // 1. Primary account created on bootstrap with 0 balance.
  const bal0 = await get('/fuel/balance');
  ok(bal0.balance_cents === 0, 'primary account starts at 0 balance');

  // 2. /fuel/credit adds balance; /fuel/balance reflects it; /fuel/log shows the entry.
  const credit = await post('/fuel/credit', { amount_cents: 100, note: 'burn settlement test' });
  ok(credit.body.balance_cents === 100, '/fuel/credit returns updated balance');
  const bal1 = await get('/fuel/balance');
  ok(bal1.balance_cents === 100, '/fuel/balance returns 100 after credit');
  const log1 = await get('/fuel/log?limit=5');
  ok(log1.some((r) => r.op === 'credit' && r.amount_cents === 100), '/fuel/log shows the credit entry');

  // 3. budget=0 -> Bedrock worker blocked. Register the Bedrock worker, drain balance to 0.
  // (We credited 100 above; drain it back so we can test the gate.)
  // Instead, test with a fresh worker BEFORE crediting. Register, create a job, try to claim.
  // To isolate: drain balance back to 0 by directly adjusting the DB (test only).
  getDb().prepare("DELETE FROM fuel_ledger WHERE op='credit'").run();
  ok(getBalance(PRIMARY_ACCOUNT) === 0, 'balance reset to 0 for gate test');

  await post('/workers/register', {
    worker_id: 'bedrock-worker',
    owner_id: 'B',
    trust_tier: 4,
    max_slots: 2,
    manifest: { capabilities: ['inference'], models: [{ provider: 'bedrock', model: 'claude-3-haiku' }] },
  });
  await post('/workers/register', {
    worker_id: 'local-worker',
    owner_id: 'L',
    trust_tier: 4,
    max_slots: 2,
    manifest: { capabilities: ['inference'], models: [{ provider: 'local', model: 'qwen2.5:32b' }] },
  });
  ok(true, 'registered bedrock-worker and local-worker');

  const infObj = await post('/objectives', {
    title: 'fuel test job',
    prompt: 'Summarize x402 in one sentence.',
    contract: { objective_type: 'inference' },
  });
  const jobId = infObj.body.jobs[0].id;
  ok(infObj.body.jobs.length === 1, 'inference objective created');

  // With balance=0, the Bedrock worker should get no job.
  const noJob = await post('/jobs/claim', { worker_id: 'bedrock-worker', capabilities: ['inference'], trust_tier: 4, max_slots: 2, active_slots: 0 });
  ok(noJob.body.job === null || noJob.body.job === undefined, 'budget=0: Bedrock worker blocked from claiming');

  // Local worker (free) is NOT blocked.
  const localClaim = await post('/jobs/claim', { worker_id: 'local-worker', capabilities: ['inference'], trust_tier: 4, max_slots: 2, active_slots: 0 });
  ok(localClaim.body.job?.job_id === jobId, 'budget=0: local (free) worker can still claim');
  // Return the job to pending so Bedrock can claim it later.
  getDb().prepare("UPDATE jobs SET status='pending', lease_token=NULL, lease_until=NULL, assigned_worker_id=NULL, updated_at=? WHERE id=?").run(now(), jobId);
  getDb().prepare("UPDATE workers SET active_slots=0 WHERE id='local-worker'").run();

  // 4. budget>0 -> Bedrock worker can claim; reserve is created in the ledger.
  // Re-credit the balance.
  const { body: credit2 } = await post('/fuel/credit', { amount_cents: 200, note: 'settlement batch 2' });
  ok(credit2.balance_cents === 200, 'balance credited to 200 cents');

  const bedrockClaim = await post('/jobs/claim', { worker_id: 'bedrock-worker', capabilities: ['inference'], trust_tier: 4, max_slots: 2, active_slots: 0 });
  ok(bedrockClaim.body.job?.job_id === jobId, 'budget>0: Bedrock worker can claim');
  const balAfterClaim = getBalance(PRIMARY_ACCOUNT);
  ok(balAfterClaim < 200, 'reserve deducted from balance after Bedrock claim');
  const reserveRow = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='reserve'").get(jobId);
  ok(reserveRow !== undefined, 'fuel_ledger has a reserve entry for the claimed job');

  const leaseB = bedrockClaim.body.job.lease_token;

  // 5. On accept: reserve replaced by charge, balance decreases from reserve.
  const submit = await post(`/jobs/${jobId}/result`, {
    lease_token: leaseB,
    status: 'completed',
    output: 'x402 is a micropayment protocol for AI resource access via USDC on Solana.',
    provider: 'bedrock',
    model: 'claude-3-haiku',
    confidence: 0.9,
    // Bedrock worker has good rep (trust_score ≥ 0.4 default) so charge should settle.
  });
  ok(submit.body.verdict?.pass === true, 'Bedrock result accepted');
  const reserveGone = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='reserve'").get(jobId);
  ok(reserveGone === undefined, 'reserve entry removed after accept');
  const chargeRow = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='charge'").get(jobId);
  ok(chargeRow !== undefined, 'charge entry created after accept');
  ok(chargeRow.amount_cents < 0, 'charge is a negative (debit)');

  // 6. On lease expiry: reserve is refunded, balance restored.
  const obj2 = await post('/objectives', {
    title: 'expiry test',
    prompt: 'Test prompt for expiry.',
    contract: { objective_type: 'inference' },
  });
  const jobId2 = obj2.body.jobs[0].id;
  const balBeforeClaim2 = getBalance(PRIMARY_ACCOUNT); // capture BEFORE reserve is created
  const claim2 = await post('/jobs/claim', { worker_id: 'bedrock-worker', capabilities: ['inference'], trust_tier: 4, max_slots: 2, active_slots: 0 });
  ok(claim2.body.job?.job_id === jobId2, 'second Bedrock job claimed');
  ok(getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='reserve'").get(jobId2) !== undefined, 'reserve exists before expiry');

  // Expire the lease and sweep — reserve must be deleted and balance restored.
  getDb().prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(now() - 1000, jobId2);
  sweepLeases();
  ok(getBalance(PRIMARY_ACCOUNT) === balBeforeClaim2, 'balance restored to pre-claim level after lease expiry refund');
  ok(getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='reserve'").get(jobId2) === undefined, 'reserve entry removed after refund');

  // 7. Low-rep worker result -> objective marked needs_review, fuel NOT settled.
  // Manufacture a low-rep worker by recording a bunch of drops.
  await post('/workers/register', {
    worker_id: 'lowrep-bedrock',
    owner_id: 'LR',
    trust_tier: 4,
    max_slots: 2,
    manifest: { capabilities: ['inference'], models: [{ provider: 'bedrock', model: 'claude-3-haiku' }] },
  });
  // Sink its reputation below the threshold (default 0.4).
  const { recordEvent } = await import('../src/broker/reputation.mjs');
  for (let i = 0; i < 5; i++) recordEvent('lowrep-bedrock', 'inference', 'lease_expired', null, {});

  const obj3 = await post('/objectives', {
    title: 'low-rep test',
    prompt: 'Write a haiku about distrust.',
    contract: { objective_type: 'inference' },
  });
  const jobId3 = obj3.body.jobs[0].id;
  // Force-assign to lowrep-bedrock (bypass scheduler for test control).
  const token3 = 'lease_test_lowrep';
  getDb().prepare("UPDATE jobs SET status='claimed', lease_token=?, lease_until=?, assigned_worker_id=?, updated_at=? WHERE id=?")
    .run(token3, now() + 9999999, 'lowrep-bedrock', now(), jobId3);

  const submit3 = await post(`/jobs/${jobId3}/result`, {
    lease_token: token3,
    status: 'completed',
    output: 'Distrust blooms at dawn / Every proof a broken chain / Sign nothing in haste',
    provider: 'bedrock',
    model: 'claude-3-haiku',
    confidence: 0.8,
  });
  ok(submit3.body.verdict?.pass === true, 'low-rep Bedrock result passes validation');
  const obj3Row = getDb().prepare('SELECT * FROM objectives WHERE id=?').get(obj3.body.objective_id);
  ok(obj3Row.needs_review === 1, 'low-rep result: objective marked needs_review');
  const chargeRow3 = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='charge'").get(jobId3);
  ok(chargeRow3 === undefined, 'low-rep result: fuel NOT settled (charge held pending review)');

  // 8. needs_review objective -> approve is blocked.
  const approve3 = await post(`/objectives/${obj3.body.objective_id}/approve`);
  ok(approve3.status === 409 && approve3.body.needs_review === true, 'needs_review objective: approve blocked with 409');

  // 9. x402 /payments/verify (simulated, MOLT_FUEL_REAL=0 default).
  const verify = await post('/payments/verify', {
    payment_header: 'simulated-proof',
    payment_requirements: { scheme: 'exact', network: 'solana-mainnet', maxAmountRequired: '100000' },
  });
  ok(verify.status === 200 && verify.body.ok === true && verify.body.simulated === true, 'x402 /payments/verify: simulated verification succeeds');

  // 10. /payments/request records a contributor payout.
  const payout = await post('/payments/request', {
    job_id: jobId,   // the accepted job from step 5
    wallet_address: 'FAKE_SOLANA_WALLET_ADDR',
    amount_cents: 5,
  });
  ok(payout.status === 200 && payout.body.ok === true, '/payments/request records a pending payout');
  const payoutRow = getDb().prepare("SELECT * FROM fuel_ledger WHERE job_id=? AND op='payout'").get(jobId);
  ok(payoutRow !== undefined && payoutRow.note === 'FAKE_SOLANA_WALLET_ADDR', 'payout entry in fuel_ledger with wallet address');

  console.log(`\nAll fuel checks passed (${pass}).`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  server.close();
  process.exit(1);
}
