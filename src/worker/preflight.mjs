// Connect-time preflight: the DEEP "is this tool actually authed/reachable?" probe that
// `detect()` is too shallow to answer (WHITEPAPER §4 "Adapter" / §8 "Reputation").
//
// THE PROBLEM this module exists to fix: an adapter's detect() is a presence check — e.g.
// claude.detect()/codex.detect() are just `which(...)`. A tool that is INSTALLED but LOGGED OUT
// passes detect(), so the node advertises that tool's capabilities, CLAIMS jobs it can't actually
// do, then FAILS them at runtime. The broker's validator fails those closed → a `rejected`
// reputation event (−1) on that capability. The deep "is it logged in / reachable" probe used to
// live only inside `molt doctor`; this module extracts it into reusable, structured checks so the
// worker can warn (or, with --strict, refuse) BEFORE it ever advertises a capability it will fail.
//
// Each check returns a structured Status:
//   { name, status: 'ok'|'warn'|'missing', detail, capabilities: string[], authed: boolean }
//     ok      = installed AND authed/reachable          → safe to advertise its capabilities
//     warn    = installed but NOT authed/reachable      → advertising = guaranteed runtime failures
//     missing = not installed at all                    → simply absent (no reputation risk)
//
// `doctor()` CONSUMES these same functions so `molt doctor` and connect-time preflight never drift.

import { which, run } from '../shared/proc.mjs';
import { getAdapter } from './adapters/index.mjs';
// The truthful reputation cost is read from the broker's WEIGHTS, never hardcoded — so if the
// penalty schedule changes there, the warning we print here changes with it (single source).
import { WEIGHTS, UNPROVEN_PRIOR } from '../broker/reputation.mjs';
// The low-rep gate value (default 0.4): below it the broker forces redundant verification.
import { FUEL } from '../shared/config.mjs';

// Capabilities a tool advertises = exactly what its adapter declares. Reading them from the live
// adapter (not a copy) keeps preflight honest if an adapter's capability list ever changes.
const capsOf = (adapterName) => getAdapter(adapterName)?.capabilities ?? [];

// ---- per-tool DEEP checks -----------------------------------------------------------------------
// These mirror the probes doctor() used to inline. Each is async and self-contained: it decides
// installed-vs-authed-vs-missing and reports the capabilities the corresponding adapter advertises.

// codex — implementation/tests. `which` proves install; `codex login status` proves auth.
export async function checkCodex() {
  const caps = capsOf('codex');
  if (!(await which('codex'))) {
    return { name: 'codex', status: 'missing', detail: 'not installed (implementation jobs) — optional', capabilities: caps, authed: false };
  }
  const s = await run('codex', ['login', 'status']);
  const out = `${s.stdout}\n${s.stderr}`; // codex prints status to stderr
  const loggedIn = s.code === 0 && /logged in/i.test(out);
  return {
    name: 'codex',
    status: loggedIn ? 'ok' : 'warn',
    detail: loggedIn ? (out.trim().split('\n').find((l) => /logged in/i.test(l)) || 'logged in') : 'installed — run `codex login`',
    capabilities: caps,
    authed: loggedIn,
  };
}

// claude — review/docs/spec. The CLI has no cheap non-interactive auth probe, so install ⇒ ok and
// we surface the login reminder as the detail (matches doctor's long-standing behavior).
export async function checkClaude() {
  const caps = capsOf('claude');
  if (!(await which('claude'))) {
    return { name: 'claude', status: 'missing', detail: 'not installed (review jobs) — optional', capabilities: caps, authed: false };
  }
  return { name: 'claude', status: 'ok', detail: 'installed (review jobs) — ensure `claude /login` is done', capabilities: caps, authed: true };
}

// local OpenAI-compatible endpoint (Ollama / vLLM / llama.cpp) — the "hook up Qwen locally" path.
// "Installed" isn't meaningful for an HTTP endpoint, so reachable ⇒ ok, unreachable ⇒ warn (never
// missing): the operator opted into `local`, the endpoint just isn't up yet.
export async function checkLocal() {
  const caps = capsOf('local');
  const base = (process.env.MOLT_OPENAI_BASE || 'http://localhost:11434/v1').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const models = (j?.data || []).map((m) => m.id).slice(0, 3).join(', ');
      return {
        name: 'local',
        status: 'ok',
        detail: `${base} reachable${models ? ` (e.g. ${models})` : ''} · using ${process.env.MOLT_OPENAI_MODEL || 'qwen2.5:32b'}`,
        capabilities: caps,
        authed: true,
      };
    }
  } catch {
    /* unreachable */
  }
  return { name: 'local', status: 'warn', detail: `${base} unreachable — start Ollama/vLLM or set MOLT_OPENAI_BASE`, capabilities: caps, authed: false };
}

