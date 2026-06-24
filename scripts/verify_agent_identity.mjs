// $0 verification of the agent claim flow (worker side + broker relying-party).
//   1. loadOrCreateAgentKey persists an ed25519 key (0600), reloads to the SAME pubkey, signs.
//   2. buildAuth() produces a credential whose ed25519 signature verifies under the GAME's exact
//      scheme (createPublicKey SPKI + verify) — so the worker's sig is accepted cross-repo.
//   3. ensureClaimed() runs start -> poll(pending) -> poll(confirmed) against a mock game.
//   4. verifyAgentClaim() (broker): missing cred, stale issued, game-rejects, and the happy path
//      that returns the bound accountId.
//
// Run:  node scripts/verify_agent_identity.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as edVerify } from 'node:crypto';

import { loadOrCreateAgentKey, ensureClaimed } from '../src/worker/agent-identity.mjs';
import { verifyAgentClaim } from '../src/broker/agent-verify.mjs';

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// The game's exact verification (mirrors blockmmo game/identity.js verifyEd25519).
function gameVerifies(agentPubkeyB64, message, sigB64) {
  const raw = b64urlToBuf(agentPubkeyB64), sig = b64urlToBuf(sigB64);
  if (raw.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch { return false; }
}
function jsonRes(ok, status, body) { return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }; }

let n = 0;
const ok = (l) => { n++; if (process.env.VERBOSE) console.log('  ok -', l); };

// ---- 1. key persistence + signing ----------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'molt-agent-'));
  const keyPath = join(dir, '.molt-agent.json');
  const key = loadOrCreateAgentKey(keyPath);
  assert.ok(key.pubkeyB64 && b64urlToBuf(key.pubkeyB64).length === 32, '32-byte ed25519 pubkey');
  assert.ok(existsSync(keyPath), 'key persisted');
  if (process.platform !== 'win32') assert.equal(statSync(keyPath).mode & 0o077, 0, 'key file is 0600 (no group/other)');
  const key2 = loadOrCreateAgentKey(keyPath);
  assert.equal(key2.pubkeyB64, key.pubkeyB64, 'reload yields the same key');
  ok('agent key persists (0600) + reloads stably');
}

// ---- 2. buildAuth verifies under the game's scheme -----------------------------------------------
{
  const key = loadOrCreateAgentKey(join(mkdtempSync(join(tmpdir(), 'molt-agent-')), 'k.json'));
  const auth = key.buildAuth(1_000_000);
  assert.ok(auth.agentPubkey && auth.message && auth.signature);
  assert.match(auth.message, /^runechain-agent-v1\nnonce=.+\nissued=1000000$/);
  assert.equal(gameVerifies(auth.agentPubkey, auth.message, auth.signature), true, 'game accepts the signature');
  assert.equal(gameVerifies(auth.agentPubkey, auth.message + 'x', auth.signature), false, 'tampered rejected');
  ok('buildAuth signature verifies under the game ed25519 scheme');
}

// ---- 3. ensureClaimed handshake (mock game) ------------------------------------------------------
{
  const key = loadOrCreateAgentKey(join(mkdtempSync(join(tmpdir(), 'molt-agent-')), 'k.json'));
  let polls = 0;
  const fetchMock = async (url) => {
    if (url.endsWith('/claim/start')) return jsonRes(true, 200, { code: 'K7PQ-3RX9', claimUrl: 'https://g/claim?code=K7PQ-3RX9', agentAddress: 'addr' });
    if (url.includes('/claim/poll')) { polls++; return jsonRes(true, 200, polls < 2 ? { status: 'pending' } : { status: 'confirmed', accountId: 'acct_human' }); }
    throw new Error('unexpected ' + url);
  };
  const lines = [];
  const r = await ensureClaimed({ key, gameUrl: 'https://g', label: 'codex@laptop', fetch: fetchMock, log: (m) => lines.push(m), pollMs: 1 });
  assert.equal(r.accountId, 'acct_human', 'claim confirmed -> account');
  assert.ok(lines.join('\n').includes('K7PQ-3RX9'), 'prints the code for the operator');
  ok('ensureClaimed: start -> poll(pending) -> poll(confirmed)');

  // denied / expired bail out
  await assert.rejects(() => ensureClaimed({ key, gameUrl: 'https://g', fetch: async (u) => u.endsWith('/claim/start') ? jsonRes(true, 200, { code: 'X' }) : jsonRes(true, 200, { status: 'expired' }), log: () => {}, pollMs: 1 }), /expired/);
  ok('ensureClaimed rejects on expiry');
}

// ---- 4. broker verifyAgentClaim ------------------------------------------------------------------
{
  const key = loadOrCreateAgentKey(join(mkdtempSync(join(tmpdir(), 'molt-agent-')), 'k.json'));
  const NOW = 2_000_000;
  const auth = key.buildAuth(NOW);

  // A mock game /claim/verify that actually checks the signature + a binding table.
  const bound = new Map(); // agentPubkey -> accountId
  const gameFetch = async (url, init) => {
    assert.ok(url.endsWith('/claim/verify'));
    const b = JSON.parse(init.body);
    if (!gameVerifies(b.agentPubkey, b.message, b.signature)) return jsonRes(false, 401, { code: 'invalid_agent_signature' });
    const acct = bound.get(b.agentPubkey);
    return acct ? jsonRes(true, 200, { ok: true, accountId: acct, agentAddress: 'addr' }) : jsonRes(false, 401, { code: 'agent_not_claimed' });
  };

  assert.equal((await verifyAgentClaim(null, { now: NOW, fetch: gameFetch })).error, 'agent_credential_missing');
  assert.equal((await verifyAgentClaim(auth, { now: NOW + 10 * 60 * 1000, fetch: gameFetch })).error, 'agent_auth_stale', 'old issued rejected');
  assert.equal((await verifyAgentClaim(auth, { now: NOW, fetch: gameFetch })).error, 'agent_not_claimed', 'unbound key rejected by game');

  bound.set(auth.agentPubkey, 'acct_human'); // human confirmed the claim
  const v = await verifyAgentClaim(key.buildAuth(NOW), { now: NOW, fetch: gameFetch });
  assert.equal(v.ok, true); assert.equal(v.accountId, 'acct_human', 'bound key -> account');

  // unreachable identity authority fails closed
  assert.equal((await verifyAgentClaim(key.buildAuth(NOW), { now: NOW, fetch: async () => { throw new Error('down'); } })).error, 'identity_authority_unreachable');
  ok('verifyAgentClaim: missing/stale/unbound/bound/unreachable');
}

console.log(`agent identity verification passed (${n} groups)`);
