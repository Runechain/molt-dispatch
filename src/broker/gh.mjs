// GitHub integration via the locally-authenticated `gh` CLI. Like the worker adapters,
// the broker uses the user's local gh login — the token never leaves the machine.

import { run, which } from '../shared/proc.mjs';

function git(repo, args) {
  return run('git', ['-C', repo, ...args]);
}

export async function ghAvailable() {
  return await which('gh');
}

// Parse owner/repo from a repo's origin remote, or null if it isn't a GitHub repo.
export async function githubSlug(repo) {
  const r = await git(repo, ['remote', 'get-url', 'origin']);
  if (r.code !== 0) return null;
  const url = r.stdout.trim();
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo(.git)
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Decide how an objective should be integrated: explicit contract override wins, else
// auto — PR if it's a GitHub repo and gh is available, otherwise a local merge.
export async function chooseIntegration(repo, contract) {
  const forced = contract?.integration;
  if (forced === 'pr' || forced === 'merge') return forced;
  if ((await ghAvailable()) && (await githubSlug(repo))) return 'pr';
  return 'merge';
}

export async function push(repo, branch) {
  return git(repo, ['push', '-u', 'origin', branch, '--force-with-lease']);
}

// Create a PR; returns { url } on success or { error } on failure. gh prints the PR URL.
export async function createPR({ repo, base, head, title, body }) {
  const r = await run('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], { cwd: repo });
  if (r.code !== 0) {
    // If a PR already exists for this head, surface its URL instead of failing.
    const existing = await run('gh', ['pr', 'view', head, '--json', 'url', '-q', '.url'], { cwd: repo });
    if (existing.code === 0 && existing.stdout.trim()) return { url: existing.stdout.trim(), existed: true };
    return { error: r.stderr.trim() || r.stdout.trim() || `gh pr create exit ${r.code}` };
  }
  const url = (r.stdout.match(/https?:\/\/\S+/) || [])[0] || r.stdout.trim();
  return { url };
}

// List issues for a repo (by local path). Optionally filter by label.
export async function listIssues({ repo, label, limit = 30 }) {
  const slug = await githubSlug(repo);
  if (!slug) return { error: 'not a github repo' };
  const args = ['issue', 'list', '--repo', slug, '--state', 'open', '--limit', String(limit), '--json', 'number,title,body,labels'];
  if (label) args.push('--label', label);
  const r = await run('gh', args, { cwd: repo });
  if (r.code !== 0) return { error: r.stderr.trim() || `gh issue list exit ${r.code}` };
  try {
    return { slug, issues: JSON.parse(r.stdout) };
  } catch {
    return { error: 'could not parse gh issue list output' };
  }
}
