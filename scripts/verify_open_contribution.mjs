// $0 verification that worker/contribution endpoints are NEVER auth-gated — anything can connect
// and do work in any configuration. Only operator/spend POSTs are gated (and only when MOLT_AUTH=1).

import assert from 'node:assert/strict';
import { requiresOperatorAuth } from '../src/broker/server.mjs';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

console.log('open contribution — worker endpoints never require auth');
for (const p of ['/workers/register', '/workers/heartbeat', '/jobs/claim', '/jobs/J-1/result', '/jobs/J-1/checkpoint']) {
  ok(requiresOperatorAuth('POST', p) === false, `POST ${p} is open (no key)`);
}

console.log('open contribution — reads are never gated');
for (const p of ['/objectives', '/workers', '/health', '/jobs']) {
  ok(requiresOperatorAuth('GET', p) === false, `GET ${p} is open`);
}

console.log('open contribution — operator/spend POSTs stay gated');
for (const p of ['/objectives', '/objectives/O-1/approve', '/objectives/O-1/release', '/github/import-issues', '/fuel/credit', '/payments/request']) {
  ok(requiresOperatorAuth('POST', p) === true, `POST ${p} is operator-gated`);
}

console.log(`\n✅ open contribution: ${passed} checks passed`);
