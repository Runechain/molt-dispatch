// Scheduler: filter feasible workers/jobs (hard constraints), then rank (soft score).
// WHITEPAPER §6. Here we run it job-side: given a claiming worker, pick its best job.

import { getDb } from './db.mjs';
import { DEFAULTS } from '../shared/config.mjs';
import { trustScore } from './reputation.mjs';

const ONLINE_MS = DEFAULTS.heartbeatSeconds * 1000 * 3; // treat a worker offline after 3 missed beats

// Does a worker advertise the AWS Bedrock provider? (the funded continuation backstop)
function workerOffersBedrock(workerId) {
  const row = getDb().prepare('SELECT manifest_json FROM workers WHERE id=?').get(workerId);
  if (!row?.manifest_json) return false;
  try {
    return (JSON.parse(row.manifest_json).models || []).some((m) => m.provider === 'bedrock');
  } catch {
    return false;
  }
}

// Is some OTHER online worker able to take this job? Used to steer a dropped job away from
// the worker that dropped it, without stalling when it's the only option.
function otherCapableWorkerOnline(job, excludeWorkerId) {
  const cutoff = Date.now() - ONLINE_MS;
  const rows = getDb()
    .prepare(`SELECT id, manifest_json FROM workers WHERE id != ? AND status='online' AND last_heartbeat >= ?`)
    .all(excludeWorkerId || '', cutoff);
  return rows.some((w) => {
    try {
      return (JSON.parse(w.manifest_json || '{}').capabilities || []).includes(job.capability_required);
    } catch {
      return false;
    }
  });
}

// A job is claimable when it's pending and every dependency has been ACCEPTED.
export function claimableJobsFor(worker) {
  const d = getDb();
  const caps = new Set(worker.capabilities || []);
  const trust = worker.trust_tier ?? 0;

  const pending = d
    .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY priority ASC, created_at ASC`)
    .all();

  const feasible = [];
  for (const job of pending) {
    // HARD: capability
    if (job.capability_required && !caps.has(job.capability_required)) continue;
    // HARD: trust tier
    if ((job.trust_required ?? 0) > trust) continue;
    // SOFT-as-HARD: don't re-hand a dropped job to the worker that dropped it IF someone
    // else can take it (continuation handoff). If it's the only option, let it through.
    if (job.last_failed_worker_id && job.last_failed_worker_id === worker.id && otherCapableWorkerOnline(job, worker.id)) {
      continue;
    }
    // HARD: all dependencies accepted
    const deps = d
      .prepare(
        `SELECT j.status AS status FROM job_dependencies jd
         JOIN jobs j ON j.id = jd.depends_on_job_id
         WHERE jd.job_id = ?`
      )
      .all(job.id);
    if (deps.some((dep) => dep.status !== 'accepted')) continue;

    feasible.push(job);
  }
  return feasible;
}

// Soft score for ranking which job a worker should take (and, with multiple workers,
// which worker should take a job). Mirrors the §6 weighted blend.
export function scoreJobForWorker(job, worker) {
  const caps = new Set(worker.capabilities || []);
  const capability_match = job.capability_required && caps.has(job.capability_required) ? 1 : 0.5;
  const historical_success = trustScore(worker.id, job.capability_required);
  const availability = worker.max_slots > worker.active_slots ? 1 : 0;
  const specialization = (worker.adapter_hint && worker.adapter_hint === job.adapter_hint) ? 1 : 0.5;
  const priority_boost = 1 - Math.min(job.priority, 1000) / 1000;

  // Continuation: a job that was dropped (has a checkpoint or a prior attempt) is steered to
  // the funded Bedrock backstop. (PLAN: Bedrock picks up where a dropped agent left off.)
  const isContinuation = (job.checkpoint_seq || 0) > 0 || (job.attempts || 0) > 0;
  const continuation_boost = isContinuation && workerOffersBedrock(worker.id) ? 1 : 0;

  return (
    capability_match * 0.3 +
    historical_success * 0.25 +
    availability * 0.15 +
    specialization * 0.1 +
    priority_boost * 0.1 +
    continuation_boost * 0.1
  );
}

// Pick the single best job for a worker, or null.
export function pickJob(worker) {
  const feasible = claimableJobsFor(worker);
  if (feasible.length === 0) return null;
  feasible.sort((a, b) => scoreJobForWorker(b, worker) - scoreJobForWorker(a, worker));
  return feasible[0];
}
