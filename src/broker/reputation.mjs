// Per-capability reputation (WHITEPAPER §8). Every worker starts untrusted; trust is
// earned per capability from accepted/rejected/rollback/scope-violation events.

import { getDb, now } from './db.mjs';

const WEIGHTS = {
  accepted: +1,
  rejected: -1,
  rollback: -2,
  scope_violation: -2,
  security_violation: -3,
  on_time: +0.25,
  // Resilience signals (PLAN: a swarm of breaking pieces; serial droppers fall out of rotation).
  dropped: -1,
  lease_expired: -0.75,
  resumed_successfully: +0.5,
};

// Negative reliability events that count against trust (alongside rejected/rollback/etc).
const BAD_EVENTS = new Set(['rejected', 'rollback', 'scope_violation', 'security_violation', 'dropped', 'lease_expired']);

// meta carries { model, provider } so reputation is scored per (worker, capability, model/provider).
export function recordEvent(workerId, capability, eventType, evidenceJobId = null, meta = {}) {
  if (!workerId || !capability) return;
  const delta = WEIGHTS[eventType] ?? 0;
  getDb()
    .prepare(
      `INSERT INTO reputation_events(worker_id, capability, event_type, delta, evidence_job_id, model, provider, created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    )
    .run(workerId, capability, eventType, delta, evidenceJobId, meta.model || null, meta.provider || null, now());
}

// Sybil-resistant UNPROVEN prior (security audit): a fresh id with zero history must sit
// BELOW the fuel/secondary-review gate (FUEL.repThreshold=0.4) so it can't clear the
// low-rep verify gate or out-rank an established worker just by registering. Workers with
// real history are scored by their Laplace-smoothed accepted-rate, which can rise above it.
export const UNPROVEN_PRIOR = 0.3;

// Trust in [0,1] for a (worker, capability). New (unproven) workers sit below the fuel
// threshold; the scheduler will still try them (it gates on job.trust_required, which is 0
// by default), then trust converges toward the observed accepted-rate as history accrues.
export function trustScore(workerId, capability) {
  if (!workerId || !capability) return UNPROVEN_PRIOR;
  const rows = getDb()
    .prepare(
      `SELECT event_type, COUNT(*) AS n FROM reputation_events
       WHERE worker_id = ? AND capability = ? GROUP BY event_type`
    )
    .all(workerId, capability);
  if (rows.length === 0) return UNPROVEN_PRIOR;

  const counts = Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
  const accepted = counts.accepted || 0;
  let bad = 0;
  for (const ev of BAD_EVENTS) bad += counts[ev] || 0;
  const total = accepted + bad;
  if (total === 0) return UNPROVEN_PRIOR;
  // Laplace-smoothed accepted ratio.
  return (accepted + 1) / (total + 2);
}

export function reputationFor(workerId) {
  const rows = getDb()
    .prepare(
      `SELECT capability,
              SUM(CASE WHEN event_type='accepted' THEN 1 ELSE 0 END) AS accepted,
              COUNT(*) AS events
       FROM reputation_events WHERE worker_id = ? GROUP BY capability`
    )
    .all(workerId);
  return rows.map((r) => ({
    capability: r.capability,
    accepted: r.accepted,
    events: r.events,
    trust_score: Number(trustScore(workerId, r.capability).toFixed(2)),
  }));
}
