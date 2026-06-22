// Human-readable, monotonic-ish ids. Counters are persisted in the DB so ids
// keep climbing across restarts (see db.mjs nextSeq).

import { randomBytes } from 'node:crypto';

export function objectiveId(n) {
  return `O-${String(n).padStart(2, '0')}`;
}

export function jobId(n) {
  return `J-${String(n).padStart(4, '0')}`;
}

export function leaseToken() {
  return `lease_${randomBytes(9).toString('hex')}`;
}

export function workerId(hint) {
  const slug = (hint || 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

export function eventId() {
  return `ev_${randomBytes(6).toString('hex')}`;
}

export function accountId() {
  return `acct_${randomBytes(8).toString('hex')}`;
}

// API keys are presented to the client once as `${id}.${secret}`. Only the id and a
// sha256 of the secret are stored (see broker auth) — the raw secret never persists.
export function apiKeyId() {
  return `mk_${randomBytes(6).toString('hex')}`;
}

export function apiKeySecret() {
  return randomBytes(24).toString('hex');
}

export function checkpointId() {
  return `ck_${randomBytes(6).toString('hex')}`;
}

export function fuelLedgerId() {
  return `fl_${randomBytes(6).toString('hex')}`;
}