// bedrock — the funded continuation backstop. Creds present ⇒ ok; absent ⇒ warn (it's an opt-in
// provider, not something you "install", so we don't report it missing).
export async function checkBedrock() {
  const caps = capsOf('bedrock');
  const region = process.env.MOLT_BEDROCK_REGION || 'us-east-1';
  const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  return {
    name: 'bedrock',
    status: hasCreds ? 'ok' : 'warn',
    detail: hasCreds
      ? `creds present · region ${region} · ${process.env.MOLT_BEDROCK_MODEL || 'anthropic.claude-3-haiku-20240307-v1:0'}`
      : `no AWS creds — set AWS_ACCESS_KEY_ID/SECRET (region ${region}; Bedrock not in ca-west-1)`,
    capabilities: caps,
    authed: hasCreds,
  };
}

// mock — deterministic, zero-cost, always authed (offline/test loop).
export async function checkMock() {
  return { name: 'mock', status: 'ok', detail: 'always available (zero-cost loop / offline testing)', capabilities: capsOf('mock'), authed: true };
}

// The set of deep checks the connect-time report runs, by adapter name. Mirrors the tools doctor
// covers (codex, claude, local, bedrock, mock). Keyed by adapter name so the report can intersect
// with the `enabled` adapters the daemon actually turned on.
export const CHECKS = {
  codex: checkCodex,
  claude: checkClaude,
  local: checkLocal,
  bedrock: checkBedrock,
  mock: checkMock,
};

// Run the deep checks for a given set of adapter names (defaults to all we know how to probe).
// Returns an array of Status objects in a stable order.
export async function runChecks(names = Object.keys(CHECKS)) {
  const wanted = names.filter((n) => CHECKS[n]);
  return Promise.all(wanted.map((n) => CHECKS[n]()));
}

// ---- preferred baseline -------------------------------------------------------------------------
// A useful node serves real grid demand: at least one INFERENCE provider AND at least one CODE tool
// (implementation/review). A node with neither still runs (mock-only is valid for testing) but it
// won't move the funded queue, so we call that out.

const INFERENCE_PROVIDERS = ['local', 'bedrock', 'deepseek'];
const CODE_TOOLS = ['codex', 'claude'];

// Evaluate the preferred baseline against the adapters that are actually ENABLED (detected) on this
// node. Returns { met, haveInference, haveCode, missing } where `missing` is a human-readable list
// of what to add to satisfy the baseline.
export function baseline(enabledNames) {
  const enabled = new Set(enabledNames);
  const haveInference = INFERENCE_PROVIDERS.some((n) => enabled.has(n));
  const haveCode = CODE_TOOLS.some((n) => enabled.has(n));
  const missing = [];
  if (!haveInference) missing.push(`an inference provider (one of: ${INFERENCE_PROVIDERS.join(', ')})`);
  if (!haveCode) missing.push(`a code tool (one of: ${CODE_TOOLS.join(', ')})`);
  return { met: haveInference && haveCode, haveInference, haveCode, missing };
}

// Install/enable hints for tools the baseline wants but the node doesn't have.
const HINTS = {
  codex: 'install the codex CLI and run `codex login`',
  claude: 'install the claude CLI and run `claude /login`',
  local: 'start Ollama/vLLM (set MOLT_OPENAI_BASE) for local inference',
  bedrock: 'set AWS_ACCESS_KEY_ID/SECRET (and MOLT_BEDROCK_REGION) for the funded backstop',
  deepseek: 'set DEEPSEEK_API_KEY for the DeepSeek provider',
};
export const hintFor = (name) => HINTS[name] || `enable the '${name}' adapter`;

// ---- the reputation warning (the headline feature) ----------------------------------------------
// Spell out, TRUTHFULLY, the cost of advertising a capability backed by a warn-status (installed but
// unauthed) tool. Numbers come from the broker's real WEIGHTS + UNPROVEN_PRIOR + FUEL.repThreshold,
// so the message can't silently drift from what the broker actually does.
//
// The honest model (see reputation.mjs trustScore): a fresh (node, capability) sits at the
// UNPROVEN_PRIOR (0.30). There is NO first-failure cliff — the Laplace formula (accepted+1)/(total+2)
// actually puts ONE rejection at 1/3 ≈ 0.33, just ABOVE the prior (claiming a "drop" there would be
// a lie). The real cost is structural: with the tool unauthed the node can never log an `accepted`,
// so trust tracks the all-failure floor 1/(n+2) → 0 — dipping below the prior by the 2nd failure and
// staying pinned under FUEL.repThreshold (low-rep ⇒ forced redundant verify; trust_required>0 jobs
// hard-gate it out — see scheduler.mjs).
const laplaceFloor = (n) => (1 / (n + 2)).toFixed(2); // trust after n rejections with zero accepts
const REJECTED_DELTA = WEIGHTS.rejected; // −1 by construction; read from source, never hardcoded

