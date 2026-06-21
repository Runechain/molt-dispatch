// Broker-side operations that need the filesystem: building validation context from the
// on-disk worktree (static/automated layers) and merging on human approval.
//
// M1: stubs (mock adapter produces no worktree). M3 fills these in.

import { getDb, now, logEvent, parseRow } from './db.mjs';

// Returns the ctx passed to lifecycle.onResult -> validator.validateResult.
// In M3 this attaches staticCheck/automatedCheck closures bound to the job's worktree.
export async function buildResultCtx(job) {
  const objective = parseRow(getDb().prepare('SELECT * FROM objectives WHERE id=?').get(job.objective_id), ['contract_json']);
  const ctx = { contract: objective?.contract || {} };
  // M3: if (job.type === 'code.implementation') ctx.staticCheck = ...; ctx.automatedCheck = ...;
  return ctx;
}

// Human gate (WHITEPAPER §9). M1: mark approved. M3: merge each accepted impl branch
// into the objective's base branch.
export async function approveObjective(objectiveId) {
  const d = getDb();
  const objective = d.prepare('SELECT * FROM objectives WHERE id=?').get(objectiveId);
  if (!objective) return { error: 'unknown objective', code: 404 };
  if (objective.status !== 'ready_for_approval') {
    return { error: `objective is '${objective.status}', not 'ready_for_approval'`, code: 409 };
  }

  // M3 merge happens here.
  d.prepare('UPDATE objectives SET status=?, updated_at=? WHERE id=?').run('approved', now(), objectiveId);
  logEvent('objective', objectiveId, 'approved', {});
  return { ok: true, objective_id: objectiveId, status: 'approved' };
}
