// $0 verification of the DeepSeek provider — stubs global fetch (no network, no key spent).
// Proves: per-tier model selection (job.model), correct endpoint + auth, SSE accumulation.

import assert from 'node:assert/strict';

process.env.DEEPSEEK_API_KEY = 'sk-test-key';
const { deepseekAdapter } = await import('../src/worker/providers/deepseek.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

let captured = null;
function stubFetch(deltas) {
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    const body = (async function* () {
      const enc = new TextEncoder();
      for (const d of deltas) yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n`);
      yield enc.encode('data: [DONE]\n');
    })();
    return { ok: true, body };
  };
}
const ctx = { log: () => {}, checkpoint: null, saveCheckpoint: null, signal: undefined };

console.log('deepseek provider — premium tier (deepseek-reasoner) via job.model');
{
  stubFetch(['hello ', 'world']);
  const res = await deepseekAdapter.run({ type: 'inference', prompt: 'hi', model: 'deepseek-reasoner' }, ctx);
  ok(res.status === 'completed' && res.output === 'hello world', 'streamed SSE content accumulated');
  ok(res.provider === 'deepseek' && res.model === 'deepseek-reasoner', 'reports provider + the per-tier model used');
  ok(/api\.deepseek\.com/.test(captured.url) && /\/chat\/completions$/.test(captured.url), 'posts to the DeepSeek chat completions endpoint');
  ok(captured.opts.headers.authorization === 'Bearer sk-test-key', 'sends the API key as a bearer token');
  const sent = JSON.parse(captured.opts.body);
  ok(sent.model === 'deepseek-reasoner' && sent.stream === true, 'request body carries the chosen model + streaming');
}

console.log('deepseek provider — cheap tier defaults to deepseek-chat when no model given');
{
  stubFetch(['ok']);
  const res = await deepseekAdapter.run({ type: 'inference', prompt: 'hi' }, ctx);
  ok(res.model === 'deepseek-chat', 'defaults to deepseek-chat (the cheap debate model)');
  ok(JSON.parse(captured.opts.body).model === 'deepseek-chat', 'default model sent on the wire');
}

console.log('deepseek provider — HTTP error surfaces as failed, not a silent empty completion');
{
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  const res = await deepseekAdapter.run({ type: 'inference', prompt: 'hi', model: 'deepseek-chat' }, ctx);
  ok(res.status === 'failed' && /401/.test(res.error), 'non-2xx returns failed with the status');
}

console.log(`\n✅ deepseek provider: ${passed} checks passed`);
