// Broker-side operations that touch the filesystem: building validation context bound to
// the on-disk worktree (the static + automated layers, WHITEPAPER §7), cleaning up
// worktrees, and merging accepted branches on human approval (§9).

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getDb, now, logEvent, parseRow } from './db.mjs';
import { PATHS } from '../shared/config.mjs';
import { run } from '../shared/proc.mjs';

function git(dir, args, opts = {}) {
  return run('git', ['-C', dir, ...args], opts);
}

// Build the ctx handed to lifecycle.onResult -> validator.validateResult.
// For implementation jobs it attaches static + automated checks bound to the worktree.
export async function buildResultCtx(job) {
  const objective = parseRow(getDb().prepare('SELECT * FROM objectives WHERE id=?').get(job.objective_id), ['contract_json']);
  const contract = objective?.contract || {};
  const ctx = { contract };

  if (job.type === 'code.implementation') {
    const worktree = join(PATHS.worktrees, job.id);
    const spec = job.spec_json ? JSON.parse(job.spec_json) : {};

    ctx.staticCheck = async (_job, result) => staticCheck(spec, result);
    ctx.automatedCheck = async () => automatedCheck(worktree, contract);
  }
  return ctx;
}

// L2 static: scope (max files) + protected paths. The patch already applied (codex edited
// the worktree directly), so "does it apply" is implicit; we guard scope and forbidden files.
function staticCheck(spec, result) {
  const changed = result.changed_files || [];
  const problems = [];
  const max = spec.constraints?.max_files_changed;
  if (changed.length === 0) problems.push('no files changed');
  if (max != null && changed.length > max) problems.push(`changed ${changed.length} files > max ${max}`);

  const protectedPaths = spec.constraints?.protected_paths || [];
  for (const f of changed) {
    if (protectedPaths.some((p) => f === p || f.startsWith(p))) problems.push(`touched protected path: ${f}`);
  }
  return { pass: problems.length === 0, notes: problems.join('; ') || `${changed.length} files in scope`, score: { changed_files: changed.length } };
}

// L3 automated: run the contract's acceptance commands in the worktree. All must exit 0.
async function automatedCheck(worktree, contract) {
  const cmds = contract.validation?.automated || [];
  if (cmds.length === 0) return { pass: true, notes: 'no automated checks configured' };
  if (!existsSync(worktree)) return { pass: false, notes: `worktree missing: ${worktree}` };

  const results = [];
  for (const cmd of cmds) {
    const r = await run('sh', ['-c', cmd], { cwd: worktree, timeoutMs: 5 * 60 * 1000 });
    results.push({ cmd, code: r.code, tail: r.stdout.split('\n').slice(-4).join(' ').slice(0, 200) });
    if (r.code !== 0) {
      return { pass: false, notes: `'${cmd}' failed (exit ${r.code})`, score: { results } };
    }
  }
  return { pass: true, notes: `${cmds.length} automated check(s) passed`, score: { results } };
}

// Remove a job's worktree (branch is kept for merge). Called by lifecycle after an impl
// job reaches a terminal state.
export async function removeWorktree(job) {
  const objective = getDb().prepare('SELECT repo FROM objectives WHERE id=?').get(job.objective_id);
  const dir = join(PATHS.worktrees, job.id);
  if (objective?.repo && existsSync(dir)) {
    await git(objective.repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
  }
}

// Human gate (§9): merge each accepted implementation branch into the objective's base.
export async function approveObjective(objectiveId) {
  const d = getDb();
  const objective = d.prepare('SELECT * FROM objectives WHERE id=?').get(objectiveId);
  if (!objective) return { error: 'unknown objective', code: 404 };
  if (objective.status !== 'ready_for_approval') {
    return { error: `objective is '${objective.status}', not 'ready_for_approval'`, code: 409 };
  }

  const repo = objective.repo;
  const base = objective.branch_base || 'main';
  const merged = [];

  if (repo && existsSync(repo)) {
    const implJobs = d
      .prepare(`SELECT * FROM jobs WHERE objective_id=? AND type='code.implementation' AND status='accepted' ORDER BY created_at ASC`)
      .all(objectiveId);

    const co = await git(repo, ['checkout', base]);
    if (co.code !== 0) return { error: `cannot checkout ${base}: ${co.stderr}`, code: 500 };

    for (const job of implJobs) {
      if (!job.branch) continue;
      const m = await git(repo, ['merge', '--no-ff', '-m', `grid: merge ${job.id} (${job.title})`, job.branch]);
      if (m.code !== 0) {
        await git(repo, ['merge', '--abort']).catch(() => {});
        logEvent('objective', objectiveId, 'merge_conflict', { job: job.id });
        return { error: `merge conflict on ${job.branch}; aborted`, code: 409 };
      }
      merged.push({ job: job.id, branch: job.branch });
    }

    // tidy up: remove the now-merged implementation worktrees (branches are kept)
    for (const job of implJobs) await removeWorktree(job).catch(() => {});
  }

  d.prepare('UPDATE objectives SET status=?, updated_at=? WHERE id=?').run('approved', now(), objectiveId);
  logEvent('objective', objectiveId, 'approved', { merged });
  return { ok: true, objective_id: objectiveId, status: 'approved', merged };
}
