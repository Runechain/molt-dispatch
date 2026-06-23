// Broker-side operations that touch the filesystem: building validation context bound to
// the on-disk worktree (the static + automated layers, WHITEPAPER §7), cleaning up
// worktrees, and merging accepted branches on human approval (§9).

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, now, logEvent, parseRow } from './db.mjs';
import { PATHS } from '../shared/config.mjs';
import { run } from '../shared/proc.mjs';
import { chooseIntegration, githubSlug, push, createPR } from './gh.mjs';
import { onUpstreamApproved } from './objective-deps.mjs';
import { integrationConfigured, integrateUpstreamApproved } from './agents/integration-agent.mjs';

// Re-gate objectives waiting on the just-approved one. When the integration agent is configured
// it deliberates release/hold/escalate per dependent; otherwise the deterministic floor releases.
async function reGateDependents(objectiveId) {
  if (integrationConfigured()) return await integrateUpstreamApproved(objectiveId);
  return { upstream: objectiveId, dependents: onUpstreamApproved(objectiveId).map((id) => ({ dependent: id, decision: 'release' })) };
}

function git(dir, args, opts = {}) {
  return run('git', ['-C', dir, ...args], opts);
}

// Minimal, secret-free env for running UNTRUSTED worker-authored content (acceptance
// commands over a worker's worktree). Inherits only what a build/test toolchain needs to
// resolve binaries and locale — never the parent's gh/git/DeepSeek/Bedrock/fuel secrets.
function minimalExecEnv() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C',
  };
}

