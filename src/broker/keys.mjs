// API key minting for team-gating. Keys are created locally by an operator with DB access
// (no auth needed to mint the first key — avoids a chicken-and-egg). The full key is shown
// once as `${id}.${secret}`; only the id + sha256(secret) are stored.

import { createHash } from 'node:crypto';
import { getDb, now } from './db.mjs';
import { accountId, apiKeyId, apiKeySecret } from '../shared/ids.mjs';

export function ensureAccount({ name, role = 'team' } = {}) {
  const d = getDb();
  const id = accountId();
  d.prepare('INSERT INTO accounts(id, name, role, balance_cents, status, created_at) VALUES(?,?,?,?,?,?)').run(
    id, name || null, role, 0, 'active', now()
  );
  return id;
}

export function createKey({ name, scopes = 'dispatch,worker', accountId: acct } = {}) {
  const d = getDb();
  const account = acct || ensureAccount({ name, role: 'team' });
  const id = apiKeyId();
  const secret = apiKeySecret();
  const hash = createHash('sha256').update(secret).digest('hex');
  d.prepare('INSERT INTO api_keys(id, account_id, hash, name, scopes, revoked, created_at) VALUES(?,?,?,?,?,0,?)').run(
    id, account, hash, name || null, scopes, now()
  );
  return { id, secret, key: `${id}.${secret}`, account_id: account, scopes };
}

// Seed a PROVIDED key (`<id>.<secret>`) — the deployed-broker bootstrap path. The cloud broker's
// DB lives on EFS and WAL mode can't be written by a second host, so a key can't be minted from
// outside; instead the operator supplies MOLT_BOOTSTRAP_KEY and the broker seeds it on its own
// boot (single writer, safe). Only the sha256 of the secret is stored.
//
// `force` (used by seedBootstrapKey): if the id already exists with a DIFFERENT secret hash, UPDATE
// it (and un-revoke). Without this, ROTATING the bootstrap key (same id, new secret) silently kept
// the stale hash — locking the operator out of a key they actually set. Default stays idempotent.
export function importKey(rawKey, { name = 'bootstrap', scopes = 'dispatch,worker', accountId: acct, force = false } = {}) {
  const dot = String(rawKey || '').indexOf('.');
  if (dot < 1) throw new Error('importKey: key must be "<id>.<secret>"');
  const id = rawKey.slice(0, dot);
  const secret = rawKey.slice(dot + 1);
  if (!id || !secret) throw new Error('importKey: empty id or secret');
  const d = getDb();
  const hash = createHash('sha256').update(secret).digest('hex');
  const existing = d.prepare('SELECT id, hash FROM api_keys WHERE id=?').get(id);
  if (existing) {
    if (force && existing.hash !== hash) {
      d.prepare('UPDATE api_keys SET hash=?, revoked=0 WHERE id=?').run(hash, id);
      return { id, seeded: true, rotated: true };
    }
    return { id, seeded: false };
  }
  const account = acct || ensureAccount({ name, role: 'team' });
  d.prepare('INSERT INTO api_keys(id, account_id, hash, name, scopes, revoked, created_at) VALUES(?,?,?,?,?,0,?)').run(
    id, account, hash, name || null, scopes, now()
  );
  return { id, seeded: true, account_id: account };
}

export function listKeys() {
  return getDb()
    .prepare('SELECT id, account_id, name, scopes, last_used, revoked, created_at FROM api_keys ORDER BY created_at DESC')
    .all();
}

export function revokeKey(id) {
  return getDb().prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run(id).changes > 0;
}