// Build the warning lines for the to-be-advertised capabilities backed by warn-status tools.
// `statuses` = output of runChecks(); `advertised` = the capability set the node WILL advertise.
// Returns { offenders, lines } — offenders is the list of warn checks whose caps are advertised.
export function reputationWarning(statuses, advertised) {
  const adv = new Set(advertised);
  const offenders = statuses.filter((s) => s.status === 'warn' && s.capabilities.some((c) => adv.has(c)));
  const lines = [];
  for (const o of offenders) {
    const caps = o.capabilities.filter((c) => adv.has(c));
    lines.push(`'${o.name}' is installed but NOT authed/reachable, yet this node WILL advertise: ${caps.join(', ')}`);
    lines.push(`    → it will CLAIM those jobs and FAIL them at runtime (the validator fails them closed).`);
    lines.push(`    → each failure logs a 'rejected' event (${REJECTED_DELTA}) against this (node, capability) — standing evidence.`);
    lines.push(`    → with the tool unauthed you can't log a single 'accepted', so trust tracks the all-failure floor 1/(n+2): ${laplaceFloor(1)} → ${laplaceFloor(2)} → ${laplaceFloor(3)} → … → 0 (a fresh capability starts at the ${UNPROVEN_PRIOR.toFixed(2)} prior).`);
    lines.push(`    → it sinks below that prior by the 2nd failure and stays under the ${FUEL.repThreshold} low-rep gate — the broker forces redundant verification, ranks you behind proven nodes, and trust_required>0 jobs gate the node out entirely.`);
  }
  return { offenders, lines };
}

// ---- strict-mode predicate ----------------------------------------------------------------------
// Under --strict the node refuses to register if the preferred baseline isn't met OR any capability
// it would advertise is backed by a warn-status tool. Returns { blocked, reasons }.
export function strictBlock(statuses, enabledNames, advertised) {
  const reasons = [];
  const base = baseline(enabledNames);
  if (!base.met) reasons.push(`preferred baseline not met — missing ${base.missing.join(' and ')}`);
  const { offenders } = reputationWarning(statuses, advertised);
  for (const o of offenders) reasons.push(`'${o.name}' is unauthed but would advertise ${o.capabilities.filter((c) => advertised.includes(c)).join(', ')}`);
  return { blocked: reasons.length > 0, reasons };
}

// ---- the connect-time report --------------------------------------------------------------------
// A doctor-style block printed once at connect, AFTER the daemon has computed enabled/capabilities.
// Default behavior is warn-and-proceed (headless/cron-safe — this runs under go-live.sh). Returns
// { strictBlocked, reasons } so the caller can exit(1) under --strict.

const OK = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m●\x1b[0m';
const BAD = '\x1b[31m✗\x1b[0m';
const MARK = { ok: OK, warn: WARN, missing: BAD };

export async function preflightReport({ enabled, capabilities, strict = false, log = console.log } = {}) {
  // Probe every tool we know how to deep-check (not just the enabled ones) so the "missing vs
  // preferred" section can suggest tools the node doesn't have yet.
  const statuses = await runChecks();
  const enabledSet = new Set(enabled);
  const advertised = capabilities;

  log('\n[worker] preflight — what this node will advertise (deep auth/reachability check)\n');

  // 1. Detected adapters + the capabilities they advertise.
  for (const name of enabled) {
    const s = statuses.find((x) => x.name === name);
    const caps = getAdapter(name)?.capabilities || [];
    // A tool can be enabled (detect() passed) yet warn-status here (deep probe says unauthed).
    const mark = s ? MARK[s.status] : OK;
    log(`  ${mark}  ${name.padEnd(10)} advertises: ${caps.join(', ') || '(none)'}`);
  }

  // 2. Missing-vs-preferred, with install hints.
  const base = baseline(enabled);
  if (!base.met) {
    log('\n  Below the preferred baseline (an inference provider AND a code tool):');
    for (const m of base.missing) log(`    ${WARN}  missing ${m}`);
    // Suggest concrete tools to add for whichever half is missing.
    if (!base.haveInference) for (const n of INFERENCE_PROVIDERS) if (!enabledSet.has(n)) log(`        - ${hintFor(n)}`);
    if (!base.haveCode) for (const n of CODE_TOOLS) if (!enabledSet.has(n)) log(`        - ${hintFor(n)}`);
  } else {
    log(`\n  ${OK}  preferred baseline met (inference + code) — this node serves real grid demand.`);
  }

  // 3. The reputation warning — installed-but-unauthed tools whose caps WILL be advertised.
  const { offenders, lines } = reputationWarning(statuses, advertised);
  if (offenders.length) {
    log('\n  ⚠ REPUTATION RISK — advertising capabilities backed by unauthed tools:');
    for (const l of lines) log(`    ${l}`);
    log('    Fix the auth above, or pass --adapters to drop the unauthed tool, before claiming work.');
  }

  // 4. Strict-mode verdict (caller decides whether to exit).
  const { blocked, reasons } = strictBlock(statuses, enabled, advertised);
  if (strict && blocked) {
    log('\n  ✗ --strict: refusing to register —');
    for (const r of reasons) log(`    - ${r}`);
  }

  return { strictBlocked: strict && blocked, reasons, statuses, baseline: base };
}
