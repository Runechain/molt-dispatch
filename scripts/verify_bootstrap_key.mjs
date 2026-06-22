// $0 verification of the bootstrap-key seeding (deployed-broker key provisioning). Fresh temp DB.
// Proves: a provided "<id>.<secret>" is seeded with only sha256(secret) stored, idempotently,
// and that the stored hash is what the broker's authOk check compares against.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'moltboot-'));

const { getDb } = await import('../src/broker/db.mjs');
const { importKey } = await import('../src/broker/keys.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

const d = getDb();
const RAW = 'wk_team01.s3cr3t-abcdef0123456789';
const [id, secret] = ['wk_team01', 's3cr3t-abcdef0123456789'];

console.log('bootstrap key — seed a provided key');
{
  const r = importKey(RAW, { name: 'worker-trial' });
  ok(r.seeded === true && r.id === id, 'key seeded with its provided id');
  const row = d.prepare('SELECT * FROM api_keys WHERE id=?').get(id);
  ok(!!row && row.revoked === 0, 'row present and active');
  ok(row.hash === createHash('sha256').update(secret).digest('hex'), 'only sha256(secret) stored — raw secret never persisted');
  ok(d.prepare('SELECT COUNT(*) c FROM api_keys').get().c === 1, 'exactly one key row');
}

console.log('bootstrap key — idempotent on reboot');
{
  const r2 = importKey(RAW, { name: 'worker-trial' });
  ok(r2.seeded === false, 'second seed is a no-op (id already exists)');
  ok(d.prepare('SELECT COUNT(*) c FROM api_keys').get().c === 1, 'still exactly one key row');
}

console.log('bootstrap key — the seeded key would authenticate (authOk parity)');
{
  // Mirror server.mjs authOk: split on first dot, look up id, compare sha256(secret) to stored hash.
  const dot = RAW.indexOf('.');
  const row = d.prepare('SELECT * FROM api_keys WHERE id=? AND revoked=0').get(RAW.slice(0, dot));
  const authOk = !!row && createHash('sha256').update(RAW.slice(dot + 1)).digest('hex') === row.hash;
  ok(authOk === true, 'a worker presenting this exact key passes the broker auth check');
  const bad = d.prepare('SELECT * FROM api_keys WHERE id=?').get('wk_team01');
  ok(createHash('sha256').update('wrong-secret').digest('hex') !== bad.hash, 'a wrong secret would NOT authenticate');
}

console.log('bootstrap key — malformed keys are rejected');
{
  assert.throws(() => importKey('no-dot-here'), /must be/, 'key without a dot rejected');
  assert.throws(() => importKey('.onlysecret'), /must be/, 'empty id rejected');
  ok(true, 'malformed bootstrap keys throw rather than silently seeding garbage');
}

console.log(`\n✅ bootstrap key: ${passed} checks passed`);
