// Connect-time preflight: proves detect() is too shallow and the DEEP check catches it.
//   1. The status model: ok / warn / missing map to the right meaning per tool.
//   2. The preferred baseline predicate: inference provider AND a code tool.
//   3. The reputation warning fires ONLY for warn-status tools whose caps WILL be advertised,
//      and the numbers it quotes are the broker's REAL WEIGHTS + Laplace formula (no drift).
//   4. --strict blocks when the baseline is unmet OR an advertised cap is backed by an unauthed tool.
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7113 node scripts/verify_preflight.mjs

import './_env.mjs'; // first: isolate config (preflight imports the broker's reputation constants)
import assert from 'node:assert/strict';
import { baseline, reputationWarning, strictBlock, checkMock, checkBedrock } from '../src/worker/preflight.mjs';
import { WEIGHTS, UNPROVEN_PRIOR } from '../src/broker/reputation.mjs';

let n = 0;
const ok = (l) => { n++; console.log('ok  ' + l); };

try {
  // ---- 1. status model -----------------------------------------------------------------------------
  const mock = await checkMock();
  assert.equal(mock.status, 'ok');
  assert.equal(mock.authed, true);
  assert.ok(mock.capabilities.includes('inference'), 'mock advertises inference');
  ok('checkMock() -> ok/authed with capabilities');

  // bedrock without AWS creds is installed-or-not-applicable but NOT authed -> warn (never missing).
  const savedKey = process.env.AWS_ACCESS_KEY_ID, savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
  const bedrockNoCreds = await checkBedrock();
  assert.equal(bedrockNoCreds.status, 'warn');
  assert.equal(bedrockNoCreds.authed, false);
  ok('checkBedrock() with no AWS creds -> warn/unauthed');
  process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'; process.env.AWS_SECRET_ACCESS_KEY = 'secretexample';
  const bedrockCreds = await checkBedrock();
  assert.equal(bedrockCreds.status, 'ok');
  assert.equal(bedrockCreds.authed, true);
  ok('checkBedrock() with AWS creds -> ok/authed');
  // restore
  if (savedKey == null) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = savedKey;
  if (savedSecret == null) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = savedSecret;

  // ---- 2. preferred baseline ----------------------------------------------------------------------
  assert.equal(baseline(['local', 'codex']).met, true, 'inference + code = met');
  assert.equal(baseline(['bedrock', 'claude']).met, true, 'bedrock + claude = met');
  assert.equal(baseline(['mock']).met, false, 'mock alone = not met');
  const noCode = baseline(['local']);
  assert.equal(noCode.met, false);
  assert.equal(noCode.haveInference, true);
  assert.equal(noCode.haveCode, false);
  assert.ok(noCode.missing.some((m) => /code tool/.test(m)), 'missing names the code tool gap');
  const noInf = baseline(['codex']);
  assert.equal(noInf.haveCode, true);
  assert.equal(noInf.haveInference, false);
  assert.ok(noInf.missing.some((m) => /inference/.test(m)), 'missing names the inference gap');
  ok('baseline() predicate: inference AND code tool, with a human-readable gap list');

  // ---- 3. reputation warning fires only for advertised warn-status caps ----------------------------
  // codex installed-but-unauthed (warn) and its capability code.implementation IS advertised.
  const statuses = [
    { name: 'codex', status: 'warn', capabilities: ['code.implementation', 'tests.unit'], authed: false },
    { name: 'local', status: 'ok', capabilities: ['inference'], authed: true },
    { name: 'claude', status: 'warn', capabilities: ['code.review'], authed: false }, // NOT advertised below
  ];
  const advertised = ['code.implementation', 'tests.unit', 'inference'];
  const { offenders, lines } = reputationWarning(statuses, advertised);
  assert.equal(offenders.length, 1, 'only codex offends (claude.code.review is not advertised)');
  assert.equal(offenders[0].name, 'codex');
  ok('reputationWarning() flags only warn-status tools whose caps WILL be advertised');

  // The numbers it quotes must be the broker's real WEIGHTS + Laplace formula, not hardcoded — and
  // the framing must be HONEST: trust tracks the all-failure floor 1/(n+2) DOWNWARD (0.33→0.25→0.20),
  // never the old self-contradictory "drops 0.30 → 0.33" (an increase miscalled a drop).
  const text = lines.join('\n');
  assert.ok(text.includes(String(WEIGHTS.rejected)), `quotes real rejected weight (${WEIGHTS.rejected})`);
  assert.equal(WEIGHTS.rejected, -1, 'sanity: rejected is -1 in the broker');
  const floor = (k) => (1 / (k + 2)).toFixed(2); // Laplace (accepted+1)/(total+2) with zero accepts
  assert.ok(text.includes(floor(1)), `quotes Laplace 1st-failure trust (${floor(1)})`);
  assert.ok(text.includes(floor(2)) && text.includes(floor(3)), 'shows the downward ratchet (0.25, 0.20), not one misleading number');
  assert.ok(text.includes(UNPROVEN_PRIOR.toFixed(2)), `quotes the unproven prior (${UNPROVEN_PRIOR.toFixed(2)})`);
  assert.ok(!/drops[^\n]*→\s*~?0\.33/.test(text), 'does NOT describe the 0.30→0.33 increase as a drop');
  assert.ok(/gate the node out/i.test(text), 'explains repeated failures gate the node out');
  ok('reputationWarning() numbers are the broker WEIGHTS + Laplace floor, framed honestly (no drift)');

  // ---- 4. --strict block ---------------------------------------------------------------------------
  // Baseline met AND all advertised caps backed by authed tools -> not blocked.
  const clean = [
    { name: 'local', status: 'ok', capabilities: ['inference'], authed: true },
    { name: 'codex', status: 'ok', capabilities: ['code.implementation', 'tests.unit'], authed: true },
  ];
  const cleanBlock = strictBlock(clean, ['local', 'codex'], ['inference', 'code.implementation', 'tests.unit']);
  assert.equal(cleanBlock.blocked, false, 'clean node not blocked under --strict');

  // An unauthed advertised tool -> blocked, with a reason.
  const dirtyBlock = strictBlock(statuses, ['codex', 'local'], advertised);
  assert.equal(dirtyBlock.blocked, true, 'unauthed advertised cap blocks under --strict');
  assert.ok(dirtyBlock.reasons.some((r) => /codex/.test(r)), 'reason names codex');

  // Baseline unmet (mock only) -> blocked even with no unauthed tools.
  const baselineBlock = strictBlock([{ name: 'mock', status: 'ok', capabilities: ['inference'], authed: true }], ['mock'], ['inference']);
  assert.equal(baselineBlock.blocked, true, 'mock-only fails the baseline under --strict');
  assert.ok(baselineBlock.reasons.some((r) => /baseline/.test(r)), 'reason names the baseline');
  ok('strictBlock() blocks on unmet baseline OR an unauthed advertised capability');

  console.log(`\nPreflight passed (${n} checks).`);
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
}
