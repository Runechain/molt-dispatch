// `molt doctor` — preflight checks so a new user knows what's ready before running.

import { which, run } from './shared/proc.mjs';

const OK = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m●\x1b[0m';
const BAD = '\x1b[31m✗\x1b[0m';

function line(mark, label, detail) {
  console.log(`  ${mark}  ${label.padEnd(22)} ${detail || ''}`);
}

export async function doctor() {
  console.log('\nmolt doctor — environment check\n');

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 24 ? OK : BAD, 'Node >= 24', `found ${process.versions.node}${major >= 24 ? '' : ' (need >= 24 for node:sqlite)'}`);

  // node:sqlite
  let sqliteOk = false;
  try {
    await import('node:sqlite');
    sqliteOk = true;
  } catch {
    /* not available */
  }
  line(sqliteOk ? OK : BAD, 'node:sqlite', sqliteOk ? 'available' : 'missing — upgrade Node');

  // git
  const gitOk = await which('git');
  line(gitOk ? OK : BAD, 'git', gitOk ? 'available' : 'missing — required for worktrees');

  console.log('\n  Adapters (workers run these locally; the broker never sees credentials)\n');

  // codex
  if (await which('codex')) {
    const s = await run('codex', ['login', 'status']);
    const out = `${s.stdout}\n${s.stderr}`; // codex prints status to stderr
    const loggedIn = s.code === 0 && /logged in/i.test(out);
    line(loggedIn ? OK : WARN, 'codex', loggedIn ? out.trim().split('\n').find((l) => /logged in/i.test(l)) : 'installed — run `codex login`');
  } else {
    line(WARN, 'codex', 'not installed (implementation jobs) — optional');
  }

  // claude
  if (await which('claude')) {
    line(OK, 'claude', 'installed (review jobs) — ensure `claude /login` is done');
  } else {
    line(WARN, 'claude', 'not installed (review jobs) — optional');
  }

  // mock always works
  line(OK, 'mock', 'always available (zero-cost loop / offline testing)');

  console.log('\n  Integrations\n');

  // gh
  if (await which('gh')) {
    const s = await run('gh', ['auth', 'status']);
    const authed = s.code === 0;
    const acct = (s.stderr + s.stdout).match(/account (\S+)/);
    line(authed ? OK : WARN, 'gh (GitHub)', authed ? `logged in${acct ? ' as ' + acct[1] : ''}` : 'installed — run `gh auth login`');
  } else {
    line(WARN, 'gh (GitHub)', 'not installed — needed for issues/PR mode (optional)');
  }

  console.log('\nReady. Next:  molt broker start  ·  molt worker start --adapters mock\n');
}
