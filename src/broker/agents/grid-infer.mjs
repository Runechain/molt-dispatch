// Grid-distributing infer — push the cheap debate seats out onto the heterogeneous grid while
// keeping the premium judge HOUSE-HELD inside the broker.
//
// deliberate.mjs is provider-agnostic: it calls an injected infer({tier,role,phase,system,prompt,
// panelId,seatKey}) -> {text,usage?} for every node and never knows where the work runs. This
// factory is one such infer. It splits by tier:
//
//   • tier:'premium'  → the JUDGE. Run it LOCALLY (localInfer), always. The judge is the single
//     funded adjudicator and the integrity anchor of the verdict — it is never handed to an
//     untrusted grid worker. "House-held": the house keeps the judge.
//   • tier:'cheap'    → a debater/skeptic SEAT. dispatchSeat() enqueues it as a plain `inference`
//     grid job (tagged with panelId/seatKey so it can be correlated/cancelled), collectSeat()
//     awaits its result, and we return that. Because runDag already topologically ordered the
//     seats before calling infer(), each seat is an INDEPENDENT job — no inter-seat deps to honor.
//
// FAIL-SAFE ETHOS (mirrors deliberate.mjs): a broken or slow grid path must NEVER break a
// decision. On seat timeout OR any throw from the grid callbacks, we fall back to localInfer —
// the same broker-local model that would have served the seat in the non-distributed build. The
// panel still completes; at worst a seat is served in-house instead of on the grid. The judge's
// fail-safe-to-escalate (deliberate.mjs) remains the final backstop above this.
//
// MOSTLY pure: it orchestrates injected callbacks and owns no server/scheduler state. The one
// concession is the LIVE seat-timeout read — makeGridInfer pulls the per-seat deadline from
// cfg('seatTimeoutMs') at each collectSeat call so an operator can retune it without restarting the
// broker. cfg() is itself side-effect-free at import (getDb is lazy), so wiring stays clean. The
// factory's seatTimeoutMs param is kept as the FALLBACK default for any non-registered/unit-test
// caller (and if the live read ever throws). The broker-substrate agent implements localInfer/
// dispatchSeat/collectSeat and calls makeGridInfer() to wire them together; deliberate.mjs emits
// the seats, this routes them.
//
// Injection contract:
//   localInfer({tier,role,phase,system,prompt}) -> {text,usage?}   — in-broker provider call.
//   dispatchSeat({panelId,seatKey,role,phase,system,prompt}) -> seatId   — enqueue cheap job, get id.
//   collectSeat({seatId,timeoutMs}) -> {text,usage} | null   — await completion, null on timeout.

import { cfg } from '../runtime-config.mjs';

/**
 * Build a grid-distributing infer for deliberate(): cheap seats go to the grid, the premium
 * judge stays in-broker, and every grid failure falls back to the broker-local model.
 *
 * @param {object}   o
 * @param {function} o.localInfer     async ({tier,role,phase,system,prompt}) => {text,usage?}
 * @param {function} o.dispatchSeat   async ({panelId,seatKey,role,phase,system,prompt}) => seatId
 * @param {function} o.collectSeat    async ({seatId,timeoutMs}) => {text,usage} | null
 * @param {number}   [o.seatTimeoutMs=8000]  per-seat collect deadline before broker-local fallback
 * @param {function} [o.log]
 * @returns {function} async infer ({tier,role,phase,system,prompt,panelId,seatKey}) => {text,usage?}
 */
export function makeGridInfer({ localInfer, dispatchSeat, collectSeat, seatTimeoutMs = 8000, log = () => {} }) {
  if (typeof localInfer !== 'function') throw new Error('makeGridInfer: localInfer is required');
  if (typeof dispatchSeat !== 'function') throw new Error('makeGridInfer: dispatchSeat is required');
  if (typeof collectSeat !== 'function') throw new Error('makeGridInfer: collectSeat is required');

  return async ({ tier, role, phase, system, prompt, panelId, seatKey }) => {
    // The judge is house-held — never distributed. Run it in-broker, unconditionally.
    if (tier === 'premium') {
      return localInfer({ tier, role, phase, system, prompt });
    }

    // Live seat deadline: read cfg('seatTimeoutMs') HERE (not at factory time) so an operator
    // override is honored on the next seat without a restart. Fall back to the factory param (the
    // boot/env default) if the live read is unavailable for any reason.
    let timeoutMs = seatTimeoutMs;
    try { timeoutMs = cfg('seatTimeoutMs'); } catch { /* keep factory default */ }

    // Cheap seat → distribute to the grid, with a broker-local fallback on timeout OR error.
    try {
      log(`[grid-infer] dispatch seat ${panelId}/${seatKey} (${role}/${phase})`);
      const seatId = await dispatchSeat({ panelId, seatKey, role, phase, system, prompt });
      const r = await collectSeat({ seatId, timeoutMs });
      if (r) {
        log(`[grid-infer] collected seat ${panelId}/${seatKey} (${seatId})`);
        return r;
      }
      // null === timeout. Don't strand the panel — serve this seat in-house.
      log(`[grid-infer] seat ${panelId}/${seatKey} timed out after ${timeoutMs}ms → broker-local fallback`);
      return localInfer({ tier, role, phase, system, prompt });
    } catch (err) {
      // A broken grid path must never break a decision — fall back to the broker-local model.
      log(`[grid-infer] seat ${panelId}/${seatKey} errored (${err?.message || err}) → broker-local fallback`);
      return localInfer({ tier, role, phase, system, prompt });
    }
  };
}