// Broker ground truth: the files a branch actually changed vs its base, computed by the
// broker over its own repo (never trusting the worker's self-reported changed_files).
// Returns null when it can't be computed (no repo/branch on disk) so callers can fall back.
async function groundTruthChangedFiles(repo, base, branch) {
  if (!repo || !branch || !existsSync(repo)) return null;
  const ref = base || 'main';
  const r = await git(repo, ['diff', '--name-only', `${ref}..${branch}`]);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Enforce scope/protected-paths over an authoritative file list (used both at validation,
// where the list is broker ground truth, and at merge as a final recompute-and-gate).
function scopeViolations(spec, changed) {
  const problems = [];
  const max = spec?.constraints?.max_files_changed;
  if (changed.length === 0) problems.push('no files changed');
  if (max != null && changed.length > max) problems.push(`changed ${changed.length} files > max ${max}`);
  const protectedPaths = spec?.constraints?.protected_paths || [];
  for (const f of changed) {
    if (protectedPaths.some((p) => f === p || f.startsWith(p))) problems.push(`touched protected path: ${f}`);
  }
  return problems;
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
    const repo = objective?.repo;

    const base = job.branch_base || objective?.branch_base;
    ctx.staticCheck = async (_job, result) => staticCheck(spec, result, { repo, base, branch: job.branch });
    ctx.automatedCheck = async () => automatedCheck(worktree, contract);
  }
  return ctx;
}

// L2 static: scope (max files) + protected paths. The patch already applied (codex edited
// the worktree directly), so "does it apply" is implicit; we guard scope and forbidden files.
//
// The file list is BROKER GROUND TRUTH (git diff base..branch over the broker's own repo),
// not the worker-supplied result.changed_files — a worker can't shrink its apparent footprint
// to slip past scope/protected-path gates. result.changed_files is advisory only; when ground
// truth is unavailable (no repo/branch on disk, e.g. a mock job) we fall back to it.
async function staticCheck(spec, result, gt = {}) {
  const truth = await groundTruthChangedFiles(gt.repo, gt.base, gt.branch);
  const source = truth != null ? 'ground-truth' : 'advisory';
  const changed = truth != null ? truth : (result.changed_files || []);
  const problems = scopeViolations(spec, changed);
  return {
    pass: problems.length === 0,
    notes: problems.join('; ') || `${changed.length} files in scope (${source})`,
    score: { changed_files: changed.length, source },
  };
}

// L3 automated: run the contract's acceptance commands in the worktree. All must exit 0.
// Acceptance commands run over UNTRUSTED worker-authored worktree content, so they get a
// MINIMAL secret-free env (PATH/HOME/LANG only) — no parent gh/git/provider/fuel secrets leak
// into a process that runs code the worker controls.
async function automatedCheck(worktree, contract) {
  const cmds = contract.validation?.automated || [];
  if (cmds.length === 0) return { pass: true, notes: 'no automated checks configured' };
  if (!existsSync(worktree)) return { pass: false, notes: `worktree missing: ${worktree}` };

  const results = [];
  for (const cmd of cmds) {
    const r = await run('sh', ['-c', cmd], {
      cwd: worktree,
      timeoutMs: 5 * 60 * 1000,
      replaceEnv: true,
      env: minimalExecEnv(),
    });
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

// Human gate (§9). For a GitHub repo this opens a PR (the merge decision stays with the
// human on GitHub); for a plain local repo it merges into the base branch directly.
export async function approveObjective(objectiveId) {
  const d = getDb();
  const objective = parseRow(d.prepare('SELECT * FROM objectives WHERE id=?').get(objectiveId), ['contract_json']);
  if (!objective) return { error: 'unknown objective', code: 404 };
  if (objective.status !== 'ready_for_approval') {
    return { error: `objective is '${objective.status}', not 'ready_for_approval'`, code: 409 };
  }
  // Block approval when a low-rep worker's result needs a secondary review before fuel settles.
  if (objective.needs_review) {
    return { error: 'objective needs secondary review before approval (low-rep worker result)', code: 409, needs_review: true };
  }

  const repo = objective.repo;
  if (!repo || !existsSync(repo)) {
    d.prepare('UPDATE objectives SET status=?, updated_at=? WHERE id=?').run('approved', now(), objectiveId);
    logEvent('objective', objectiveId, 'approved', { note: 'no repo on disk' });
    const unblocked = await reGateDependents(objectiveId);
    return { ok: true, objective_id: objectiveId, status: 'approved', merged: [], unblocked };
  }

  const implJobs = d
    .prepare(`SELECT * FROM jobs WHERE objective_id=? AND type='code.implementation' AND status='accepted' ORDER BY created_at ASC`)
    .all(objectiveId);

  const mode = await chooseIntegration(repo, objective.contract);
  const result = mode === 'pr'
    ? await integrateViaPR(objective, implJobs)
    : await integrateViaMerge(objective, implJobs);

  if (result.error) return result;

  for (const job of implJobs) await removeWorktree(job).catch(() => {});
  d.prepare('UPDATE objectives SET status=?, pr_url=?, updated_at=? WHERE id=?').run('approved', result.pr_url || null, now(), objectiveId);
  logEvent('objective', objectiveId, 'approved', { mode, ...result });
  // Re-gate any objectives that were waiting on this one.
  const unblocked = await reGateDependents(objectiveId);
  return { ok: true, objective_id: objectiveId, status: 'approved', mode, unblocked, ...result };
}

// Final scope recompute at merge: re-derive the branch's real footprint from broker ground
// truth and re-enforce scope/protected-paths before it lands. Belt-and-suspenders against a
// branch that grew (or was force-pushed) after L2 ran, or where L2 fell back to advisory.
// Returns an error object (to short-circuit the merge) or null when the scope is clean.
async function mergeScopeGate(repo, base, job) {
  const spec = job.spec_json ? JSON.parse(job.spec_json) : {};
  if (!spec.constraints?.max_files_changed && !(spec.constraints?.protected_paths || []).length) return null;
  const truth = await groundTruthChangedFiles(repo, job.branch_base || base, job.branch);
  if (truth == null) return null; // can't recompute — leave the prior L2 verdict to stand
  const problems = scopeViolations(spec, truth);
  if (!problems.length) return null;
  logEvent('objective', job.objective_id, 'merge_scope_violation', { job: job.id, problems });
  return { error: `scope violation on ${job.branch} at merge: ${problems.join('; ')}; aborted`, code: 409 };
}

// Local mode: merge each accepted impl branch straight into the base branch.
async function integrateViaMerge(objective, implJobs) {
  const repo = objective.repo;
  const base = objective.branch_base || 'main';
  const merged = [];
  const co = await git(repo, ['checkout', base]);
  if (co.code !== 0) return { error: `cannot checkout ${base}: ${co.stderr}`, code: 500 };
  for (const job of implJobs) {
    if (!job.branch) continue;
    const scope = await mergeScopeGate(repo, base, job);
    if (scope) return scope;
    const m = await git(repo, ['merge', '--no-ff', '-m', `grid: merge ${job.id} (${job.title})`, job.branch]);
    if (m.code !== 0) {
      await git(repo, ['merge', '--abort']).catch(() => {});
      logEvent('objective', objective.id, 'merge_conflict', { job: job.id });
      return { error: `merge conflict on ${job.branch}; aborted`, code: 409 };
    }
    merged.push({ job: job.id, branch: job.branch });
  }
  return { merged };
}

// GitHub mode: assemble one integration branch, push it, open a PR with the review rubric.
async function integrateViaPR(objective, implJobs) {
  const repo = objective.repo;
  const base = objective.branch_base || 'main';
  const head = `grid/${objective.id}`;

  const co = await git(repo, ['checkout', '-B', head, base]);
  if (co.code !== 0) return { error: `cannot create integration branch from ${base}: ${co.stderr}`, code: 500 };

  const merged = [];
  for (const job of implJobs) {
    if (!job.branch) continue;
    const scope = await mergeScopeGate(repo, base, job);
    if (scope) return scope;
    const m = await git(repo, ['merge', '--no-ff', '-m', `grid: ${job.id} (${job.title})`, job.branch]);
    if (m.code !== 0) {
      await git(repo, ['merge', '--abort']).catch(() => {});
      logEvent('objective', objective.id, 'merge_conflict', { job: job.id });
      return { error: `merge conflict on ${job.branch}; aborted`, code: 409 };
    }
    merged.push({ job: job.id, branch: job.branch });
  }

  const pushed = await push(repo, head);
  if (pushed.code !== 0) return { error: `git push failed: ${pushed.stderr || pushed.stdout}`, code: 500 };

  const pr = await createPR({ repo, base, head, title: `grid: ${objective.title}`, body: buildPrBody(objective, merged) });
  if (pr.error) return { error: `gh pr create failed: ${pr.error}`, code: 500 };

  logEvent('objective', objective.id, 'pr_opened', { url: pr.url, existed: pr.existed });
  return { merged, pr_url: pr.url };
}

// Assemble a PR body from the impl summaries and the review rubric artifacts.
function buildPrBody(objective, merged) {
  const d = getDb();
  const lines = [
    `Opened by the **molt** grid for objective \`${objective.id}\`.`,
    '',
    objective.prompt ? `> ${objective.prompt.replace(/\n/g, '\n> ')}` : '',
    objective.source_issue ? `\nCloses #${objective.source_issue}.` : '',
    '',
    '## Implementation',
  ];
  for (const m of merged) lines.push(`- \`${m.job}\` → \`${m.branch}\``);

  const reviews = d.prepare(`SELECT id FROM jobs WHERE objective_id=? AND type='code.review' AND status='accepted'`).all(objective.id);
  if (reviews.length) {
    lines.push('', '## Review');
    for (const r of reviews) {
      const path = join(PATHS.artifacts, r.id, 'review.json');
      if (!existsSync(path)) continue;
      try {
        const rev = JSON.parse(readFileSync(path, 'utf8'));
        const dims = ['correctness', 'scope_control', 'maintainability', 'security', 'test_coverage', 'confidence'];
        lines.push(`**${rev.recommendation}** — ${rev.summary}`);
        lines.push('', dims.map((k) => `${k} ${rev[k]}/5`).join(' · '));
        for (const o of rev.objections || []) lines.push(`- _(${o.severity})_ ${o.detail}`);
      } catch {
        /* skip unreadable review */
      }
    }
  }
  lines.push('', '---', '🤖 Generated by molt-dispatch (grid), validated by automated tests + AI review.');
  return lines.filter((l) => l !== undefined).join('\n');
}
