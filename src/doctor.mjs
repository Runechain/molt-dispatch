// `molt doctor` — preflight checks so a new user knows what's ready before running.
//
// The per-tool DEEP probes (codex login status, the local /models ping, bedrock creds) live in
// ./worker/preflight.mjs so the WORKER can run the exact same checks at connect time — keeping
// `molt doctor` and connect-time preflight from ever drifting. doctor() just renders their output.

import { which, run } from './shared/proc.mjs';
import { checkCodex, checkClaude, checkLocal, checkBedrock } from './worker/preflight.mjs';

const OK = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m●\x1b[0m';
const BAD = '\x1b[31m✗\x1b[0m';
const MARK = { ok: OK, warn: WARN, missing: BAD };

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

  // codex — DEEP check (install + `codex login status`), shared with connect-time preflight.
  const codex = await checkCodex();
  line(MARK[codex.status], 'codex', codex.detail);

  // claude — shared check (install + login reminder).
  const claude = await checkClaude();
  line(MARK[claude.status], 'claude', claude.detail);

  // mock always works
  line(OK, 'mock', 'always available (zero-cost loop / offline testing)');

  console.log('\n  Inference providers (heterogeneous workers)\n');

  // local OpenAI-compatible endpoint (Ollama / vLLM / llama.cpp) — the "hook up Qwen locally" path.
  // Shared deep check pings ${MOLT_OPENAI_BASE}/models; reachable ⇒ ok, unreachable ⇒ warn.
  const local = await checkLocal();
  line(MARK[local.status], 'local (OpenAI-compat)', local.detail);

  // AWS Bedrock — the funded continuation backstop (not available in ca-west-1). Shared deep check.
  const bedrock = await checkBedrock();
  line(MARK[bedrock.status], 'bedrock (AWS)', bedrock.detail);

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
