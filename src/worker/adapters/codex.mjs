// Codex adapter — implementation jobs via `codex exec` confined to the job's worktree.
// The patch (git diff) captured by workspace.mjs is the ground-truth result; codex's
// stdout is only used as a human-readable summary.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { run, which } from '../../shared/proc.mjs';
import { PATHS } from '../../shared/config.mjs';

const TIMEOUT_MS = 20 * 60 * 1000;

// The grid runs codex in an ISOLATED CODEX_HOME so it doesn't inherit the user's global
// config — plugins, "superpowers" skills, AGENTS.md, xhigh reasoning — which push codex
// into a plan-first/ask-before-editing workflow unsuitable for autonomous work units.
// Auth is symlinked from the real ~/.codex so the user's login (and token refresh) carry
// over without copying secrets into the project.
function ensureCodexHome() {
  const home = join(PATHS.root, '.codex-grid-home');
  mkdirSync(home, { recursive: true });

  const realAuth = join(homedir(), '.codex', 'auth.json');
  const linkAuth = join(home, 'auth.json');
  if (existsSync(realAuth) && !existsSync(linkAuth)) {
    try {
      symlinkSync(realAuth, linkAuth);
    } catch {
      /* if symlink fails, codex will report not-logged-in and the job fails cleanly */
    }
  }

  // Minimal config: same model, faster reasoning, workspace-write sandbox, no plugins/MCP.
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "medium"',
      'sandbox_mode = "workspace-write"',
      'approval_policy = "never"',
      '',
      '[sandbox_workspace_write]',
      // Network OFF by default — an injected prompt over attacker-controlled issue text could
      // otherwise use egress to exfiltrate. Opt in per deployment with MOLT_CODEX_NETWORK=1.
      `network_access = ${process.env.MOLT_CODEX_NETWORK === '1' ? 'true' : 'false'}`,
      '',
    ].join('\n')
  );
  return home;
}

export const codexAdapter = {
  capabilities: ['code.implementation', 'tests.unit'],

  async detect() {
    return await which('codex');
  },

  async run(job, ctx) {
    if (!ctx.worktree) throw new Error('codex adapter requires a worktree (objective has no repo?)');
    const prompt = buildPrompt(job);
    const codexHome = ensureCodexHome();
    ctx.log(`[codex] exec in ${ctx.worktree}`);

    // `codex exec` is non-interactive by default (no approval prompts). --sandbox confines
    // model-run commands to the worktree; --skip-git-repo-check since worktrees are fine.
    // CODEX_HOME isolates config so codex edits directly instead of planning-and-waiting.
    const res = await run(
      'codex',
      ['exec', '--cd', ctx.worktree, '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
      { timeoutMs: TIMEOUT_MS, env: { CODEX_HOME: codexHome }, onStderr: (d) => process.stdout.write(dim(d)) }
    );

    const tail = res.stdout.split('\n').filter(Boolean).slice(-12).join('\n').trim();
    if (res.timedOut) return { status: 'failed', error: 'codex timed out', summary: tail, confidence: 0 };
    if (res.code !== 0) return { status: 'failed', error: res.stderr || `codex exit ${res.code}`, summary: tail, confidence: 0 };

    return {
      status: 'completed',
      summary: tail || `codex completed: ${job.title}`,
      confidence: 0.7,
      known_risks: [],
      tests_run: [],
    };
  },
};

function buildPrompt(job) {
  const ac = (job.acceptance_criteria || job.spec?.acceptance_criteria || []).map((c) => `  - ${c}`).join('\n');
  const forbidden = (job.spec?.constraints?.forbidden || []).map((f) => `  - ${f}`).join('\n');
  return [
    job.prompt || `Implement: ${job.title}`,
    ac ? `\nAcceptance criteria (all must hold):\n${ac}` : '',
    forbidden ? `\nForbidden (do NOT do these):\n${forbidden}` : '',
    `\nEdit the files directly now. Do NOT present a plan, ask for approval, or wait — just make the change.`,
    `Make the smallest correct change, then run the project's tests until they pass.`,
    `Do not create git commits — leave your changes in the working tree.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function dim(s) {
  return `\x1b[2m${s.replace(/\n$/, '')}\x1b[0m\n`;
}
