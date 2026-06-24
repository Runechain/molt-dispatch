// Agent identity — the worker's half of the RUNECHAIN claim flow (grid-identity design).
//
// The worker auto-generates an ed25519 keypair on first run and stores it locally (the operator
// never sees or pastes anything). `molt worker start` requests a CLAIM CODE from the game, prints it
// with the /claim URL, and polls until the logged-in human confirms — binding this agent's PUBLIC
// key to their game account. Thereafter the worker SIGNS each broker request with the key; the broker
// verifies the signature against the game binding (the game is the identity authority).

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PATHS } from '../shared/config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 10000; // bound claim/start + poll so a black-hole connection can't hang us
const DEFAULT_KEY_PATH = join(PATHS.root, '.molt-agent.json');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

// Load the agent's ed25519 keypair, generating + persisting it (0600) on first run. A corrupt or
// truncated key file (partial write, disk-full, pack truncation) must NOT crash startup — it is
// backed up and regenerated (the operator then re-claims the new key, which has a fresh pubkey).
export function loadOrCreateAgentKey(keyPath = DEFAULT_KEY_PATH) {
  let priv = null;
  if (existsSync(keyPath)) {
    try {
      const data = JSON.parse(readFileSync(keyPath, 'utf8'));
      priv = createPrivateKey({ key: Buffer.from(data.privatePkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
    } catch (err) {
      console.warn(`[worker] agent key at ${keyPath} is unreadable (${err.message}); backing it up to ${keyPath}.bak and regenerating — you'll need to re-claim this agent.`);
      try { renameSync(keyPath, keyPath + '.bak'); } catch { /* best effort */ }
      priv = null;
    }
  }
  if (!priv) {
    priv = generateKeyPairSync('ed25519').privateKey;
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, JSON.stringify({ privatePkcs8B64: priv.export({ format: 'der', type: 'pkcs8' }).toString('base64'), createdAt: Date.now() }, null, 2));
    try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  }
  const pubRaw = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  const pubkeyB64 = b64url(pubRaw);
  return {
    pubkeyB64,
    sign: (message) => b64url(edSign(null, Buffer.from(String(message), 'utf8'), priv)),
    // A freshly-signed credential the broker forwards to the game's /claim/verify.
    buildAuth(now = Date.now()) {
      const message = `runechain-agent-v1\nnonce=${b64url(randomBytes(9))}\nissued=${now}`;
      return { agentPubkey: pubkeyB64, message, signature: b64url(edSign(null, Buffer.from(message, 'utf8'), priv)) };
    },
  };
}

// Run the claim handshake against the game: start -> print code -> poll until confirmed.
// Returns { accountId } once bound. fetchImpl/log/now/pollMs are injectable for tests.
//
// Turnkey + durable: a code that EXPIRES before the human clicks does NOT crash the worker — it
// quietly issues a fresh code and keeps waiting. With timeoutMs <= 0 (or Infinity) the worker waits
// indefinitely (the `molt go` default: "just tell it go", confirm whenever, stop with `molt stop`).
export async function ensureClaimed(opts = {}) {
  const key = opts.key || loadOrCreateAgentKey(opts.keyPath);
  const gameUrl = (opts.gameUrl || '').replace(/\/$/, '');
  const f = opts.fetch || fetch;
  const log = opts.log || console.log;
  const label = String(opts.label || 'agent').slice(0, 48);
  const pollMs = opts.pollMs || 3000;
  // null/undefined => 15-min cap (suits tests); 0 or Infinity => wait forever, refreshing the code.
  const timeoutMs = opts.timeoutMs == null ? 15 * 60 * 1000 : opts.timeoutMs;
  const unbounded = !timeoutMs || timeoutMs === Infinity;
  const nowFn = opts.now || (() => Date.now());

  const requestCode = async () => {
    const startRes = await f(`${gameUrl}/claim/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPubkey: key.pubkeyB64, label }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const start = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !start.code) throw new Error(`claim start failed (${startRes.status}): ${start.message || start.code || ''}`);
    log('');
    log('  ┌─ Claim this agent ───────────────────────────────────');
    log(`  │  1. Open:   ${start.claimUrl || gameUrl + '/claim'}`);
    log(`  │  2. Sign in, then confirm code:   ${start.code}`);
    log('  │  (waiting for confirmation…)');
    log('  └──────────────────────────────────────────────────────');
    log('');
    return start;
  };

  const deadline = unbounded ? Infinity : nowFn() + timeoutMs;
  // Acquire (or re-issue) a claim code, surviving transient game outages so the durable wait never
  // crashes on a blip. Bounded mode (tests) surfaces the error once the window elapses; under
  // `molt go` (unbounded) it retries forever.
  const acquireCode = async () => {
    for (;;) {
      try { return await requestCode(); }
      catch (e) {
        if (nowFn() >= deadline) throw e;
        log(`[worker] couldn't reach the game to (re)issue a claim code (${e.message}); retrying…`);
        await sleep(pollMs);
      }
    }
  };

  let start = await acquireCode();
  let pollFails = 0;
  while (nowFn() < deadline) {
    await sleep(pollMs);
    let poll = {};
    try {
      poll = await (await f(`${gameUrl}/claim/poll?code=${encodeURIComponent(start.code)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).json();
      pollFails = 0;
    } catch {
      // Transient — keep polling, but surface a sustained inability to reach the authority so a
      // misconfigured MOLT_GAME_URL doesn't masquerade as an indefinite silent hang.
      if (++pollFails === 10) log(`[worker] still can't reach the game at ${gameUrl} to confirm the claim — check it's online and MOLT_GAME_URL is correct (will keep trying)…`);
      continue;
    }
    if (poll.status === 'confirmed') { log(`[worker] agent claimed → account ${poll.accountId}`); return { accountId: poll.accountId, code: start.code }; }
    if (poll.status === 'denied') throw new Error('claim was denied');
    if (poll.status === 'expired') { log('[worker] claim code expired — issuing a fresh one…'); start = await acquireCode(); }
  }
  throw new Error('claim timed out (no confirmation within the window)');
}
