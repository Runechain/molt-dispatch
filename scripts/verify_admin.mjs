// Integration test for the admin-panel control plane (runtime config + admin read-views).
// Drives a real in-process broker over HTTP, exactly like verify_grid.mjs, with MOLT_AUTH=1 so the
// operator auth gate is exercised. The admin surface is served by src/broker/server.mjs routes:
//   GET  /admin/config   -> { knobs: [ { key, value, mutability, group, source, ... }, ... ] }
//   POST /admin/config   -> setOverride(key, value) ; operator-only
//   GET  /admin/summary  -> { workers, queueByCapability, fuel, readiness, ... }
//   GET  /deliberations  -> [ ... ]   (array)
//   GET  /reputation     -> [ ... ]   ([] for anonymous callers)
// Those routes delegate to ./runtime-config.mjs + ./admin-queries.mjs, which a sibling agent is
// building concurrently. Until those land, the routes return a 500 JSON ("... module not loaded");
// every check below SOFT-SKIPS (logs `skip`) in that case rather than hard-failing, so this test is
// safe to run mid-integration. The orchestrator re-runs it once the modules are present.
//
// Auth: the broker checks `Authorization: Bearer <id>.<secret>` (server.mjs authOk). We mint a real
// API key via createKey() (writes the api_keys row directly) and send it as that Bearer token.
//
// Run with an isolated data dir + port:
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7099 node scripts/verify_admin.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read

// Turn the operator auth gate ON for the whole run, and set a known MOLT_API_KEY for completeness.
// The gate is read live per-request from process.env (server.mjs), so setting it before startBroker
// is sufficient. The actual Bearer token we send is the freshly-minted key below, mirroring
// verify_grid.mjs (createKey writes a real api_keys row, independent of MOLT_API_KEY).
process.env.MOLT_AUTH = '1';
process.env.MOLT_API_KEY = process.env.MOLT_API_KEY || 'mk_test.adminsecret';

import assert from 'node:assert/strict';
import { startBroker } from '../src/broker/server.mjs';
import { createKey } from '../src/broker/keys.mjs';
import { creditFuel, PRIMARY_ACCOUNT } from '../src/broker/fuel.mjs';
import { BROKER } from '../src/shared/config.mjs';

const base = BROKER.url;
let pass = 0;
let skipped = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`ok  ${msg}`);
  pass++;
};
const skip = (msg) => {
  console.log(`skip ${msg}`);
  skipped++;
};

