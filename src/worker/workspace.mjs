// Workspace isolation via git worktrees (WHITEPAPER §10). Each job gets its own working
// tree so concurrent workers never collide. Implementation jobs create a fresh branch off
// the objective's base; review jobs check out the implementation's branch (detached) so the
// reviewer sees the actual changed code, not just the diff text.

import { join } from 'node:path';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { run } from '../shared/proc.mjs';
import { PATHS } from '../shared/config.mjs';

function git(dirOrRepo, args, opts = {}) {
  return run('git', ['-C', dirOrRepo, ...args], opts);
}

export async function prepareWorktree(job) {
  const repo = job.repo;
  if (!repo) throw new Error(`job ${job.job_id} has no repo`);
  const dir = join(PATHS.worktrees, job.job_id);

  // clear any stale worktree at this path (e.g. from a retried job)
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });

  const reviewBranch = job.review_target?.branch;
  let r;
  if (reviewBranch) {
    r = await git(repo, ['worktree', 'add', '--force', '--detach', dir, reviewBranch]);
  } else {
    await git(repo, ['branch', '-D', job.branch]).catch(() => {}); // drop a leftover branch
    r = await git(repo, ['worktree', 'add', '--force', '-b', job.branch, dir, job.branch_base || 'main']);
  }
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);

  return {
    dir,
    repo,
    branch: job.branch,
    base: job.branch_base || 'main',
    capture: (draft) => capture(job, dir, draft),
    cleanup: () => git(repo, ['worktree', 'remove', '--force', dir]).then(() => {}),
  };
}

// After the adapter runs, persist artifacts and (for impl jobs) commit the change onto the
// grid branch so it survives worktree removal and can be merged on approval.
async function capture(job, dir, draft) {
  const artifacts = [];
  const adir = join(PATHS.artifacts, job.job_id);
  await mkdir(adir, { recursive: true });

  if (job.type === 'code.implementation') {
    await git(dir, ['add', '-A']);
    const nameOnly = await git(dir, ['diff', '--cached', '--name-only']);
    const patch = await git(dir, ['diff', '--cached']);
    const files = nameOnly.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

    const patchPath = join(adir, 'patch.diff');
    await writeFile(patchPath, patch.stdout);
    artifacts.push({ kind: 'patch', path: patchPath });

    draft.changed_files = files;
    if (files.length) {
      await git(dir, ['-c', 'user.email=grid@molt.local', '-c', 'user.name=molt-grid', 'commit', '-m', `grid: ${job.title}`, '--no-verify']);
    }
  }

  if (draft.review) {
    const rp = join(adir, 'review.json');
    await writeFile(rp, JSON.stringify(draft.review, null, 2));
    artifacts.push({ kind: 'review', path: rp });
  }
  if (draft.summary) {
    const sp = join(adir, 'summary.md');
    await writeFile(sp, String(draft.summary));
    artifacts.push({ kind: 'summary', path: sp });
  }
  return artifacts;
}
