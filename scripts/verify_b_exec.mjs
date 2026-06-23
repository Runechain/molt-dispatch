// $0 verification of the b-exec EXEC/GROUND-TRUTH hardening (security audit, tasks #21/#23).
// Fresh temp DB + a real throwaway git repo. Proves:
//   1. proc.run({ replaceEnv }) gives an untrusted child EXACTLY the env passed — no parent
//      secrets (DeepSeek/Bedrock/gh/git/fuel) leak. Default (inherit) still works for git/gh.
//   2. L2 static scope is computed from BROKER GROUND TRUTH (git diff base..branch), so a
//      worker that under-reports result.changed_files cannot slip past scope/protected gates.
//   3. L3 automated commands run with a MINIMAL secret-free env (PATH/HOME/LANG only).
//   4. validator FAILS CLOSED for code.implementation when no static/automated check could run;
//      inference/non-code jobs are unaffected.
//
// Run isolated:
//   MOLT_DATA_DIR=$(mktemp -d) node scripts/verify_b_exec.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.MOLT_DATA_DIR) process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'moltbexec-'));

const { run } = await import('../src/shared/proc.mjs');
const { getDb, now } = await import('../src/broker/db.mjs');
const { buildResultCtx } = await import('../src/broker/broker-ops.mjs');
const { validateResult } = await import('../src/broker/validator.mjs');
const { PATHS } = await import('../src/shared/config.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

// ---- helpers ----------------------------------------------------------------
const git = (dir, args, opts) => run('git', ['-C', dir, ...args], opts);
async function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t']);
  await git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
}
async function branchWithFiles(repo, branch, files) {
  await git(repo, ['checkout', '-q', '-B', branch, 'main']);
  for (const f of files) {
    const p = join(repo, f);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, `change ${f}\n`);
  }
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', `change ${branch}`]);
  await git(repo, ['checkout', '-q', 'main']);
}

