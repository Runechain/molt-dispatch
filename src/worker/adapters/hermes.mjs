// Hermes adapter — forwards jobs to a local Hermes agent via HTTP.
// The Hermes agent runs a thin HTTP server that receives job payloads,
// the user/session processes them, and returns the result draft.
//
// Two modes:
//   1. Live callback (hermes responds inline via HTTP) — for interactive sessions
//   2. Queued (job submitted to a queue, user picks it up async) — fallback
//
// Env vars:
//   MOLT_HERMES_URL    — where the Hermes agent is listening (default http://127.0.0.1:18997)
//   MOLT_HERMES_MODE   — "callback" (default, live response) or "queue" (async pickup)

const HERMES_URL = (process.env.MOLT_HERMES_URL || 'http://127.0.0.1:18997').replace(/\/$/, '');
const MODE = process.env.MOLT_HERMES_MODE || 'callback';
const TIMEOUT_MS = Number(process.env.MOLT_HERMES_TIMEOUT || 300_000); // 5 min default

export const hermesAdapter = {
  kind: 'provider',
  provider: 'hermes',
  model: 'hermes-agent',
  capabilities: ['code.implementation', 'code.review', 'tests.unit', 'docs.technical', 'inference', 'planning', 'research'],

  async detect() {
    if (MODE === 'queue') return true; // always available in queue mode
    // In callback mode, check that the Hermes HTTP server is reachable
    try {
      const res = await fetch(`${HERMES_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async run(job, ctx) {
    ctx.log(`[hermes] job '${job.title}' (${job.job_id}) — mode=${MODE}`);

    const payload = {
      job_id: job.job_id,
      type: job.type,
      capability: job.capability_required,
      title: job.title,
      prompt: job.prompt || '',
      spec: job.spec_json ? JSON.parse(job.spec_json) : null,
      repo: job.repo || null,
      branch: job.branch || null,
      adapter_hint: job.adapter_hint || null,
      trust_required: job.trust_required,
      priority: job.priority,
      checkpoint: ctx.checkpoint || null,
      // Full spec for the Hermes agent to work with
      worktree: ctx.worktree || null,
    };

    if (MODE === 'queue') {
      // Queue mode: submit to local queue, return pending status.
      // The user picks it up from the queue endpoint later.
      const res = await fetch(`${HERMES_URL}/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          submit_url: `${HERMES_URL}/submit/${job.job_id}`,
          checkpoint_url: `${HERMES_URL}/checkpoint/${job.job_id}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { status: 'failed', error: `hermes queue rejected: HTTP ${res.status}` };
      }
      return {
        status: 'pending',
        summary: `[hermes] queued for user pickup — run 'molt dispatch' in your Hermes session`,
        confidence: 0,
        provider: 'hermes',
        model: 'hermes-agent',
      };
    }

    // Callback mode: POST the job to Hermes, wait for result.
    ctx.log(`[hermes] sending to ${HERMES_URL}/run — waiting up to ${TIMEOUT_MS / 1000}s`);
    const start = Date.now();
    try {
      const res = await fetch(`${HERMES_URL}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // Save checkpoint on failure so work isn't totally lost
        if (ctx.saveCheckpoint && errText) {
          await ctx.saveCheckpoint({ partial: errText.slice(0, 5000) }).catch(() => {});
        }
        return {
          status: 'failed',
          error: `hermes HTTP ${res.status}: ${errText.slice(0, 500)}`,
          confidence: 0,
          provider: 'hermes',
          model: 'hermes-agent',
        };
      }

      const result = await res.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      ctx.log(`[hermes] done in ${elapsed}s — status=${result.status}`);

      return {
        status: result.status || 'completed',
        summary: result.summary || `[hermes] ${result.status || 'completed'}`,
        output: result.output || result.summary || '',
        confidence: result.confidence ?? 0.8,
        provider: 'hermes',
        model: 'hermes-agent',
        review: result.review || undefined,
        changed_files: result.changed_files || [],
        tests_run: result.tests_run || [],
        known_risks: result.known_risks || [],
        artifacts: result.artifacts || [],
      };
    } catch (err) {
      // If we have partial output, save a checkpoint for resumption
      ctx.log(`[hermes] error: ${err.message}`);
      return {
        status: 'failed',
        error: `hermes adapter error: ${err.message}`,
        confidence: 0,
        provider: 'hermes',
        model: 'hermes-agent',
      };
    }
  },
};
