// $0 verification of the deliberation DAG primitive — injects a mock infer (no real models).
// Proves: DAG order + concurrency waves, exactly-one premium call (the judge), structured
// verdict parsing, and that every failure path fails SAFE to 'escalate'.

import assert from 'node:assert/strict';
import { deliberate, _internals } from '../src/broker/agents/deliberate.mjs';

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
};

// A mock infer that records every call and returns role-appropriate text. The judge's
// verdict JSON is supplied per-test so we can drive each branch.
function mockInfer(judgeJson) {
  const calls = [];
  const infer = async ({ tier, role, phase }) => {
    calls.push({ tier, role, phase, at: calls.length });
    if (role === 'judge') return { text: typeof judgeJson === 'string' ? judgeJson : JSON.stringify(judgeJson), usage: { tokens: 50 } };
    return { text: `[${role}/${phase}] argument`, usage: { tokens: 10 } };
  };
  return { infer, calls };
}

const DECISIONS = ['release', 'stack', 'hold'];

console.log('deliberation DAG — structure');
{
  const ids = _internals.NODES.map((n) => n.id);
  ok(ids.length === 8, '8-node DAG (3 open + 3 rebut + skeptic + judge)');
  const judge = _internals.NODES.find((n) => n.id === 'judge');
  ok(judge.tier === 'premium', 'judge is the only premium-tier node');
  ok(_internals.NODES.filter((n) => n.tier === 'premium').length === 1, 'exactly one premium node total');
  ok(_internals.NODES.filter((n) => n.tier === 'cheap').length === 7, 'seven cheap-tier nodes');
}

console.log('deliberation DAG — happy path (judge selects a winner)');
{
  const { infer, calls } = mockInfer({ decision: 'release', winner: 'realist', confidence: 0.82, escalate: false, rationale: 'A is merged; B is independent.' });
  const v = await deliberate({ question: 'Can B proceed?', context: { a: 'merged', b: 'independent' }, decisions: DECISIONS, infer });

  ok(v.decision === 'release', 'verdict carries the judge decision (release)');
  ok(v.escalate === false, 'no escalation on a confident in-set decision');
  ok(v.winner === 'realist', 'winner surfaced');
  ok(Math.abs(v.confidence - 0.82) < 1e-9, 'confidence parsed');
  ok(v.usage.cheapCalls === 7 && v.usage.premiumCalls === 1, 'economics: 7 cheap calls + exactly 1 premium select');

  // Ordering: every open before any rebut; every rebut before skeptic; skeptic before judge.
  const lastOpen = Math.max(...calls.filter((c) => c.phase === 'open').map((c) => c.at));
  const firstRebut = Math.min(...calls.filter((c) => c.phase === 'rebut').map((c) => c.at));
  const lastRebut = Math.max(...calls.filter((c) => c.phase === 'rebut').map((c) => c.at));
  const skepticAt = calls.find((c) => c.role === 'skeptic').at;
  const judgeAt = calls.find((c) => c.role === 'judge').at;
  ok(lastOpen < firstRebut, 'all openings resolve before any rebuttal (wave 1 → wave 2)');
  ok(lastRebut < skepticAt, 'all rebuttals resolve before the skeptic heckles');
  ok(skepticAt < judgeAt, 'skeptic heckles before the judge rules');
  ok(calls.filter((c) => c.tier === 'premium').length === 1 && calls.find((c) => c.tier === 'premium').role === 'judge', 'the single premium call is the judge');
}

console.log('deliberation DAG — escalation is a first-class outcome');
{
  // explicit escalate
  let r = mockInfer({ decision: 'hold', escalate: true, escalateReason: 'merge state ambiguous', confidence: 0.3 });
  let v = await deliberate({ question: 'q', decisions: DECISIONS, infer: r.infer });
  ok(v.decision === 'escalate' && v.escalate === true, 'judge escalate:true → escalate verdict');
  ok(v.escalateReason === 'merge state ambiguous', 'escalation reason surfaced for the human');

  // out-of-set decision must NOT be trusted → escalate
  r = mockInfer({ decision: 'frobnicate', confidence: 0.99 });
  v = await deliberate({ question: 'q', decisions: DECISIONS, infer: r.infer });
  ok(v.decision === 'escalate' && /out-of-set/.test(v.escalateReason), 'out-of-set judge decision fails safe to escalate');

  // unparseable judge output → escalate (never silently release)
  r = mockInfer('the judge rambled in prose with no json');
  v = await deliberate({ question: 'q', decisions: DECISIONS, infer: r.infer });
  ok(v.decision === 'escalate' && /parseable/.test(v.escalateReason), 'unparseable judge output fails safe to escalate');

  // a thrown panel call → escalate (broken panel never releases)
  const throwing = async ({ role }) => {
    if (role === 'skeptic') throw new Error('provider down');
    return { text: 'x' };
  };
  v = await deliberate({ question: 'q', decisions: DECISIONS, infer: throwing });
  ok(v.decision === 'escalate' && /failed/.test(v.escalateReason), 'a failed panel node fails safe to escalate');
}

console.log('deliberation DAG — guards');
{
  await assert.rejects(() => deliberate({ question: 'q', decisions: DECISIONS }), /infer function is required/, 'missing infer rejects');
  await assert.rejects(() => deliberate({ question: 'q', infer: async () => ({ text: '{}' }) }), /decisions\[\] is required/, 'missing decisions rejects');
  ok(true, 'required-arg guards enforced');
}

console.log(`\n✅ deliberation DAG: ${passed} checks passed`);
