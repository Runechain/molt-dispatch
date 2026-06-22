// Mock adapter: deterministic, zero-cost, no AI. Exercises the full broker loop
// (claim -> run -> submit -> validate -> accept -> unlock) without spending anything.
// Used to prove the plumbing (M1) and as a fast offline test harness.

export const mockAdapter = {
  kind: 'provider',
  provider: 'mock',
  model: 'mock-1',
  capabilities: ['code.implementation', 'code.review', 'tests.unit', 'docs.technical', 'inference'],

  async detect() {
    return true;
  },

  async run(job, ctx) {
    ctx.log(`[mock] running ${job.type} for ${job.job_id}`);

    if (job.type === 'inference') {
      // Zero-cost inference: resume from any prior partial, emit one checkpoint, complete.
      const prior = ctx.checkpoint?.partial || '';
      if (prior) ctx.log(`[mock] resuming inference from ${prior.length} chars`);
      const output = (prior ? prior + ' ' : '') + `[mock completion for: ${(job.prompt || job.title || '').slice(0, 60)}]`;
      if (ctx.saveCheckpoint) await ctx.saveCheckpoint({ partial: output }).catch(() => {});
      return {
        status: 'completed',
        summary: `[mock] inference ${output.length} chars`,
        output,
        confidence: 0.8,
        provider: 'mock',
        model: 'mock-1',
        artifacts: [{ kind: 'completion', inline: output }],
      };
    }

    if (job.type === 'code.review') {
      return {
        status: 'completed',
        summary: `[mock] reviewed ${job.title}`,
        confidence: 0.9,
        review: {
          correctness: 5,
          scope_control: 5,
          maintainability: 4,
          security: 4,
          test_coverage: 4,
          confidence: 5,
          recommendation: 'approve',
          summary: '[mock] looks good, within scope, tests present.',
          objections: [],
        },
      };
    }

    // implementation / other
    return {
      status: 'completed',
      summary: `[mock] implemented ${job.title}`,
      changed_files: ['mock/file.js'],
      tests_run: ['mock: npm test (skipped)'],
      known_risks: [],
      confidence: 0.85,
    };
  },
};
