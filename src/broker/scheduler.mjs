// Scheduler: filter feasible workers/jobs (hard constraints), then rank (soft score).
// WHITEPAPER §6. Here we run it job-side: given a claiming worker, pick its best job.

import { getDb } from './db.mjs';
import { DEFAULTS } from '../shared/config.mjs';
import { cfg } from './runtime-config.mjs'; // live-tunable knobs (minBalance) honor runtime overrides
import { trustScore } from './reputation.mjs';
import { getBalance, PRIMARY_ACCOUNT } from './fuel.mjs';
import { objectivesWithUnsatisfiedDeps, objectivesOnHold } from './objective-deps.mjs';

// Treat a worker offline once its heartbeat goes stale — the SAME threshold the roster
// (listWorkers) and the readiness probe use, so "online" never means three different things.
const ONLINE_MS = DEFAULTS.workerStaleSeconds * 1000;

// Does a worker advertise the AWS Bedrock provider? (the funded continuation backstop)
export function workerOffersBedrock(workerId) {
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

// The set of workers that authored an implementation a given review job depends on — used to
// keep a reviewer independent of the implementer (verify-don't-trust: a self-graded review is no
// review). Derived from the claim/assignment record, never from worker-self-reported fields.
function reviewImplAuthors(reviewJobId) {
  return getDb()
    .prepare(
      `SELECT DISTINCT j.assigned_worker_id AS w FROM job_dependencies jd
         JOIN jobs j ON j.id = jd.depends_on_job_id
        WHERE jd.job_id = ? AND j.type = 'code.implementation'`
    )
    .all(reviewJobId)
    .map((r) => r.w)
    .filter(Boolean);
}

// Quorum independence: does this worker's OWNER already hold another seat on the same panel?
// A panel is a single deliberate() run distributed across the grid; for the debate to be an
// independent verdict (verify-don't-trust), one operator must not occupy two seats and double-vote
// the panel. Identity is taken from the workers table (worker.id -> owner_id), never from the claim
// body. "Holds a seat" = any seat job on this panel in a non-released state — claimed/running OR a
// finished one (completed/accepted) — assigned to a worker owned by the same owner. This mirrors the
// reviewer-independence precedent (validator.mjs ~105 / scheduler.mjs reviewImplAuthors): a claim is
// refused when the claimant is not independent of the work it would take. We compare on owner_id when
// the worker carries one, and fall back to worker id for owner-less (keyless legacy) workers so the
// rule still bites in the single-account local grid.
function ownerSeatsOnPanel(claimingWorkerId, panelId) {
  const d = getDb();
  // Resolve the claimant's owner (NULL for keyless legacy workers).
  const me = d.prepare('SELECT owner_id FROM workers WHERE id=?').get(claimingWorkerId);
  const myOwner = me?.owner_id || null;
  // Every other seat on this panel that is currently HELD (assigned to some worker) in a
  // claimed/completed/accepted state. 'pending' seats are unclaimed and so held by nobody.
  const heldSeats = d
    .prepare(
      `SELECT j.assigned_worker_id AS w
         FROM jobs j
        WHERE j.panel_id = ?
          AND j.assigned_worker_id IS NOT NULL
          AND j.status IN ('claimed','running','completed','accepted')`
    )
    .all(panelId);
  for (const seat of heldSeats) {
    if (!seat.w) continue;
    if (seat.w === claimingWorkerId) return true; // same worker already on the panel
    if (myOwner) {
      const owner = d.prepare('SELECT owner_id FROM workers WHERE id=?').get(seat.w)?.owner_id || null;
      if (owner && owner === myOwner) return true; // same operator, different node
    }
  }
  return false;
}

// A job is claimable when it's pending and every dependency has been ACCEPTED.
export function claimableJobsFor(worker) {
  const d = getDb();
  const caps = new Set(worker.capabilities || []);

  const pending = d
    .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY priority ASC, created_at ASC`)
    .all();

  // Cross-objective gate, computed once: objectives whose upstream dependency objectives are
  // not yet 'approved' (floor), unioned with objectives the integration agent is holding.
  // Their jobs are never handed out, no matter how ready the job itself is.
  const objBlocked = objectivesWithUnsatisfiedDeps();
  const objHeld = objectivesOnHold();

  const feasible = [];
  for (const job of pending) {
    // HARD: inter-objective dependency — refuse to distribute B's work until A is satisfied
    // AND the integration agent has not held/escalated B's release.
    if (objBlocked.has(job.objective_id) || objHeld.has(job.objective_id)) continue;
    // HARD: capability
    if (job.capability_required && !caps.has(job.capability_required)) continue;
    // HARD: trust — gated on EARNED reputation for the job's capability, never a self-declared tier.
    if ((job.trust_required ?? 0) > trustScore(worker.id, job.capability_required)) continue;
    // HARD: reviewer independence — a worker may not review an implementation it authored.
    if (job.type === 'code.review' && reviewImplAuthors(job.id).includes(worker.id)) continue;
    // HARD: quorum independence — a worker (and its owner) may hold AT MOST ONE seat per panel.
    // Only seat jobs carry a panel_id; for every other job this is a no-op (the column is NULL).
    if (job.panel_id && ownerSeatsOnPanel(worker.id, job.panel_id)) continue;
    // SOFT-as-HARD: don't re-hand a dropped job to the worker that dropped it IF someone
    // else can take it (continuation handoff). If it's the only option, let it through.
    if (job.last_failed_worker_id && job.last_failed_worker_id === worker.id && otherCapableWorkerOnline(job, worker.id)) {
      continue;
    }
    // HARD: if the claiming worker uses Bedrock (a paid provider), the team account must have
    // sufficient balance. budget=0 => only free/local agents run. (PLAN Phase 2: burn->fuel.)
    if (workerOffersBedrock(worker.id) && getBalance(PRIMARY_ACCOUNT) < cfg('minBalance')) {
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
