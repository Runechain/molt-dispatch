// Admin read-aggregates — the cheap, read-only queries that back the operator slab.
//
// WHITEPAPER note. The admin panel needs three views the existing endpoints don't give in one shot:
//   1. the distributed DELIBERATION panels (quorum seats grouped by panel_id),
//   2. per-worker per-capability EARNED reputation, and
//   3. a single cheap SUMMARY the page can poll on a timer (worker counts, queue-by-capability,
//      fuel balance, readiness) without firing a fan of heavy queries every few seconds.
//
// Everything here is READ-ONLY and reuses the grid's existing primitives — getDb() for raw SQL,
// reputationFor() from reputation.mjs for the trust math, getBalance() from fuel.mjs for the ledger
// sum, the objective-deps helpers for the blocked/held sets, and cfg('workerStaleSeconds') so the
// liveness window tracks any live override the operator sets. We deliberately do NOT import
// server.mjs's readiness()/listWorkers(): server.mjs is the HTTP layer (heavy import-time wiring,
// owned by another agent) and importing it from a query module would invite a cycle. Instead we
// recompute the SAME heartbeat-derived liveness from the same columns, so this never disagrees with
// what claim() would actually do.

import { getDb } from './db.mjs';
import { reputationFor } from './reputation.mjs';
import { getBalance, PRIMARY_ACCOUNT } from './fuel.mjs';
import { objectivesWithUnsatisfiedDeps, objectivesOnHold } from './objective-deps.mjs';
import { cfg } from './runtime-config.mjs';

// Heartbeat-freshness cutoff (epoch ms). A worker last heard from before this is treated offline —
// identical rule to server.mjs's listWorkers/readiness, but sourced via cfg() so a live override to
// workerStaleSeconds is reflected here too.
function staleCutoff() {
  return Date.now() - cfg('workerStaleSeconds') * 1000;
}

/**
 * deliberationsView() -> Array<{ panel_id, created_at, seats }>.
 * Each distributed quorum run is a "panel": one or more `inference` jobs sharing a panel_id, each
 * tagged with its seat_role (the DAG node, e.g. 'rebut_realist'). Non-seat jobs have panel_id NULL
 * and never appear here. Grouped by panel_id, newest panel first; seats ordered by creation.
 *   seats: [{ seat_role, status, worker_id }]
 * Example:
 *   {
 *     panel_id: 'panel_7a3f',
 *     created_at: 1750000000000,
 *     seats: [
 *       { seat_role: 'open_pessimist', status: 'accepted', worker_id: 'w_abc' },
 *       { seat_role: 'rebut_realist',  status: 'claimed',  worker_id: 'w_def' },
 *     ],
 *   }
 */
export function deliberationsView() {
  const rows = getDb()
    .prepare(
      `SELECT panel_id, seat_role, status, assigned_worker_id, created_at
         FROM jobs
        WHERE panel_id IS NOT NULL
        ORDER BY created_at ASC`
    )
    .all();
  const panels = new Map();
  for (const r of rows) {
    let p = panels.get(r.panel_id);
    if (!p) {
      p = { panel_id: r.panel_id, created_at: r.created_at, seats: [] };
      panels.set(r.panel_id, p);
    }
    // A panel's created_at is its earliest seat (rows arrive in created_at order, so the first wins).
    p.seats.push({ seat_role: r.seat_role, status: r.status, worker_id: r.assigned_worker_id });
  }
  // Newest panel first for the operator's "what just ran" view.
  return [...panels.values()].sort((a, b) => b.created_at - a.created_at);
}

/**
 * reputationView() -> Array<{ worker_id, owner_id, capabilities }>.
 * Per-worker, the earned trust broken down per capability. Reuses reputationFor() (which itself uses
 * trustScore()) so the numbers match the scheduler/lifecycle gates exactly — no second trust formula.
 * Workers with zero reputation events still appear (empty capabilities array) so the panel shows the
 * full roster, not just workers that have done work.
 *   capabilities: [{ capability, trust, accepted, events }]
 * Example:
 *   {
 *     worker_id: 'w_abc',
 *     owner_id: 'player_42',
 *     capabilities: [
 *       { capability: 'inference', trust: 0.83, accepted: 9, events: 11 },
 *       { capability: 'code',      trust: 0.30, accepted: 0, events: 0 },
 *     ],
 *   }
 */
export function reputationView() {
  const workers = getDb()
    .prepare('SELECT id, owner_id FROM workers ORDER BY created_at ASC')
    .all();
  return workers.map((w) => ({
    worker_id: w.id,
    owner_id: w.owner_id ?? null,
    // reputationFor returns { capability, accepted, events, trust_score }; rename trust_score -> trust
    // for the panel's column while keeping the underlying value identical.
    capabilities: reputationFor(w.id).map((r) => ({
      capability: r.capability,
      trust: r.trust_score,
      accepted: r.accepted,
      events: r.events,
    })),
  }));
}

