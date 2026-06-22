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

export function listKeys() {
  return getDb()
    .prepare('SELECT id, account_id, name, scopes, last_used, revoked, created_at FROM api_keys ORDER BY created_at DESC')
    .all();
}

export function revokeKey(id) {
  return getDb().prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run(id).changes > 0;
}
