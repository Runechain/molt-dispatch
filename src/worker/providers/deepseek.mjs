// DeepSeek inference provider — OpenAI-compatible API at api.deepseek.com. Tier-aware: the
// deliberation/planner agents pass job.model per tier, so the cheap debate panel runs on
// deepseek-chat (V3) and the premium judge on deepseek-reasoner (R1) — the cheap/premium split
// the deliberation DAG is designed around, for free. Zero-dep (global fetch); streams + checkpoints.
//
// Billed directly via DEEPSEEK_API_KEY (not the fuel ledger), so agent calls on this provider are
// not budget-gated by the broker — spend is governed by the user's DeepSeek account.

const BASE = (process.env.MOLT_DEEPSEEK_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.MOLT_DEEPSEEK_MODEL || 'deepseek-chat';
const KEY = process.env.DEEPSEEK_API_KEY || process.env.MOLT_DEEPSEEK_KEY || null;
const MAX_TOKENS = Number(process.env.MOLT_DEEPSEEK_MAX_TOKENS || 2048);

function headers() {
  const h = { 'content-type': 'application/json' };
  if (KEY) h.authorization = `Bearer ${KEY}`;
  return h;
}

export const deepseekAdapter = {
  kind: 'provider',
  provider: 'deepseek',
  model: DEFAULT_MODEL,
  capabilities: ['inference'],

  async detect() {
    if (!KEY) return false;
    try {
      const res = await fetch(`${BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  },

  async run(job, ctx) {
    const model = job.model || DEFAULT_MODEL; // per-tier override from makeProviderInfer
    const prior = ctx.checkpoint?.partial || '';
    ctx.log(prior ? `[deepseek:${model}] resuming from ${prior.length} chars` : `[deepseek:${model}] generating...`);

    const messages = [{ role: 'system', content: 'You complete the task. Output only the result.' }];
    messages.push({ role: 'user', content: job.prompt || job.title || '' });
    if (prior) {
      messages.push({ role: 'assistant', content: prior });
      messages.push({ role: 'user', content: 'Continue exactly where you left off. Do not repeat anything.' });
    }

    let text = prior;
    let sinceSave = 0;
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, stream: true }),
        signal: ctx.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        return { status: 'failed', error: `deepseek HTTP ${res.status}: ${errText.slice(0, 200)}`, confidence: 0, provider: 'deepseek', model };
      }

      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            // deepseek-reasoner streams reasoning_content separately; we accumulate only the answer.
            const delta = JSON.parse(data).choices?.[0]?.delta?.content || '';
            if (delta) {
              text += delta;
              sinceSave += delta.length;
              if (sinceSave >= 200 && ctx.saveCheckpoint) {
                sinceSave = 0;
                await ctx.saveCheckpoint({ partial: text }).catch(() => {});
              }
            }
          } catch {
            /* skip malformed SSE line */
          }
        }
      }
    } catch (err) {
      if (ctx.saveCheckpoint && text) await ctx.saveCheckpoint({ partial: text }).catch(() => {});
      return { status: 'failed', error: String(err?.message || err), confidence: 0, provider: 'deepseek', model, partial: text };
    }

    return {
      status: 'completed',
      summary: `[deepseek:${model}] ${text.length} chars`,
      output: text,
      confidence: 0.7,
      provider: 'deepseek',
      model,
      artifacts: [{ kind: 'completion', inline: text }],
    };
  },
};
