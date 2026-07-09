// Persisted join credential — the worker's local copy of the operator-issued join token.
//
// The grid's join gate (server.mjs registerWorker) admits a node that presents EITHER the shared
// MOLT_JOIN_SECRET or a valid per-node invite token (`inv_<id>.<secret>`, see invites.mjs). Until now
// the ONLY way a worker could present that token was the MOLT_JOIN_SECRET env var — so an invited
// operator had to re-export the token in every shell, every run. If they didn't, the worker registered
// with no token, the broker returned `join_denied`, and the node never appeared on the admin dashboard.
//
// This module gives the token a HOME on disk so it survives across runs: `molt worker join <token>`
// writes it here once, and the daemon reads it on every (re-)registration. It mirrors the agent-key
// persistence in agent-identity.mjs exactly:
//   * stored at PATHS.root/.molt-join.json (override with MOLT_JOIN_FILE), chmod 0600, gitignored.
//   * the file holds the RAW token because the worker must replay it verbatim to the broker on each
//     register — this is the node's own credential, not a server-side secret-at-rest (the broker only
//     ever stores the sha256 hash; see invites.mjs). Treat it like an API key: local-only, never commit.
//
// A missing/corrupt file is never fatal: load returns null, and the daemon falls back to MOLT_JOIN_SECRET
// (so existing env-based flows are byte-for-byte unchanged) or registers tokenless on an ungated grid.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PATHS } from '../shared/config.mjs';

// MOLT_JOIN_FILE relocates the store (tests point it at a temp path); default sits beside the agent key
// at the project root so the whole local install stays self-contained.
export function joinCredentialPath() {
  return process.env.MOLT_JOIN_FILE || join(PATHS.root, '.molt-join.json');
}

// Coerce/validate a token to a trimmed non-empty string, or null. We DON'T enforce the `inv_` shape —
// the same field also carries a shared MOLT_JOIN_SECRET, which is operator-chosen and has no fixed
// format. The broker is the authority on validity; we only refuse to persist obvious garbage (empty,
// whitespace, non-string).
export function normalizeToken(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  return t.length ? t : null;
}

// Persist the join token (0600), creating the parent dir if needed. Returns the path written.
// Throws only on a genuine filesystem failure — a bad token is rejected up front with a clear error so
// the CLI can tell the operator instead of silently writing nothing.
export function saveJoinToken(token, path = joinCredentialPath()) {
  const t = normalizeToken(token);
  if (!t) throw new Error('refusing to save an empty join token');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ token: t, savedAt: Date.now() }, null, 2));
  try { chmodSync(path, 0o600); } catch { /* best effort (e.g. Windows) */ }
  return path;
}

// Read the persisted token, or null if there is none / the file is unreadable. NEVER throws — a
// corrupt file behaves exactly like "no token saved" so a partial write can't wedge the worker.
export function loadJoinToken(path = joinCredentialPath()) {
  if (!existsSync(path)) return null;
  try {
    return normalizeToken(JSON.parse(readFileSync(path, 'utf8')).token);
  } catch {
    return null;
  }
}

// Forget the saved token (`molt worker leave`). Idempotent: clearing when nothing is saved is a no-op
// that still reports ok. Returns { ok, cleared } — cleared=false means there was nothing to remove.
export function clearJoinToken(path = joinCredentialPath()) {
  if (!existsSync(path)) return { ok: true, cleared: false };
  try { unlinkSync(path); return { ok: true, cleared: true }; }
  catch (e) { return { ok: false, cleared: false, error: e?.message || String(e) }; }
}

// The token the worker should present at registration, in precedence order:
//   1. MOLT_JOIN_SECRET env (explicit, ephemeral, highest priority — unchanged legacy behavior)
//   2. the persisted credential from `molt worker join`
//   3. null — register tokenless (fine on an ungated grid; rejected on a gated one)
// Centralized here so the daemon and any future caller agree on the resolution rule.
export function resolveJoinToken() {
  return normalizeToken(process.env.MOLT_JOIN_SECRET) || loadJoinToken() || null;
}
