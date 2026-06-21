// Claude adapter — review/reasoning jobs via `claude -p --output-format json`. The model is
// asked to emit ONLY a JSON object matching the rubric; we parse it from the result field.
// (--json-schema enforcement is unreliable in this CLI version, so we validate broker-side.)

import { readFile } from 'node:fs/promises';
import { run, which } from '../../shared/proc.mjs';
import { extractJson } from '../../shared/jsonout.mjs';

const TIMEOUT_MS = 10 * 60 * 1000;

export const claudeAdapter = {
  capabilities: ['code.review', 'docs.technical', 'product.specification'],

  async detect() {
    return await which('claude');
  },

  async run(job, ctx) {
    let patch = '';
    const pp = job.review_target?.patch_path;
    if (pp) {
      try {
        patch = await readFile(pp, 'utf8');
      } catch {
        /* no patch artifact — claude can still read the worktree */
      }
    }

    const prompt = buildReviewPrompt(job, patch);
    ctx.log('[claude] reviewing change...');
    const res = await run(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read,Grep,Glob'],
      { cwd: ctx.worktree || undefined, timeoutMs: TIMEOUT_MS }
    );

    if (res.timedOut) return { status: 'failed', error: 'claude timed out', confidence: 0 };
    if (res.code !== 0) return { status: 'failed', error: res.stderr || `claude exit ${res.code}`, confidence: 0 };

    let envelope;
    try {
      envelope = JSON.parse(res.stdout);
    } catch {
      return { status: 'failed', error: 'claude output was not JSON', summary: res.stdout.slice(0, 500) };
    }
    const review = extractJson(envelope.result);
    if (!review) {
      return { status: 'failed', error: 'could not parse review JSON', summary: String(envelope.result).slice(0, 500) };
    }

    return {
      status: 'completed',
      summary: review.summary || 'review complete',
      confidence: typeof review.confidence === 'number' ? review.confidence / 5 : 0.6,
      review,
    };
  },
};

function buildReviewPrompt(job, patch) {
  const gates = (job.acceptance_criteria || []).map((c) => `  - ${c}`).join('\n');
  return [
    `You are a strict code reviewer. Review the change described below for: "${job.title}".`,
    gates ? `\nIt must satisfy these gates:\n${gates}` : '',
    patch ? `\nThe change (git diff):\n\n${patch}\n` : `\nThe changed code is in your current working directory; read it with the Read/Grep tools.`,
    `\nAssess scope creep, correctness, security, maintainability, and test coverage.`,
    `\nRespond with ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:`,
    `  correctness, scope_control, maintainability, security, test_coverage, confidence : integers 0-5`,
    `  recommendation : one of "approve", "request_changes", "reject"`,
    `  summary : a one-sentence string`,
    `  objections : an array of { "severity": "low"|"medium"|"high", "detail": string } (empty array if none)`,
  ]
    .filter(Boolean)
    .join('\n');
}
