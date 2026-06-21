// Adapter registry. An adapter is the local bridge between the broker and a concrete
// worker runtime (WHITEPAPER §4 "Adapter"). Common interface:
//
//   adapter.capabilities : string[]              // what jobs it can take
//   adapter.detect()     : Promise<boolean>      // is this runtime available locally?
//   adapter.run(job, ctx): Promise<ResultDraft>  // execute, return a result draft
//
// ctx = { worktree, log }. ResultDraft = { status, summary, changed_files, tests_run,
// known_risks, confidence, review?, artifacts? }. The daemon stamps lease_token on submit.

import { mockAdapter } from './mock.mjs';
import { codexAdapter } from './codex.mjs';
import { claudeAdapter } from './claude.mjs';

const ALL = {
  mock: mockAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
};

export function getAdapter(name) {
  return ALL[name];
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
