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
