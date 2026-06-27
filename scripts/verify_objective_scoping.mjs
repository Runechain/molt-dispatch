// Integration test for PER-TENANT OBJECTIVE SCOPING — the backend half of "everyone gets their own
// dashboard, with a centralized list of workers". An objective is attributed to the account that
// created it (objectives.created_by = the API key's account). Scoping is OPT-IN so the legacy global
// view is preserved:
//   * GET /objectives?mine=1 -> ONLY the caller's own objectives (how a per-user dashboard scopes);
//   * a MEMBER key can't widen with ?account=<other> — it's narrowed back to its own;
//   * an OPERATOR key (scopes include `admin`) can target any account via ?account=<id>;
//   * a bare GET /objectives is unchanged (authed sees all) — backward compatible;
//   * workers are NOT scoped — the roster is the shared compute pool, identical for every caller.
//
// Drives a real in-process broker over HTTP (like verify_admin.mjs / verify_invites.mjs) with
// MOLT_AUTH=1 so the account behind each Bearer key is resolved. createKey writes real api_keys rows.
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7098 node scripts/verify_objective_scoping.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read

import assert from 'node:assert/strict';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`ok  ${msg}`); pass++; };

const { startBroker } = await import('../src/broker/server.mjs');
const { createKey } = await import('../src/broker/keys.mjs');
const { BROKER } = await import('../src/shared/config.mjs');
const base = BROKER.url;

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
const ids = (r) => (Array.isArray(r.body) ? r.body.map((o) => o.id) : []);

process.env.MOLT_AUTH = '1'; // resolve the account behind every Bearer key

const server = startBroker();
await new Promise((r) => setTimeout(r, 200));

try {
  // Two members and one operator (operator key carries the `admin` scope).
  const alice = createKey({ name: 'alice' });
  const bob = createKey({ name: 'bob' });
  const op = createKey({ name: 'operator', scopes: 'dispatch,worker,admin' });

  // Each member commissions an objective with their own key -> attributed to their account.
  const aObj = await post('/objectives', { title: 'alice feature', prompt: 'do A' }, alice.key);
  const bObj = await post('/objectives', { title: 'bob feature', prompt: 'do B' }, bob.key);
  ok(aObj.status === 200 && aObj.body.objective_id, '1. alice creates an objective with her key');
  ok(bObj.status === 200 && bObj.body.objective_id, '1. bob creates an objective with his key');
  const aId = aObj.body.objective_id;
  const bId = bObj.body.objective_id;

  // 2. ?mine=1 scopes a member to ONLY their own objectives (the per-user dashboard view).
  const aMine = await get('/objectives?mine=1', alice.key);
  ok(aMine.status === 200 && ids(aMine).includes(aId) && !ids(aMine).includes(bId),
    "2. alice ?mine=1 lists her objective and NOT bob's");
  const bMine = await get('/objectives?mine=1', bob.key);
  ok(ids(bMine).includes(bId) && !ids(bMine).includes(aId),
    "2. bob ?mine=1 lists his objective and NOT alice's");

  // 3. A member CANNOT widen scope with ?account=<other> — narrowed back to their own.
  const aTriesB = await get(`/objectives?account=${encodeURIComponent(bob.account_id)}`, alice.key);
  ok(ids(aTriesB).includes(aId) && !ids(aTriesB).includes(bId),
    '3. a member passing ?account=<other> is narrowed to their own (no cross-tenant read)');

  // 4. A bare GET is unchanged — an authed key still sees ALL (backward compatible).
  const aAll = await get('/objectives', alice.key);
  ok(ids(aAll).includes(aId) && ids(aAll).includes(bId),
    '4. a bare GET /objectives is global (legacy behavior preserved)');

  // 5. An operator can target one account via ?account=<id>.
  const opJustA = await get(`/objectives?account=${encodeURIComponent(alice.account_id)}`, op.key);
  ok(ids(opJustA).includes(aId) && !ids(opJustA).includes(bId),
    "5. operator ?account=<alice> returns only alice's objectives");

  // 6. ?mine=1 narrows the operator to their own (none here).
  const opMine = await get('/objectives?mine=1', op.key);
  ok(!ids(opMine).includes(aId) && !ids(opMine).includes(bId),
    '6. operator ?mine=1 excludes other accounts (operator created none)');

  // 7. Workers are NOT scoped — register one and confirm both members see the same roster.
  await post('/workers/register', { worker_id: 'w-shared', manifest: { capabilities: ['inference'] } }, op.key);
  const aWorkers = await get('/workers', alice.key);
  const bWorkers = await get('/workers', bob.key);
  const hasShared = (r) => Array.isArray(r.body) && r.body.some((w) => w.id === 'w-shared');
  ok(hasShared(aWorkers) && hasShared(bWorkers),
    '7. the worker roster is the shared pool — every member sees the same workers');

  console.log(`\n✅ objective scoping: ${pass} checks passed.`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  try { server.close(); } catch { /* ignore */ }
  process.exit(1);
}
