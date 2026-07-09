// Unit test for the PERSISTED JOIN CREDENTIAL (src/worker/join-credential.mjs) — the on-disk home for
// the operator-issued join token that `molt worker join` writes and the worker daemon replays on every
// registration. Before this existed the token could only come from MOLT_JOIN_SECRET, so an invited node
// had to re-export it every run or be silently rejected (`join_denied`) and never show on the dashboard.
//
// We point MOLT_JOIN_FILE at a temp path so the test never touches a real ~/.molt-join.json, then drive
// the module's public surface directly (no broker needed): save -> load roundtrip, the MOLT_JOIN_SECRET
// env precedence, clear/idempotency, empty-token rejection, and corrupt-file tolerance.
//
//   node scripts/verify_join_credential.mjs

import './_env.mjs'; // sets MOLT_DATA_DIR/MOLT_PORT before config is read (PATHS resolves cleanly)

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`ok  ${msg}`); pass++; };

// Isolate the credential file in a temp dir BEFORE importing the module (joinCredentialPath reads the
// env each call, but pinning it up front keeps every check pointed at the same throwaway file).
const dir = mkdtempSync(join(tmpdir(), 'molt-join-'));
process.env.MOLT_JOIN_FILE = join(dir, '.molt-join.json');
delete process.env.MOLT_JOIN_SECRET; // start from a clean precedence baseline

const cred = await import('../src/worker/join-credential.mjs');

try {
  // 1. Nothing saved yet -> load is null, resolve is null.
  ok(cred.loadJoinToken() === null, '1. loadJoinToken() is null when no credential is saved');
  ok(cred.resolveJoinToken() === null, '1. resolveJoinToken() is null with no env and no file');

  // 2. Save -> the token survives a load (this is the whole point: persistence across runs).
  const token = 'inv_4a609820.16f495549c8aeddef90a76eeb9dd51e334f8480b885db750';
  const path = cred.saveJoinToken(token);
  ok(path === process.env.MOLT_JOIN_FILE, '2. saveJoinToken writes to MOLT_JOIN_FILE');
  ok(existsSync(path), '2. the credential file exists after save');
  ok(cred.loadJoinToken() === token, '2. loadJoinToken() returns the exact token that was saved');
  ok(cred.resolveJoinToken() === token, '2. resolveJoinToken() falls back to the persisted token');

  // 3. Whitespace is trimmed on save (so a pasted token with a trailing newline still matches).
  cred.saveJoinToken('  inv_pad.ded  \n');
  ok(cred.loadJoinToken() === 'inv_pad.ded', '3. a padded token is trimmed before persisting');
  cred.saveJoinToken(token); // restore for later checks

  // 4. MOLT_JOIN_SECRET env takes PRECEDENCE over the saved file (explicit beats persisted).
  process.env.MOLT_JOIN_SECRET = 'env-shared-secret';
  ok(cred.resolveJoinToken() === 'env-shared-secret', '4. MOLT_JOIN_SECRET overrides the saved token');
  delete process.env.MOLT_JOIN_SECRET;
  ok(cred.resolveJoinToken() === token, '4. removing the env var falls back to the saved token again');

  // 5. Empty / non-string tokens are refused at the door (never persist garbage).
  assert.throws(() => cred.saveJoinToken('   '), /empty join token/, '5. saving whitespace throws');
  assert.throws(() => cred.saveJoinToken(null), /empty join token/, '5. saving null throws');
  ok(cred.loadJoinToken() === token, '5. a rejected save leaves the previously-saved token intact');

  // 6. A corrupt file behaves exactly like "nothing saved" — never throws, so a partial write can't
  //    wedge the worker.
  writeFileSync(path, '{ this is not json');
  ok(cred.loadJoinToken() === null, '6. a corrupt credential file loads as null (no throw)');

  // 7. clear() is idempotent and removes the file.
  cred.saveJoinToken(token);
  const c1 = cred.clearJoinToken();
  ok(c1.ok && c1.cleared === true, '7. clearJoinToken() removes an existing credential (cleared:true)');
  ok(!existsSync(path), '7. the credential file is gone after clear');
  const c2 = cred.clearJoinToken();
  ok(c2.ok && c2.cleared === false, '7. clearing again is a no-op (ok:true, cleared:false)');

  console.log(`\n✅ join-credential: ${pass} checks passed.`);
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
}
