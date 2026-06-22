// Fuel ledger: burn-funded USDC budget for paid inference (Bedrock).
// Balances are in USDC-cents (integer: 100 cents = $1.00).
// Real spend is gated behind MOLT_FUEL_REAL=1; with it off everything is accounted
// but no on-chain action occurs. The burn->USDC conversion is human/treasury-operated.

import { getDb, now } from './db.mjs';
import { fuelLedgerId } from '../shared/ids.mjs';

export const PRIMARY_ACCOUNT = 'acct_primary';

// Cost in cents for (provider, model, inputTokens, outputTokens).
// Falls back to wildcard model '*' for the same provider.
export function estimateCost(provider, model, inputTokens = 0, outputTokens = 500) {
  const d = getDb();
  let row = d.prepare('SELECT * FROM cost_model WHERE provider=? AND model=?').get(provider, model);
  if (!row) row = d.prepare("SELECT * FROM cost_model WHERE provider=? AND model='*'").get(provider);
  if (!row) return 0;
  const raw =
    (row.input_cents_per_1k * inputTokens) / 1000 +
    (row.output_cents_per_1k * outputTokens) / 1000 +
    row.flat_cents;
  if (raw === 0) return 0;
  return Math.max(1, Math.ceil(raw)); // paid providers: ceil to at least 1 cent
}

// Estimate cost from a job row using prompt-length as a proxy for input tokens.
export function estimateJobCost(job, provider, model) {
  const inputTokens = Math.ceil(((job.prompt || '').length) / 4);
  return estimateCost(provider, model, inputTokens, 500);
}

export function getBalance(accountId = PRIMARY_ACCOUNT) {
  const row = getDb().prepare('SELECT SUM(amount_cents) AS bal FROM fuel_ledger WHERE account_id=?').get(accountId);
  return row?.bal ?? 0;
}

// Reserve estimated fuel for a claimed paid job (debit pending reserve).
export function reserveFuel(accountId, jobId, amountCents) {
  if (amountCents <= 0) return;
  getDb()
    .prepare(
      'INSERT INTO fuel_ledger(id, account_id, job_id, op, amount_cents, note, created_at) VALUES(?,?,?,?,?,?,?)'
    )
    .run(fuelLedgerId(), accountId, jobId, 'reserve', -amountCents, null, now());
}

// Replace the reserve with the actual charge on job acceptance.
export function chargeFuel(accountId, jobId, actualCents, note = null) {
  const d = getDb();
  d.prepare("DELETE FROM fuel_ledger WHERE account_id=? AND job_id=? AND op='reserve'").run(accountId, jobId);
  if (actualCents > 0) {
    d.prepare(
      'INSERT INTO fuel_ledger(id, account_id, job_id, op, amount_cents, note, created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(fuelLedgerId(), accountId, jobId, 'charge', -actualCents, note, now());
  }
}

// Restore a reservation when a job is dropped or rejected.
export function refundFuel(accountId, jobId) {
  const d = getDb();
  const reserve = d
    .prepare("SELECT * FROM fuel_ledger WHERE account_id=? AND job_id=? AND op='reserve'")
    .get(accountId, jobId);
  if (reserve) {
    d.prepare("DELETE FROM fuel_ledger WHERE account_id=? AND job_id=? AND op='reserve'").run(accountId, jobId);
    return;
  }
  // Defensive: refund a prior charge (shouldn't occur on normal drop/reject path)
  const charge = d
    .prepare("SELECT * FROM fuel_ledger WHERE account_id=? AND job_id=? AND op='charge'")
    .get(accountId, jobId);
  if (charge) {
    d.prepare(
      'INSERT INTO fuel_ledger(id, account_id, job_id, op, amount_cents, note, created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(fuelLedgerId(), accountId, jobId, 'refund', -charge.amount_cents, 'refund of prior charge', now());
  }
}

// Add balance from treasury (burn->USDC credit, human-operated).
export function creditFuel(accountId, amountCents, note = null) {
  getDb()
    .prepare(
      'INSERT INTO fuel_ledger(id, account_id, job_id, op, amount_cents, note, created_at) VALUES(?,?,NULL,?,?,?,?)'
    )
    .run(fuelLedgerId(), accountId, 'credit', amountCents, note, now());
}

// Track a pending contributor payout (actual disbursement is human-operated or Phase 3 hot wallet).
export function recordPayout(accountId, jobId, amountCents, walletAddress) {
  getDb()
    .prepare(
      'INSERT INTO fuel_ledger(id, account_id, job_id, op, amount_cents, note, created_at) VALUES(?,?,?,?,?,?,?)'
    )
    .run(fuelLedgerId(), accountId, jobId, 'payout', -amountCents, walletAddress, now());
}

export function fuelLog(accountId = PRIMARY_ACCOUNT, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM fuel_ledger WHERE account_id=? ORDER BY created_at DESC LIMIT ?')
    .all(accountId, limit);
}
