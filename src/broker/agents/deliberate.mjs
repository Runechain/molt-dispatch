// Deliberation DAG — settle a hard decision by debate, not a single oracle call.
//
// A panel of cheap-model personas (pessimist / optimist / realist) open, then rebut each
// other; a utilitarian skeptic heckles the whole debate; finally a PREMIUM judge reads the
// transcript and SELECTS a winner, rendering a structured verdict. The economics are the
// point — ~7 cheap calls + exactly 1 premium select — so the expensive model only adjudicates
// and never does the legwork. This is the heterogeneous grid's own reasoning turned inward.
//
// Reusable primitive: deliberate({ question, context, decisions, infer }) -> verdict.
// Used by the integration agent (dependency-release: release | stack | hold) and the planner
// agent (decomposition sanity). 'escalate' is ALWAYS an allowed outcome — that is the
// "only ask a human when necessary" exit. The judge picks it when the evidence genuinely
// won't support a confident call.
//
// Provider-agnostic: the caller injects `infer({ tier, role, phase, system, prompt })`
// -> { text, usage? }, where tier is 'cheap' | 'premium'. That keeps this $0-testable on a
// mock tier and routable across local Qwen / Bedrock in production (see makeProviderInfer).

import { extractJson } from '../../shared/jsonout.mjs';

// ---- The DAG ---------------------------------------------------------------
// Explicit nodes + deps so the structure is inspectable and maps 1:1 onto the broker's
// job_dependencies if/when these run as real grid jobs. Independent nodes run concurrently.
const PERSONAS = ['pessimist', 'optimist', 'realist'];
const OPENS = PERSONAS.map((r) => `open_${r}`);
const REBUTS = PERSONAS.map((r) => `rebut_${r}`);

const NODES = [
  ...PERSONAS.map((r) => ({ id: `open_${r}`, role: r, phase: 'open', tier: 'cheap', deps: [] })),
  ...PERSONAS.map((r) => ({ id: `rebut_${r}`, role: r, phase: 'rebut', tier: 'cheap', deps: OPENS })),
  { id: 'skeptic', role: 'skeptic', phase: 'heckle', tier: 'cheap', deps: REBUTS },
  { id: 'judge', role: 'judge', phase: 'judge', tier: 'premium', deps: ['skeptic', ...REBUTS] },
];

// ---- Role voices -----------------------------------------------------------
const SYSTEMS = {
  pessimist:
    'You are the PESSIMIST on a decision panel. Assume things break. Surface every concrete risk, failure mode, and reason NOT to proceed with the rosy reading — grounded in the specific context, not generic caution. Be sharp and specific. 4-6 sentences.',
  optimist:
    'You are the OPTIMIST on a decision panel. Argue the case FOR proceeding and the favorable reading of the evidence — why it is safe enough and what the upside is. Grounded in the specific context. 4-6 sentences.',
  realist:
    'You are the REALIST on a decision panel. Weigh both sides strictly against what the context actually supports. No spin in either direction. Land on the most defensible reading of the situation. 4-6 sentences.',
  skeptic:
    'You are the UTILITARIAN SKEPTIC. Heckle the whole debate. Cut through motivated reasoning on all sides, weigh cost vs. benefit coldly, and call out hand-waving or thin evidence by name. State what choice actually maximizes expected value given the uncertainty. 5-8 sentences.',
};

function rolePrompt(node, question, context, done, decisions) {
  const ctx = `DECISION: ${question}\n\nCONTEXT:\n${JSON.stringify(context, null, 2)}`;
  if (node.phase === 'open') return ctx;
  if (node.phase === 'rebut') {
    const openings = PERSONAS.map((r) => `--- ${r.toUpperCase()} opened:\n${done[`open_${r}`].text}`).join('\n\n');
    return `${ctx}\n\nThe three opening positions:\n\n${openings}\n\nAs the ${node.role.toUpperCase()}, rebut the other two and sharpen your own. Concede what they got right; attack what is weak. 4-6 sentences.`;
  }
  if (node.phase === 'heckle') {
    const rebuttals = PERSONAS.map((r) => `--- ${r.toUpperCase()}:\n${done[`rebut_${r}`].text}`).join('\n\n');
    return `${ctx}\n\nThe debate after rebuttals:\n\n${rebuttals}`;
  }
  // judge
  const transcript = [
    ...PERSONAS.map((r) => `${r.toUpperCase()} (rebuttal): ${done[`rebut_${r}`].text}`),
    `SKEPTIC: ${done.skeptic.text}`,
  ].join('\n\n');
  return [
    'You are the JUDGE — the single premium adjudicator. Read the debate and the skeptic\'s heckle, then SELECT a winning position and render the decision.',
    `\n${ctx}`,
    `\nDEBATE:\n${transcript}`,
    `\nAllowed decisions: ${decisions.join(' | ')}. Choose "escalate" ONLY if the evidence genuinely will not support a confident call — that hands it to a human.`,
    '\nRespond with ONLY a JSON object (no prose, no fences):',
    '{"decision":"<one allowed value>","winner":"pessimist|optimist|realist","confidence":0.0-1.0,"escalate":false,"escalateReason":"","rationale":"one or two sentences"}',
  ].join('\n');
}

