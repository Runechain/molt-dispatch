// verify_restart: the fix for "restart-tier knobs stay pending forever".
//   - applyStoredOverrides() loads persisted RESTART overrides into process.env at boot, BEFORE the
//     config getters / agents read it, so a restart actually applies what the operator set in the panel.
//   - POST /admin/restart is operator-gated (exits the process so ECS/supervisor reboots with the
//     overrides applied). We assert the auth gate but do NOT call it authed (it would exit this test).
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7102 node scripts/verify_restart.mjs

import './_env.mjs';
process.env.MOLT_AUTH = '1';

import assert from 'node:assert/strict';
import { startBroker } from '../src/broker/server.mjs';
import { setOverride, clearOverride, applyStoredOverrides } from '../src/broker/runtime-config.mjs';
import { BROKER, QUORUM } from '../src/shared/config.mjs';

const base = BROKER.url;
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  ' + m); pass++; };

try {
  delete process.env.MOLT_QUORUM_GRID;
  delete process.env.MOLT_DELIB_CHEAP;
  startBroker(); // boots, opens the DB, runs applyStoredOverrides once (nothing stored yet)

  ok(QUORUM.gridEnabled === false, 'baseline: quorum grid off, no override stored');

  // 1. a bool restart override is applied to process.env by applyStoredOverrides (boot-apply path)
  setOverride('quorumGridEnabled', true, { authed: true });
  const applied = applyStoredOverrides();
  ok(applied.includes('quorumGridEnabled'), 'applyStoredOverrides() reports quorumGridEnabled applied');
  ok(process.env.MOLT_QUORUM_GRID === '1', 'MOLT_QUORUM_GRID set to "1" from the stored override');
  ok(QUORUM.gridEnabled === true, 'QUORUM.gridEnabled getter now reads true (takes effect on restart)');

  // 2. a string restart override (provider) is applied too
  setOverride('delibCheap', 'deepseek', { authed: true });
  applyStoredOverrides();
  ok(process.env.MOLT_DELIB_CHEAP === 'deepseek', 'string restart override (delibCheap) applied to env');

  // 3. clearing the override + re-applying reverts (it is the override, not a stale env, that drives it)
  clearOverride('quorumGridEnabled', { authed: true });
  delete process.env.MOLT_QUORUM_GRID;
  const applied2 = applyStoredOverrides();
  ok(!applied2.includes('quorumGridEnabled'), 'a cleared override is no longer applied');
  ok(QUORUM.gridEnabled === false, 'reverts to off after clear + re-apply');

  // 4. the restart endpoint is operator-gated (401 unauthed). Not called authed — it exits the process.
  const res = await fetch(`${base}/admin/restart`, { method: 'POST' });
  ok(res.status === 401, 'POST /admin/restart unauthed -> 401 (operator-gated)');

  console.log(`\n✅ restart: ${pass} checks passed.`);
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
}