const d = getDb();
let seq = 0;
function objective({ repo = null, contract = {} } = {}) {
  const id = `O-${++seq}`;
  d.prepare(`INSERT INTO objectives(id,title,repo,branch_base,contract_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, id, repo, 'main', JSON.stringify(contract), 'in_progress', now(), now());
  return id;
}
function implJob(objId, { branch = null, spec = {} } = {}) {
  const id = `J-${++seq}`;
  d.prepare(`INSERT INTO jobs(id,objective_id,type,title,capability_required,status,branch,spec_json,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, objId, 'code.implementation', id, 'code.implementation', 'completed', branch, JSON.stringify(spec), now(), now());
  return d.prepare('SELECT * FROM jobs WHERE id=?').get(id);
}
const completed = (extra = {}) => ({ lease_token: 't', status: 'completed', summary: 's', ...extra });

// =============================================================================
console.log('1 — proc.run env isolation (secret-free child for untrusted exec)');
{
  process.env.MOLT_SECRET_PROBE = 'topsecret-deepseek-key';

  // Default: inherits parent env (git/gh callers rely on this).
  const inherit = await run('sh', ['-c', 'echo "$MOLT_SECRET_PROBE"']);
  ok(inherit.stdout.trim() === 'topsecret-deepseek-key', 'default run() inherits parent env (git/gh creds keep working)');

  // replaceEnv: child sees EXACTLY the supplied env — secret is gone.
  const isolated = await run('sh', ['-c', 'echo "[$MOLT_SECRET_PROBE]"'], {
    replaceEnv: true,
    env: { PATH: process.env.PATH },
  });
  ok(isolated.stdout.trim() === '[]', 'replaceEnv:true drops parent secrets from the child env');

  // replaceEnv only carries what we pass (+ envExtra).
  const explicit = await run('sh', ['-c', 'echo "$FOO-$BAR"'], {
    replaceEnv: true,
    env: { PATH: process.env.PATH, FOO: 'a' },
    envExtra: { BAR: 'b' },
  });
  ok(explicit.stdout.trim() === 'a-b', 'replaceEnv carries exactly env + envExtra');
  delete process.env.MOLT_SECRET_PROBE;
}

// =============================================================================
console.log('2 — L2 static scope uses BROKER GROUND TRUTH, not worker-reported changed_files');
{
  const repo = mkdtempSync(join(tmpdir(), 'moltrepo-'));
  await initRepo(repo);
  // Branch genuinely touches THREE files across two dirs (one protected).
  await branchWithFiles(repo, 'grid/J-scope', ['a.js', 'b.js', 'src/secret/keys.mjs']);

  const o = objective({ repo, contract: {} });
  const job = implJob(o, {
    branch: 'grid/J-scope',
    spec: { constraints: { max_files_changed: 2, protected_paths: ['src/secret/'] } },
  });
  const ctx = await buildResultCtx(job);

  // Worker LIES: claims it only touched one innocuous file.
  const v = await validateResult(job, completed({ changed_files: ['a.js'] }), ctx);
  ok(v.pass === false, 'a worker that under-reports changed_files is still REJECTED');
  ok(v.reasons.some((r) => /> max 2/.test(r)), 'ground truth (3 files) caught the over-scope despite the lie');
  ok(v.reasons.some((r) => /protected path: src\/secret\/keys\.mjs/.test(r)), 'ground truth caught the protected-path touch the worker hid');

  // A clean, in-scope branch passes — ground truth confirms the small footprint.
  await branchWithFiles(repo, 'grid/J-clean', ['a.js']);
  const o2 = objective({ repo, contract: {} });
  const job2 = implJob(o2, { branch: 'grid/J-clean', spec: { constraints: { max_files_changed: 2, protected_paths: ['src/secret/'] } } });
  const ctx2 = await buildResultCtx(job2);
  // Worker over-reports here; ground truth (1 file) still wins and passes.
  const v2 = await validateResult(job2, completed({ changed_files: ['a.js', 'b.js', 'c.js'] }), ctx2);
  ok(v2.pass === true, 'an in-scope branch passes; ground truth (1 file) overrides the over-reported list');
  const staticLayer = d.prepare(`SELECT score_json FROM validations WHERE job_id=? AND validator_type='static' ORDER BY id DESC`).get(job2.id);
  ok(/"source":"ground-truth"/.test(staticLayer.score_json), 'static layer recorded source=ground-truth');
}

// =============================================================================
console.log('3 — L3 automated commands run with a minimal, secret-free env');
{
  process.env.MOLT_SECRET_PROBE = 'leak-me';
  const repo = mkdtempSync(join(tmpdir(), 'moltrepo3-'));
  await initRepo(repo);
  await branchWithFiles(repo, 'grid/J-l3', ['a.js']);

  // The worktree the automated check runs in.
  const worktreeDir = join(PATHS.worktrees, 'J-wt');
  await git(repo, ['worktree', 'add', '-q', '--force', worktreeDir, 'grid/J-l3']);

  // Acceptance command writes whatever it can see of the secret to a file.
  const out = join(worktreeDir, 'leak.txt');
  const contract = { validation: { automated: [`printf '[%s]' "$MOLT_SECRET_PROBE" > "${out}"`] } };
  const o = objective({ repo, contract });
  // Point the job's worktree-id at our prepared worktree dir name.
  const job = implJob(o, { branch: 'grid/J-l3', spec: {} });
  // buildResultCtx derives the worktree from PATHS.worktrees/<job.id>; create that path.
  const jobWt = join(PATHS.worktrees, job.id);
  await git(repo, ['worktree', 'add', '-q', '--force', jobWt, 'grid/J-l3']);
  const leakPath = join(jobWt, 'leak.txt');
  const contract2 = { validation: { automated: [`printf '[%s]' "$MOLT_SECRET_PROBE" > "${leakPath}"`] } };
  // Re-create objective with the correct path-bound contract.
  d.prepare(`UPDATE objectives SET contract_json=? WHERE id=?`).run(JSON.stringify(contract2), o);

  const ctx = await buildResultCtx(job);
  const v = await validateResult(job, completed({ changed_files: ['a.js'] }), ctx);
  ok(v.layers.some((l) => l.layer === 'automated' && l.pass), 'automated check ran and passed');
  const { readFileSync } = await import('node:fs');
  ok(readFileSync(leakPath, 'utf8') === '[]', 'the secret did NOT leak into the untrusted acceptance command');
  delete process.env.MOLT_SECRET_PROBE;
}

// =============================================================================
console.log('4 — validator FAILS CLOSED for unverified code.implementation; non-code unaffected');
{
  // code.implementation with NO ctx checks (no worktree/repo bound) -> reject, not silent pass.
  const o = objective({ repo: null });
  const job = implJob(o, { branch: null, spec: {} });
  const v = await validateResult(job, completed({ changed_files: ['a.js'] }), { contract: {} });
  ok(v.pass === false, 'code.implementation with no static/automated ctx is REJECTED (fail-closed)');
  ok(v.reasons.some((r) => /fail-closed/.test(r)), 'rejection reason names the fail-closed rule');

  // An inference (non-code) job with no ctx checks still passes — nothing to verify.
  const id = `J-${++seq}`;
  d.prepare(`INSERT INTO jobs(id,objective_id,type,title,capability_required,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, o, 'inference', id, 'inference', 'completed', now(), now());
  const infJob = d.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  const vi = await validateResult(infJob, completed({ output: 'a haiku' }), { contract: {} });
  ok(vi.pass === true, 'inference job with no ground-truth ctx still passes (not in scope of fail-closed)');
}

console.log(`\n✅ b-exec hardening: ${passed} checks passed`);
