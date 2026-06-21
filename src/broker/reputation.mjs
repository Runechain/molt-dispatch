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
};

export function recordEvent(workerId, capability, eventType, evidenceJobId = null) {
  if (!workerId || !capability) return;
  const delta = WEIGHTS[eventType] ?? 0;
  getDb()
    .prepare(
      `INSERT INTO reputation_events(worker_id, capability, event_type, delta, evidence_job_id, created_at)
       VALUES(?,?,?,?,?,?)`
    )
    .run(workerId, capability, eventType, delta, evidenceJobId, now());
}

// Trust in [0,1] for a (worker, capability). New workers sit at a neutral 0.5 prior
// so the scheduler will try them, then converges toward observed accepted-rate.
export function trustScore(workerId, capability) {
  if (!workerId || !capability) return 0.5;
  const rows = getDb()
    .prepare(
      `SELECT event_type, COUNT(*) AS n FROM reputation_events
       WHERE worker_id = ? AND capability = ? GROUP BY event_type`
    )
    .all(workerId, capability);
  if (rows.length === 0) return 0.5;

  const counts = Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
  const accepted = counts.accepted || 0;
  const bad = (counts.rejected || 0) + (counts.rollback || 0) + (counts.scope_violation || 0) + (counts.security_violation || 0);
  const total = accepted + bad;
  if (total === 0) return 0.5;
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
