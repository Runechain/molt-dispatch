// Per-node join invites. The grid already has ONE shared join credential — MOLT_JOIN_SECRET
// (JOIN.secret), constant-time checked by joinTokenOk in server.mjs. An invite is the PER-NODE
// equivalent: a single-use (or bounded max_uses) token the operator mints locally and hands to ONE
// invited node out-of-band. It layers alongside the shared secret — the join gate is "on" when
// `JOIN.secret || JOIN.requireInvite`, and registerWorker accepts a node that presents EITHER a
// matching shared secret OR a valid invite.
//
// Security model mirrors the API-key pattern in keys.mjs exactly:
//   * The full token is `${id}.${secret}` and is shown to the operator ONCE at mint time.
//   * Only the id (public, `inv_...`) and `secret_hash = sha256(secret)` are persisted. The raw
//     secret NEVER touches the DB and is UNRECOVERABLE — a lost invite is re-minted, not looked up.
//   * verifyInvite does a CONSTANT-TIME compare of the hashes (timingSafeEqual over equal-length
//     buffers) so a wrong secret can't be teased apart byte-by-byte via timing.
// Minting needs no auth — it's a local operator action with DB access (same chicken-and-egg dodge
// as createKey): whoever can write the DB can already mint, so there's nothing to gate.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getDb, now } from './db.mjs';

// sha256 hex digest — the one-way function under which secrets are stored. Identical to the
// createHash('sha256').update(s).digest('hex') used for api_keys, so the storage shape matches.
function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Coerce an arbitrary maxUses input to a POSITIVE INTEGER or null (unlimited). Anything that isn't a
// finite, >= 1, integral number collapses to null rather than throwing — a malformed cap must never
// produce a row that can never (or always) be redeemed by accident.
function coerceMaxUses(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// Mint a new invite. Returns the FULL token exactly once; only the hash is stored.
//   id     = 'inv_' + 8 hex (public part, like mk_/acct_ ids)
//   secret = 48 hex (24 random bytes — same entropy as apiKeySecret)
//   token  = `${id}.${secret}` — what the invited node presents at register time.
export function createInvite({ label = null, maxUses = null, createdBy = null } = {}) {
  const d = getDb();
  const id = 'inv_' + randomBytes(4).toString('hex'); // 8 hex chars
  const secret = randomBytes(24).toString('hex');     // 48 hex chars
  const token = `${id}.${secret}`;
  const max = coerceMaxUses(maxUses);
  const createdAt = now();
  d.prepare(
    `INSERT INTO invites(id, secret_hash, label, max_uses, uses, revoked, created_by, created_at, last_used_at, last_used_by)
     VALUES(?,?,?,?,0,0,?,?,NULL,NULL)`
  ).run(id, sha256(secret), label || null, max, createdBy || null, createdAt);
  // The token is returned ONCE here and is otherwise unrecoverable — the caller must surface it now.
  return { id, token, label: label || null, maxUses: max, createdAt };
}

// List invites for the operator dashboard, newest first. NEVER returns secret_hash or any secret-
// derived field — only public/audit metadata.
export function listInvites() {
  return getDb()
    .prepare(
      `SELECT id, label, uses, max_uses, revoked, created_at, last_used_at, last_used_by
         FROM invites
        ORDER BY created_at DESC`
    )
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      uses: r.uses,
      maxUses: r.max_uses,
      revoked: r.revoked,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      lastUsedBy: r.last_used_by,
    }));
}

// Revoke an invite. Idempotent: revoking an already-revoked invite still reports ok:true. Only a
// missing id is an error. A revoked invite fails verifyInvite with reason 'revoked' forever after.
export function revokeInvite(id) {
  const res = getDb().prepare('UPDATE invites SET revoked=1 WHERE id=?').run(id);
  if (res.changes === 0) return { ok: false, id, error: 'not_found' };
  return { ok: true, id };
}

// The security-critical path. Validate a presented token and, on success, atomically bump its use
// count. Returns { ok:true, inviteId } or { ok:false, reason } and NEVER throws — every malformed or
// failed case is a clean { ok:false }. reason ∈
//   'malformed'  — token isn't a non-empty string containing a dot (or split yields empty parts)
//   'unknown'    — no invite with that id
//   'revoked'    — invite has been revoked
//   'exhausted'  — bounded invite has reached its max_uses
//   'bad_secret' — id exists but the secret doesn't match (constant-time checked)
export function verifyInvite(token, { workerId = null } = {}) {
  try {
    // 1. Shape: must be a non-empty string with a dot. Split on the FIRST dot so a secret that
    //    (improbably) contains a dot still rejoins correctly into id + secret.
    if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'malformed' };
    const dot = token.indexOf('.');
    if (dot < 1) return { ok: false, reason: 'malformed' };
    const id = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (!id || !secret) return { ok: false, reason: 'malformed' };

    const d = getDb();
    // 2. Look up by the public id (cheap, indexed PK). Absence is 'unknown'.
    const row = d.prepare('SELECT id, secret_hash, max_uses, uses, revoked FROM invites WHERE id=?').get(id);
    if (!row) return { ok: false, reason: 'unknown' };

    // 3. Revoked invites are dead.
    if (row.revoked) return { ok: false, reason: 'revoked' };

    // 4. Bounded invites that have hit their cap are exhausted (max_uses NULL = unlimited).
    if (row.max_uses != null && row.uses >= row.max_uses) return { ok: false, reason: 'exhausted' };

    // 5. CONSTANT-TIME secret check. Compare the sha256 of the presented secret against the stored
    //    hash over equal-length buffers — a length mismatch (e.g. a corrupt stored hash) short-circuits
    //    to bad_secret WITHOUT calling timingSafeEqual (which throws on unequal lengths).
    const a = Buffer.from(sha256(secret), 'hex');
    const b = Buffer.from(row.secret_hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_secret' };

    // 6. Success: record the redemption (use count + audit fields) and admit the node.
    d.prepare('UPDATE invites SET uses=uses+1, last_used_at=?, last_used_by=? WHERE id=?').run(
      now(), workerId || null, id
    );
    return { ok: true, inviteId: id };
  } catch {
    // Defense in depth: any unexpected error (bad hex in a tampered hash, etc.) is a clean reject,
    // never a thrown exception that could leak a stack or crash the register path.
    return { ok: false, reason: 'malformed' };
  }
}
