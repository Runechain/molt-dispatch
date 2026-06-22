// Live smoke: drive the REAL deliberation DAG against DeepSeek — the exact code path the
// deployed broker runs when an objective approval fires. Makes ~8 real DeepSeek calls
// (deepseek-chat ×7 debate panel + deepseek-reasoner ×1 judge). Needs DEEPSEEK_API_KEY in env.
//
//   DEEPSEEK_API_KEY=... node scripts/smoke_deepseek.mjs

import { makeProviderInfer, deliberate } from '../src/broker/agents/deliberate.mjs';
import { getAdapter } from '../src/worker/adapters/index.mjs';

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not set in env — aborting (no key handled).');
  process.exit(2);
}

const infer = makeProviderInfer({
  getAdapter,
  tierAdapters: { cheap: 'deepseek', premium: 'deepseek' },
  tierModels: { cheap: 'deepseek-chat', premium: 'deepseek-reasoner' },
});

// A realistic dependency-release call: the upstream's PR is open but NOT merged, so a sound
// panel should refuse to release the dependent (build-on-absent-code) — hold or escalate.
const question =
  'Now that the upstream objective is approved, may the dependent objective START? ' +
  'Choose "release" only if the upstream code is genuinely on the base branch the dependent forks; ' +
  '"hold" if it is not yet (e.g. PR open but unmerged); "escalate" if a human must decide.';
const context = {
  upstream: { id: 'O-schema', title: 'Season manifest schema', status: 'approved', integration: 'pr_opened', pr_url: 'https://github.com/x/y/pull/42' },
  dependent: { id: 'O-validators', title: 'Season validator suite', base: 'main' },
  facts: [
    'The upstream is in PR mode: its PR is OPEN and NOT yet merged into "main". A dependent forking main would not see the upstream schema module.',
    'Releasing a dependent that builds on absent upstream code wastes work and risks broken merges.',
  ],
};

console.log('▶ Driving the real deliberation against DeepSeek (chat panel + reasoner judge)…\n');
const started = process.hrtime.bigint();
const v = await deliberate({ question, context, decisions: ['release', 'hold'], infer, log: (m) => process.stdout.write(`  · ${m}\n`) });
const secs = Number(process.hrtime.bigint() - started) / 1e9;

const t = v.transcript || {};
const short = (s, n = 240) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
console.log('\n────────── DEBATE (deepseek-chat) ──────────');
for (const r of ['pessimist', 'optimist', 'realist']) console.log(`\n${r.toUpperCase()}: ${short(t['rebut_' + r])}`);
console.log(`\nSKEPTIC: ${short(t.skeptic)}`);
console.log('\n────────── VERDICT (deepseek-reasoner judge) ──────────');
console.log(`  decision   : ${v.decision}${v.escalate ? ' (ESCALATE)' : ''}`);
console.log(`  winner     : ${v.winner}`);
console.log(`  confidence : ${v.confidence}`);
console.log(`  rationale  : ${short(v.rationale, 400)}`);
if (v.escalateReason) console.log(`  escalate→  : ${v.escalateReason}`);
console.log(`\n  calls: ${v.usage.cheapCalls} cheap (deepseek-chat) + ${v.usage.premiumCalls} premium (deepseek-reasoner)  ·  ${secs.toFixed(1)}s`);
console.log(v.decision === 'escalate' && /fail|error/i.test(v.escalateReason || '') ? '\n❌ DeepSeek call failed — see escalateReason' : '\n✅ Live DeepSeek deliberation produced a verdict.');