/**
 * adminSummary() -> the ONE cheap aggregate the page polls on a timer.
 * Bundles: worker counts (online/idle/busy/total via heartbeat freshness), the pending queue split
 * by capability, the fuel balance, and a readiness verdict (starved/draining/saturated/idle plus the
 * starving capability gaps). All from light COUNT/GROUP-BY scans — no per-job fan-out.
 * Example:
 *   {
 *     workers: { total: 3, online: 2, idle: 1, busy: 1, offline: 1 },
 *     queueByCapability: { inference: 4, code: 1, '(none)': 2 },
 *     fuel: { balance: 1200 },
 *     readiness: {
 *       ready: true, status: 'draining',
 *       jobs: { pending_total: 7, claimable_now: 5, saturated: 0, starved: 0, blocked: 2 },
 *       capability_gaps: [],
 *     },
 *   }
 */
export function adminSummary() {
  const d = getDb();
  const cutoff = staleCutoff();

  // ---- Workers: heartbeat-derived liveness (mirror of listWorkers/readiness) ----
  const workerRows = d
    .prepare('SELECT manifest_json, last_heartbeat, active_slots, max_slots FROM workers')
    .all();
  const online = [];
  for (const w of workerRows) {
    if ((w.last_heartbeat ?? 0) >= cutoff) {
      let caps = [];
      try { caps = JSON.parse(w.manifest_json || '{}').capabilities || []; } catch { /* ignore */ }
      online.push({ caps, hasSlot: (w.active_slots ?? 0) < (w.max_slots ?? 1) });
    }
  }
  const workers = {
    total: workerRows.length,
    online: online.length,
    idle: online.filter((w) => w.hasSlot).length,
    busy: online.filter((w) => !w.hasSlot).length,
    offline: workerRows.length - online.length,
  };

  // ---- Pending queue by capability (one GROUP BY) ----
  const queueByCapability = {};
  for (const row of d
    .prepare(
      "SELECT COALESCE(capability_required, '(none)') AS cap, COUNT(*) AS n FROM jobs WHERE status='pending' GROUP BY cap"
    )
    .all()) {
    queueByCapability[row.cap] = row.n;
  }

  // ---- Readiness: same starvation logic as server.readiness(), recomputed cheaply ----
  const capsOnline = new Set(online.flatMap((w) => w.caps));
  const capsWithSlot = new Set(online.filter((w) => w.hasSlot).flatMap((w) => w.caps));
  const anyOnline = online.length > 0;
  const anyWithSlot = online.some((w) => w.hasSlot);
  const someoneCanDo = (cap) => (cap ? capsOnline.has(cap) : anyOnline);
  const someoneFreeCanDo = (cap) => (cap ? capsWithSlot.has(cap) : anyWithSlot);

  const pending = d
    .prepare("SELECT id, objective_id, capability_required FROM jobs WHERE status='pending'")
    .all();
  const objBlocked = objectivesWithUnsatisfiedDeps();
  const objHeld = objectivesOnHold();
  const unmetDeps = d.prepare(
    `SELECT COUNT(*) AS n FROM job_dependencies jd JOIN jobs j ON j.id = jd.depends_on_job_id WHERE jd.job_id = ? AND j.status != 'accepted'`
  );

  const jobs = { pending_total: pending.length, claimable_now: 0, saturated: 0, starved: 0, blocked: 0 };
  const gaps = new Map();
  for (const job of pending) {
    if (objBlocked.has(job.objective_id) || objHeld.has(job.objective_id) || unmetDeps.get(job.id).n > 0) {
      jobs.blocked++;
      continue;
    }
    const cap = job.capability_required;
    if (!someoneCanDo(cap)) {
      jobs.starved++;
      const k = cap || '(none)';
      gaps.set(k, (gaps.get(k) || 0) + 1);
    } else if (!someoneFreeCanDo(cap)) {
      jobs.saturated++;
    } else {
      jobs.claimable_now++;
    }
  }
  const status = jobs.starved > 0 ? 'starved' : jobs.claimable_now > 0 ? 'draining' : jobs.saturated > 0 ? 'saturated' : 'idle';

  return {
    workers,
    queueByCapability,
    fuel: { balance: getBalance(PRIMARY_ACCOUNT) },
    readiness: {
      ready: jobs.starved === 0,
      status,
      jobs,
      capability_gaps: [...gaps.entries()].map(([capability, pending]) => ({ capability, pending })),
    },
  };
}
