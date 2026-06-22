// Lifecycle: the broker's mechanical decision engine (WHITEPAPER §12). It never asks
// "do you like this?" — only "did this satisfy the contract?". The only human gate is
// `molt approve` at the very end.

import { getDb, now, logEvent, parseRow } from './db.mjs';
import { validateResult } from './validator.mjs';
import { recordEvent } from './reputation.mjs';

const MAX_ATTEMPTS = 2; // retry-once, then reject (default_on_failure §12)

function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}
function getObjective(id) {
  return parseRow(getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id), ['contract_json']);
}
function setJobStatus(id, status, extra = {}) {
  const d = getDb();
  const sets = ['status = ?', 'updated_at = ?'];
  const vals = [status, now()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  d.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// Called by the broker when a worker submits a result. `ctx` carries the validation
// hooks (static/automated) and contract; in M1 with the mock adapter ctx is minimal.
export async function onResult(jobId, result, ctx = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`unknown job ${jobId}`);
  const objective = getObjective(job.objective_id);
  const fullCtx = { contract: objective?.contract || {}, ...ctx };

  const verdict = await validateResult(job, result, fullCtx);
  logEvent('job', job.id, 'validated', { pass: verdict.pass, layers: verdict.layers, reasons: verdict.reasons });

  if (verdict.pass) {
    acceptJob(job, result);
  } else {
    rejectOrRetry(job, verdict.reasons, result);
  }
  return verdict;
}

function acceptJob(job, result = {}) {
  const meta = { model: result.model, provider: result.provider };
  setJobStatus(job.id, 'accepted');
  recordEvent(job.assigned_worker_id, job.capability_required, 'accepted', job.id, meta);
  // If this job had been dropped before (a checkpoint or prior attempt), the worker that
  // carried it across the line earns a resilience credit (PLAN: reward successful resumes).
  if ((job.checkpoint_seq || 0) > 0 || (job.attempts || 0) > 0) {
    recordEvent(job.assigned_worker_id, job.capability_required, 'resumed_successfully', job.id, meta);
  }
  logEvent('job', job.id, 'accepted', { worker: job.assigned_worker_id, model: result.model, provider: result.provider });
  releaseAssignment(job.id, 'accepted');
  unlockDependents(job.id);
  finalizeObjective(job.objective_id);
}

function rejectOrRetry(job, reasons, result = {}) {
  const attempts = (job.attempts || 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    // retry: put it back in the pool, clear the lease (§12 retry-once).
    setJobStatus(job.id, 'pending', {
      attempts,
      lease_token: null,
      lease_until: null,
      assigned_worker_id: null,
    });
    releaseAssignment(job.id, 'retried');
    logEvent('job', job.id, 'retry', { attempts, reasons });
  } else {
    setJobStatus(job.id, 'rejected', { attempts });
    recordEvent(job.assigned_worker_id, job.capability_required, 'rejected', job.id, { model: result.model, provider: result.provider });
    releaseAssignment(job.id, 'rejected');
    logEvent('job', job.id, 'rejected', { attempts, reasons });
    failObjective(job.objective_id, `job ${job.id} rejected: ${reasons.join('; ')}`);
  }
}

function releaseAssignment(jobId, status) {
  getDb()
    .prepare(
      `UPDATE assignments SET status = ?, finished_at = ? WHERE job_id = ? AND finished_at IS NULL`
    )
    .run(status, now(), jobId);
}

// A blocked job becomes pending once ALL its dependencies are accepted.
function unlockDependents(acceptedJobId) {
  const d = getDb();
  const dependents = d
    .prepare('SELECT job_id FROM job_dependencies WHERE depends_on_job_id = ?')
    .all(acceptedJobId);
  for (const { job_id } of dependents) {
    const deps = d
      .prepare(
        `SELECT j.status AS status FROM job_dependencies jd
         JOIN jobs j ON j.id = jd.depends_on_job_id WHERE jd.job_id = ?`
      )
      .all(job_id);
    const allAccepted = deps.every((x) => x.status === 'accepted');
    const job = getJob(job_id);
    if (allAccepted && job.status === 'blocked') {
      setJobStatus(job_id, 'pending');
      logEvent('job', job_id, 'unblocked', {});
    }
  }
}

function finalizeObjective(objectiveId) {
  const d = getDb();
  const jobs = d.prepare('SELECT status FROM jobs WHERE objective_id = ?').all(objectiveId);
  if (jobs.length === 0) return;
  const allAccepted = jobs.every((j) => j.status === 'accepted');
  if (allAccepted) {
    d.prepare('UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?').run(
      'ready_for_approval',
      now(),
      objectiveId
    );
    logEvent('objective', objectiveId, 'ready_for_approval', {});
  }
}

function failObjective(objectiveId, reason) {
  getDb()
    .prepare('UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?')
    .run('failed', now(), objectiveId);
  logEvent('objective', objectiveId, 'failed', { reason });
}
