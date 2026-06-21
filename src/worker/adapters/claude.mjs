// Claude adapter — review/reasoning jobs via `claude -p --output-format json --json-schema`.
// detect() is live in M1; run() is implemented in M2.

import { which } from '../../shared/proc.mjs';

export const claudeAdapter = {
  capabilities: ['code.review', 'docs.technical', 'product.specification'],

  async detect() {
    return await which('claude');
  },

  async run(job, ctx) {
    throw new Error('claude adapter run() is implemented in M2');
  },
};
