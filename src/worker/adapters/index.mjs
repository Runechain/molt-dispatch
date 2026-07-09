// Adapter registry. An adapter is the local bridge between the broker and a concrete
// worker runtime (WHITEPAPER §4 "Adapter"). Common interface:
//
//   adapter.capabilities : string[]              // what jobs it can take
//   adapter.detect()     : Promise<boolean>      // is this runtime available locally?
//   adapter.run(job, ctx): Promise<ResultDraft>  // execute, return a result draft
//
// ctx = { worktree, log, signal, checkpoint, saveCheckpoint }. ResultDraft =
// { status, summary, confidence, ... } plus, for inference providers: { output, provider,
// model, usage?, partial? } and artifacts:[{kind:'completion', inline}]. The daemon stamps
// lease_token on submit.
//
// Heterogeneous providers (kind:'provider') implement the same contract but also carry
// { provider, model } so the worker manifest advertises concrete models and reputation is
// scored per (capability, model/provider). See ./../providers/.

import { mockAdapter } from './mock.mjs';
import { codexAdapter } from './codex.mjs';
import { claudeAdapter } from './claude.mjs';
import { hermesAdapter } from './hermes.mjs';
import { s2ValidatorAdapter } from './s2-validator.mjs';
import { openaiCompatibleAdapter } from '../providers/openai-compatible.mjs';
import { apikeyAdapter } from '../providers/apikey.mjs';
import { bedrockAdapter } from '../providers/bedrock.mjs';
import { deepseekAdapter } from '../providers/deepseek.mjs';

const ALL = {
  mock: mockAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
  hermes: hermesAdapter,
  local: openaiCompatibleAdapter, // OpenAI-compatible endpoint (Ollama/vLLM/llama.cpp) — local Qwen, etc.
  apikey: apikeyAdapter,          // BYO API key (OpenAI, Together, Mistral) — inference.mid capability
  's2-validator': s2ValidatorAdapter, // S2 content quality check + game-server ingest — s2.validate capability
  bedrock: bedrockAdapter, // AWS Bedrock — the funded continuation backstop
  deepseek: deepseekAdapter, // DeepSeek API (deepseek-chat / deepseek-reasoner), billed via DEEPSEEK_API_KEY
};

export function getAdapter(name) {
  return ALL[name];
}

// Manifest metadata for a heterogeneous worker: which concrete model/provider it serves.
export function adapterMeta(name) {
  const a = ALL[name];
  if (!a) return null;
  return { name, kind: a.kind || 'cli', provider: a.provider || name, model: a.model || null, capabilities: a.capabilities };
}

// Resolve which adapter should run a job: honor the job's adapter_hint if that adapter
// is enabled & available, else fall back to the first enabled adapter that advertises
// the required capability.
export async function resolveAdapter(job, enabledNames) {
  const enabled = enabledNames.map((n) => [n, ALL[n]]).filter(([, a]) => a);

  if (job.adapter_hint && enabledNames.includes(job.adapter_hint)) {
    const a = ALL[job.adapter_hint];
    if (a && (await a.detect())) return { name: job.adapter_hint, adapter: a };
  }
  for (const [name, a] of enabled) {
    if (a.capabilities.includes(job.capability_required) && (await a.detect())) {
      return { name, adapter: a };
    }
  }
  return null;
}

export function listAdapters() {
  return Object.keys(ALL);
}
