// Integration test for the JOIN GATE + the quieted /connect endpoint.
//   1. Gate OFF (no MOLT_JOIN_SECRET): registration works without a token — backward compatible.
//   2. Gate ON: worker registration REQUIRES a matching join_token (constant-time checked); a missing,
//      wrong, or empty token is `join_denied`. This is the real lock on "who can join" — the public
//      `molt go` flow is inert without the operator-issued token.
//   3. /connect (|/help) serves the join recipe ONLY to authed operators; an anonymous passerby gets a
//      terse invite-only reply (no clone/command recipe).
//   4. The join secret NEVER leaks via /admin/config — the joinGate knob is presence-only ('set'/'unset')
//      and redacts to '***' for anonymous callers.
//
// Drives a real in-process broker over HTTP like verify_grid.mjs. The join gate (JOIN.secret) and the
// auth gate (MOLT_AUTH) are both read live per-request from process.env, so we toggle them between phases.
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7099 node scripts/verify_join.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read

// Start clean: gate OFF and no operator auth so the registration phase reaches registerWorker directly.
delete process.env.MOLT_JOIN_SECRET;
delete process.env.MOLT_AUTH;

import assert from 'node:assert/strict';
import { startBroker } from '../src/broker/server.mjs';
import { createKey } from '../src/broker/keys.mjs';
import { BROKER } from '../src/shared/config.mjs';

const base = BROKER.url;
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`ok  ${msg}`); pass++; };

async function reg(body) {
  const res = await fetch(`${base}/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function getJSON(path, key) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const worker = (id, extra = {}) => ({ worker_id: id, manifest: { capabilities: ['inference'] }, ...extra });

try {
  await startBroker();

  // ---- 1. gate OFF: registration with no token still works -----------------------------------------
  const r0 = await reg(worker('w-open'));
  ok(r0.body.worker_id && !r0.body.error, 'gate OFF: registration without a join token succeeds (backward compatible)');

  // ---- 2. gate ON: arm the join secret -------------------------------------------------------------
  const SECRET = 'jt_s3kret_invite_only_98f2';
  process.env.MOLT_JOIN_SECRET = SECRET;

  const rNo = await reg(worker('w-notoken'));
  ok(rNo.body.error === 'join_denied', 'gate ON: registration WITHOUT a token is join_denied');

  const rWrong = await reg(worker('w-wrong', { join_token: 'not-the-secret' }));
  ok(rWrong.body.error === 'join_denied', 'gate ON: a WRONG token is join_denied');

  const rEmpty = await reg(worker('w-empty', { join_token: '' }));
  ok(rEmpty.body.error === 'join_denied', 'gate ON: an empty token is join_denied (no crash on length mismatch)');

  const rOk = await reg(worker('w-invited', { join_token: SECRET }));
  ok(rOk.body.worker_id && !rOk.body.error, 'gate ON: registration WITH the correct token succeeds');

  // ---- 3. /connect is quiet to anon, full to operators ---------------------------------------------
  process.env.MOLT_AUTH = '1'; // now the auth gate distinguishes anon vs operator (read live per request)

  const anon = await getJSON('/connect');
  ok(!anon.body.how_to_join && /invite-only/i.test(anon.body.access || ''),
    '/connect (anon): terse invite-only reply, NO how_to_join recipe');

  const opKey = createKey({ name: 'join-test' }).key;
  const authed = await getJSON('/connect', opKey);
  ok(Array.isArray(authed.body.how_to_join) && authed.body.join_token_required === true,
    '/connect (operator): full recipe, flags join_token_required');
  ok(!JSON.stringify(authed.body).includes('git clone'),
    '/connect no longer advertises a clone-and-go recipe (token-gated wording)');

  // ---- 4. the join secret never leaks via /admin/config --------------------------------------------
  const cfgAuthed = await getJSON('/admin/config', opKey);
  const jg = (cfgAuthed.body.knobs || []).find((k) => k.key === 'joinGate');
  ok(jg && jg.danger === true && jg.value === 'set', 'joinGate knob shows presence "set" (authed) and is marked danger');
  ok(!JSON.stringify(cfgAuthed.body).includes(SECRET), 'the raw join secret NEVER appears in /admin/config');

  const cfgAnon = await getJSON('/admin/config');
  const jgAnon = (cfgAnon.body.knobs || []).find((k) => k.key === 'joinGate');
  ok(jgAnon && jgAnon.value === '***', 'joinGate value is redacted to *** for anonymous callers');

  console.log(`\n✅ join gate: ${pass} checks passed.`);
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
}