const judgeSystem =
  'You are a rigorous adjudicator. You weigh arguments on merit, not stridency, and you are calibrated — low confidence when the case is genuinely close. You output only the requested JSON.';

// ---- DAG executor (topological waves; independent nodes run concurrently) ----
async function runDag(runNode) {
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const done = {};
  const remaining = new Set(NODES.map((n) => n.id));
  while (remaining.size) {
    const ready = [...remaining].filter((id) => byId[id].deps.every((d) => d in done));
    if (!ready.length) throw new Error('deliberation DAG deadlock — check NODES deps');
    const settled = await Promise.all(ready.map((id) => runNode(byId[id], done).then((out) => [id, out])));
    for (const [id, out] of settled) {
      done[id] = out;
      remaining.delete(id);
    }
  }
  return done;
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Run the deliberation DAG and return a normalized verdict.
 * @param {object}   o
 * @param {string}   o.question   the decision to settle
 * @param {object}   o.context    structured facts the panel reasons over
 * @param {string[]} o.decisions  allowed domain decisions (e.g. ['release','stack','hold'])
 * @param {function} o.infer      async ({tier,role,phase,system,prompt}) => {text, usage?}
 * @param {function} [o.log]
 * @returns {Promise<object>} verdict { decision, escalate, escalateReason, winner, confidence, rationale, transcript, usage }
 */
export async function deliberate({ question, context = {}, decisions, infer, log = () => {} }) {
  if (typeof infer !== 'function') throw new Error('deliberate: infer function is required');
  if (!Array.isArray(decisions) || !decisions.length) throw new Error('deliberate: decisions[] is required');
  const allowed = [...new Set([...decisions, 'escalate'])];

  const usage = { cheapCalls: 0, premiumCalls: 0, tokens: 0 };
  const runNode = async (node, done) => {
    const system = node.role === 'judge' ? judgeSystem : SYSTEMS[node.role];
    const prompt = rolePrompt(node, question, context, done, allowed);
    log(`[deliberate] ${node.id} (${node.tier})`);
    const res = await infer({ tier: node.tier, role: node.role, phase: node.phase, system, prompt });
    if (node.tier === 'premium') usage.premiumCalls++;
    else usage.cheapCalls++;
    if (res?.usage?.tokens) usage.tokens += res.usage.tokens;
    return { text: (res && res.text) || '', usage: res?.usage };
  };

  let done;
  try {
    done = await runDag(runNode);
  } catch (err) {
    // A broken panel must fail SAFE — escalate to a human, never silently "release".
    return escalateVerdict(`deliberation failed: ${err.message}`, usage, null);
  }

  const parsed = extractJson(done.judge.text);
  if (!parsed || typeof parsed !== 'object') {
    return escalateVerdict('judge output was not parseable JSON', usage, transcriptOf(done));
  }

  const inSet = allowed.includes(parsed.decision);
  const escalate = parsed.escalate === true || !inSet || parsed.decision === 'escalate';
  const decision = escalate ? 'escalate' : parsed.decision;
  const escalateReason = escalate
    ? parsed.escalateReason || (!inSet ? `judge returned out-of-set decision "${parsed.decision}"` : 'judge requested human review')
    : null;

  return {
    decision,
    escalate,
    escalateReason,
    winner: parsed.winner ?? null,
    confidence: clamp01(typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence)),
    rationale: parsed.rationale || '',
    transcript: transcriptOf(done),
    usage,
  };
}

function escalateVerdict(reason, usage, transcript) {
  return { decision: 'escalate', escalate: true, escalateReason: reason, winner: null, confidence: 0, rationale: '', transcript, usage };
}

function transcriptOf(done) {
  return Object.fromEntries(Object.entries(done).map(([id, v]) => [id, v.text]));
}

// ---- Production wiring ------------------------------------------------------
// Maps the deliberation's tiers onto real grid providers: cheap -> local Qwen, premium ->
// Bedrock (the funded judge). Injected getAdapter keeps the broker decoupled from the worker
// provider registry. Not exercised by the $0 mock test — that injects its own infer.
export function makeProviderInfer({ getAdapter, tierAdapters = { cheap: 'local', premium: 'bedrock' }, log = () => {} } = {}) {
  if (typeof getAdapter !== 'function') throw new Error('makeProviderInfer: getAdapter is required');
  return async ({ tier, system, prompt }) => {
    const name = tierAdapters[tier] || tierAdapters.cheap;
    const adapter = getAdapter(name);
    if (!adapter) throw new Error(`makeProviderInfer: no adapter for tier "${tier}" (${name})`);
    const job = {
      type: 'inference',
      capability_required: 'inference',
      title: 'deliberation',
      prompt: system ? `${system}\n\n${prompt}` : prompt,
    };
    const ctx = { log, signal: undefined, checkpoint: null, saveCheckpoint: null };
    const res = await adapter.run(job, ctx);
    if (res.status !== 'completed') throw new Error(`infer failed on ${name}: ${res.error || res.status}`);
    return { text: res.output || '', usage: res.usage || {} };
  };
}

export const _internals = { NODES }; // for tests/inspection
