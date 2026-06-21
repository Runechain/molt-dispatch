// Codex adapter — implementation jobs via `codex exec` in an isolated worktree.
// detect() is live in M1; run() is implemented in M2 (needs workspace.mjs).

import { which } from '../../shared/proc.mjs';

export const codexAdapter = {
  capabilities: ['code.implementation', 'tests.unit'],

  async detect() {
    return await which('codex');
  },

  async run(job, ctx) {
    throw new Error('codex adapter run() is implemented in M2');
  },
};