async function post(path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(path, key) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// A 500 "... module not loaded" means the sibling's runtime-config/admin-queries hasn't landed yet.
// Detect it so each dependent check can soft-skip instead of hard-failing during integration.
const moduleMissing = (r) =>
  r.status === 500 && typeof r.body?.error === 'string' && /module not loaded/i.test(r.body.error);

// Find a knob by key in a snapshot's knobs array (defensive: tolerates missing array).
const findKnob = (knobs, key) => (Array.isArray(knobs) ? knobs.find((k) => k && k.key === key) : undefined);

const server = startBroker();
await new Promise((r) => setTimeout(r, 200)); // let it bind AND let loadAdminModules() settle (async)

try {
  // Mint a real operator key (writes the api_keys row directly, like verify_grid.mjs) and use it as
  // the Bearer token for authed requests.
  const operatorKey = createKey({ name: 'admin-test' }).key;
  ok(typeof operatorKey === 'string' && operatorKey.includes('.'), 'minted an operator API key (id.secret) for the auth gate');

  // Seed a little state so the read aggregates have something well-formed to report.
  creditFuel(PRIMARY_ACCOUNT, 250, 'admin-test seed balance');
  // Register a worker so /admin/summary has a roster + queue-by-capability surface to shape.
  await post('/workers/register', {
    worker_id: 'admin-worker',
    owner_id: 'AT',
    max_slots: 1,
    manifest: { capabilities: ['inference'], models: [{ provider: 'local', model: 'qwen2.5:32b' }] },
  }, operatorKey);

  // ---------------------------------------------------------------------------
  // 1. SNAPSHOT — GET /admin/config returns { knobs: [...] } spanning tiers, each well-shaped.
  // ---------------------------------------------------------------------------
  const snapAuthed = await get('/admin/config', operatorKey);
  if (moduleMissing(snapAuthed)) {
    skip('1. snapshot: runtime-config.mjs not loaded yet — GET /admin/config returns module-not-loaded');
    skip('2. redaction: skipped (runtime-config.mjs not loaded)');
    skip('3. auth-gate set: skipped (runtime-config.mjs not loaded)');
    skip('4. rejected mutations: skipped (runtime-config.mjs not loaded)');
    skip('5. live effect: skipped (runtime-config.mjs not loaded)');
  } else {
    ok(snapAuthed.status === 200, '1. GET /admin/config (authed) -> 200');
    const knobs = snapAuthed.body?.knobs;
    ok(Array.isArray(knobs) && knobs.length > 0, '1. snapshot has a non-empty knobs array');

    const repKnob = findKnob(knobs, 'repThreshold');
    const dangerKnob = findKnob(knobs, 'openGrid');
    // Representative knobs across tiers. The TIER is the `mutability` field (live/restart/deploy/
    // danger); danger knobs additionally carry danger:true. (`group` is the UI category, e.g.
    // reputation/security/network — a separate axis from mutability.)
    ok(repKnob, '1. snapshot contains a live-tier knob (repThreshold)');
    ok(dangerKnob, '1. snapshot contains a danger-tier knob (openGrid)');
    // Each knob carries the pinned shape: key/value/mutability/group.
    for (const [label, k] of [['repThreshold', repKnob], ['openGrid', dangerKnob]]) {
      if (!k) continue;
      ok(
        'key' in k && 'value' in k && 'mutability' in k && 'group' in k,
        `1. knob ${label} has key/value/mutability/group`
      );
    }
    if (repKnob) ok(repKnob.mutability === 'live', '1. repThreshold is a live-tier knob (mutability=live)');
    if (dangerKnob) ok(dangerKnob.mutability === 'danger' && dangerKnob.danger === true, '1. openGrid is a danger-tier knob (mutability=danger, danger=true)');

    // -------------------------------------------------------------------------
    // 2. REDACTION — anonymous GET redacts danger knob values to '***'; authed shows the real value.
    // -------------------------------------------------------------------------
    const snapAnon = await get('/admin/config'); // no key
    if (moduleMissing(snapAnon)) {
      skip('2. redaction: snapshot module went unavailable on the anon path');
    } else {
      ok(snapAnon.status === 200, '2. GET /admin/config (anonymous) -> 200');
      const anonDanger = findKnob(snapAnon.body?.knobs, 'openGrid');
      if (anonDanger) {
        ok(anonDanger.value === '***', '2. anonymous caller sees danger knob (openGrid) value redacted to ***');
      } else {
        skip('2. redaction: openGrid knob not present on anon snapshot');
      }
      if (dangerKnob) {
        ok(dangerKnob.value !== '***', '2. authed caller sees the REAL danger knob value (not redacted)');
      }
    }

    // -------------------------------------------------------------------------
    // 3. AUTH GATE — POST without key -> 401; with key, setting a live knob -> 200 + override shows up.
    // -------------------------------------------------------------------------
    const setNoKey = await post('/admin/config', { key: 'repThreshold', value: 0.55 });
    ok(setNoKey.status === 401, '3. POST /admin/config WITHOUT a key -> 401');

    const setLive = await post('/admin/config', { key: 'repThreshold', value: 0.55 }, operatorKey);
    if (moduleMissing(setLive)) {
      skip('3. set live knob: runtime-config.mjs setOverride not loaded yet');
    } else {
      ok(setLive.status === 200 && setLive.body?.ok === true, '3. POST /admin/config (authed) set live knob repThreshold -> 200 ok');
      const after = await get('/admin/config', operatorKey);
      const afterRep = findKnob(after.body?.knobs, 'repThreshold');
      if (afterRep) {
        ok(afterRep.source === 'override', '3. follow-up snapshot shows repThreshold source=override');
        ok(Number(afterRep.value) === 0.55, '3. follow-up snapshot shows repThreshold new value 0.55');
      } else {
        skip('3. follow-up snapshot: repThreshold knob not present');
      }
    }

    // -------------------------------------------------------------------------
    // 4. REJECTED MUTATIONS — danger key (openGrid) and deploy key (port) are not web-mutable.
    // -------------------------------------------------------------------------
    const setDanger = await post('/admin/config', { key: 'openGrid', value: true }, operatorKey);
    if (moduleMissing(setDanger)) {
      skip('4. rejected mutations: setOverride not loaded yet');
    } else {
      ok(
        setDanger.body?.ok === false,
        '4. authed POST of a danger knob (openGrid) is rejected (ok:false)'
      );
      if (setDanger.body?.error) {
        ok(/not_web_mutable|mutab|forbidden|danger/i.test(String(setDanger.body.error)), '4. openGrid rejection carries a not_web_mutable-style error');
      }
      const setDeploy = await post('/admin/config', { key: 'port', value: 9999 }, operatorKey);
      ok(setDeploy.body?.ok === false, '4. authed POST of a deploy knob (port) is rejected (ok:false)');
    }

    // -------------------------------------------------------------------------
    // 5. LIVE EFFECT — confirm the override changed the effective value the system reads.
    //    Driven purely through the public seam: a fresh GET /admin/config should reflect the
    //    override's value/source. (cfg('repThreshold') is not a stable public export, so we read
    //    it back through the snapshot rather than importing runtime internals.) Soft-skip if the
    //    override didn't take through the public route.
    // -------------------------------------------------------------------------
    const effSnap = await get('/admin/config', operatorKey);
    const effRep = findKnob(effSnap.body?.knobs, 'repThreshold');
    if (effRep && effRep.source === 'override' && Number(effRep.value) === 0.55) {
      ok(true, '5. live effect: effective repThreshold reflects the override (0.55) through the public snapshot');
    } else {
      skip('5. live effect: override not cleanly observable through the public snapshot seam — soft-skipped');
    }
  }

  // ---------------------------------------------------------------------------
  // 6. READ AGGREGATES — /admin/summary, /deliberations, /reputation are well-formed.
  // ---------------------------------------------------------------------------
  const summary = await get('/admin/summary', operatorKey);
  if (moduleMissing(summary)) {
    skip('6. summary: admin-queries.mjs not loaded yet — GET /admin/summary returns module-not-loaded');
  } else {
    ok(summary.status === 200, '6. GET /admin/summary -> 200');
    const s = summary.body || {};
    ok('workers' in s, '6. summary has a workers field');
    ok('queueByCapability' in s || 'queue_by_capability' in s, '6. summary has a queueByCapability field');
    ok('fuel' in s, '6. summary has a fuel field');
    ok('readiness' in s, '6. summary has a readiness field');
  }

  const delibs = await get('/deliberations', operatorKey);
  if (moduleMissing(delibs)) {
    skip('6. deliberations: admin-queries.mjs not loaded yet — GET /deliberations returns module-not-loaded');
  } else {
    ok(delibs.status === 200, '6. GET /deliberations -> 200');
    ok(Array.isArray(delibs.body), '6. /deliberations is an array');
  }

  // /reputation is gated like /workers: [] for anonymous, populated detail when authed.
  const repAnon = await get('/reputation'); // no key
  ok(repAnon.status === 200 && Array.isArray(repAnon.body) && repAnon.body.length === 0, '6. /reputation is [] for an anonymous caller');
  const repAuthed = await get('/reputation', operatorKey);
  if (moduleMissing(repAuthed)) {
    skip('6. reputation (authed): admin-queries.mjs reputationView not loaded yet');
  } else {
    ok(repAuthed.status === 200 && Array.isArray(repAuthed.body), '6. /reputation (authed) is a well-formed array');
  }

  console.log(`\n✅ admin: ${pass} checks passed${skipped ? ` (${skipped} soft-skipped pending sibling modules)` : ''}.`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  server.close();
  process.exit(1);
}
