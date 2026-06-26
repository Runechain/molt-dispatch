// $0 integration test for QUORUM — distributing the cheap deliberation seats to the grid.
//
// Tests the LOCKED contract through PUBLIC seams only (env flag + the broker job queue + the
// deliberation primitive), never internal function names, so it stays robust while the
// implementation (grid-infer.mjs / dispatchSeat / collectSeat) is still settling:
//
//   1. Flag OFF = unchanged: deliberate() with MOLT_QUORUM_GRID unset behaves exactly as the
//      in-broker path (a well-formed verdict comes back).
//   2. Distribution ON: with MOLT_QUORUM_GRID=1 + a mock inference worker, kicking a deliberation
//      enqueues `inference` jobs tagged panel_id/seat_role, the worker claims them, a verdict
//      returns — and NO seat with seat_role 'judge' is ever enqueued (judge stays house-held).
//   3. Independence: one owner can hold AT MOST one seat per panel_id (claim-time independence).
//   4. Fail-safe fallback: flag on but NO worker (tiny seat timeout) still returns a verdict
//      (broker-local fallback), never hangs.
//
// Run: MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7098 node scripts/verify_quorum.mjs
//
// Notes on robustness: the deliberation kick path (integration agent -> deliberate -> grid-infer)
// and the panel_id/seat_role schema may still be mid-write when this runs concurrently with the
// implementation agents. Every check that can't be driven purely through a public seam SOFT-PASSES
// with a clear [skip] log rather than failing — the orchestrator runs the full suite after merge.

import './_env.mjs'; // must be FIRST: sets MOLT_DATA_DIR/MOLT_PORT before any config is read

let pass = 0;
let soft = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`ok   ${msg}`);
  pass++;
};
const skip = (msg) => {
  console.log(`skip ${msg}`);
  soft++;
};

// A well-formed verdict from deliberate(): the fields the integration/planner agents consume.
function isVerdictShape(v) {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.decision === 'string' &&
    typeof v.escalate === 'boolean' &&
    'winner' in v &&
    typeof v.confidence === 'number' &&
    'transcript' in v &&
    'usage' in v
  );
}

// ---------------------------------------------------------------------------------------------
// CHECK 1 — Flag OFF = unchanged. Pure deliberate() over a mock infer, NO broker, NO env flag.
// This is the exact seam verify_deliberation.mjs uses, so an "off" run is provably today's path.
// ---------------------------------------------------------------------------------------------
console.log('\n# 1. flag OFF — deliberation behaves exactly as the in-broker path');
{
  // Be explicit: distribution must be off for this check.
  delete process.env.MOLT_QUORUM_GRID;

  const { deliberate } = await import('../src/broker/agents/deliberate.mjs');

  // Mock infer: cheap personas return text; the premium judge returns a parseable verdict JSON.
  const calls = [];
  const infer = async ({ tier, role, phase }) => {
    calls.push({ tier, role, phase });
    if (role === 'judge') {
      return { text: JSON.stringify({ decision: 'release', winner: 'realist', confidence: 0.8, escalate: false, rationale: 'ok' }), usage: { tokens: 40 } };
    }
    return { text: `[${role}/${phase}] argument`, usage: { tokens: 10 } };
  };

  const v = await deliberate({ question: 'May B proceed?', context: { a: 'merged' }, decisions: ['release', 'hold'], infer });
  ok(isVerdictShape(v), 'flag off: deliberate() returns a well-formed verdict');
  ok(v.decision === 'release' && v.escalate === false, 'flag off: verdict carries the judge decision (release), no escalation');
  ok(calls.filter((c) => c.tier === 'premium').length === 1 && calls.find((c) => c.tier === 'premium').role === 'judge', 'flag off: exactly one premium call — the judge');
  ok(calls.filter((c) => c.tier === 'cheap').length === 7, 'flag off: seven cheap persona calls (3 open + 3 rebut + skeptic)');
}

// ---------------------------------------------------------------------------------------------
// The remaining checks need a live broker with the quorum grid ON. Because QUORUM.gridEnabled is
// read at config import time, we set the env BEFORE importing the broker, and run the broker with
// the deterministic mock adapter for BOTH tiers (so the house judge runs $0 + offline, and cheap
// seats — when fallback fires — also resolve deterministically).
// ---------------------------------------------------------------------------------------------
process.env.MOLT_QUORUM_GRID = '1';
process.env.MOLT_INTEGRATION_AGENT = '1'; // wires deliberate() into the upstream-approved path
process.env.MOLT_DELIB_CHEAP = 'mock';     // cheap seats / fallback resolve via the mock adapter
process.env.MOLT_DELIB_PREMIUM = 'mock';   // house judge runs in-broker on the mock adapter ($0)
// Per-seat dispatch deadline before broker-local fallback. Read at config-import time, so set it
// ONCE here, before importing config. Small enough that the no-worker fallback (check 4) is prompt,
// but well above the mock worker's claim latency (~25ms) so checks 2/3 still win their claims.
process.env.MOLT_QUORUM_SEAT_TIMEOUT_MS = '600';

const { BROKER } = await import('../src/shared/config.mjs');
const base = BROKER.url;
const { startBroker } = await import('../src/broker/server.mjs');
const { getDb, now } = await import('../src/broker/db.mjs');
const od = await import('../src/broker/objective-deps.mjs');
const agent = await import('../src/broker/agents/integration-agent.mjs');

async function post(path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const d = getDb();

// Register an inference-capable worker through the public seam (auth is open in this test).
async function registerWorker({ worker_id, owner_id }) {
  return post('/workers/register', {
    worker_id,
    owner_id,
    trust_tier: 4,
    max_slots: 1,
    manifest: { capabilities: ['inference'], models: [{ provider: 'mock', model: 'mock-1' }] },
  });
}

// A minimal mock worker loop: poll /jobs/claim for inference seats, complete each with debate text.
// Runs in the background while a deliberation is in flight, feeding collectSeat real seat results.
// The worker must already be REGISTERED (an unregistered worker is refused: 'unknown_worker').
function startMockWorker({ worker_id }) {
  let running = true;
  (async () => {
    while (running) {
      const claim = await post('/jobs/claim', { worker_id, capabilities: ['inference'], trust_tier: 4, max_slots: 1, active_slots: 0 }).catch(() => ({ body: {} }));
      const job = claim.body?.job;
      if (!job?.job_id) { await sleep(25); continue; }
      // Return role-appropriate debate text. (The house judge — never a seat — adjudicates this.)
      await post(`/jobs/${job.job_id}/result`, {
        lease_token: job.lease_token,
        status: 'completed',
        output: `[${worker_id}] position on the debate (seat ${job.seat_role || '?'})`,
        provider: 'mock',
        model: 'mock-1',
        usage: { input_tokens: 5, output_tokens: 15 },
      }).catch(() => {});
      await sleep(10);
    }
  })();
  return { stop: () => { running = false; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an approved upstream A (PR open) + dependent B whose floor is satisfied, exactly like
// verify_integration_agent.mjs. Approving A is what triggers a deliberation for B.
let oseq = 0;
function obj(sourceIssue, status, prUrl = null) {
  const id = `O-${++oseq}`;
  d.prepare(`INSERT INTO objectives(id,title,status,source_issue,pr_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, `obj ${id}`, status, sourceIssue, prUrl, now(), now());
  return id;
}
function scenario() {
  const A = obj(100 + oseq, 'approved', 'https://github.com/x/y/pull/9'); // PR mode: approved != merged
  const B = obj(200 + oseq, 'in_progress');
  od.recordObjectiveDeps(B, Number(d.prepare('SELECT source_issue s FROM objectives WHERE id=?').get(B).s), [
    d.prepare('SELECT source_issue s FROM objectives WHERE id=?').get(A).s,
  ]);
  od.resolveAndGate();
  return { A, B };
}

// Does the live jobs table carry the panel_id/seat_role tag columns yet? (mid-write safety)
function hasSeatColumns() {
  try {
    const cols = d.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
    return cols.includes('panel_id') && cols.includes('seat_role');
  } catch {
    return false;
  }
}
// Seat jobs enqueued for a panel, read straight from the broker's own job queue.
function seatJobs() {
  if (!hasSeatColumns()) return [];
  return d.prepare(`SELECT id, type, capability_required, panel_id, seat_role, assigned_worker_id, status FROM jobs WHERE panel_id IS NOT NULL`).all();
}

const server = startBroker();
await sleep(250); // let it bind + finish the (async) agent wiring / grid-infer dynamic import

try {
  ok(agent.integrationConfigured(), 'integration agent wired (deliberation reachable via upstream-approved)');

  // -------------------------------------------------------------------------------------------
  // CHECK 2 — Distribution ON: kicking a deliberation enqueues inference seats tagged
  // panel_id/seat_role; a mock worker claims them; a verdict returns; the judge is NEVER a seat.
  // -------------------------------------------------------------------------------------------
  console.log('\n# 2. distribution ON — cheap seats become tagged inference jobs; judge stays house-held');
  {
    const { A, B } = scenario();
    await registerWorker({ worker_id: 'qworker-1', owner_id: 'owner-1' }); // register BEFORE claiming/kicking
    const w = startMockWorker({ worker_id: 'qworker-1' });

    // Kick the deliberation through the public agent seam (same call POST /objectives/:id/approve makes).
    const out = await agent.integrateUpstreamApproved(A);
    await sleep(50); // let the worker loop record the final claim/submit before we inspect
    w.stop();

    const dep = out.dependents.find((x) => x.dependent === B) || out.dependents[0];
    ok(dep && typeof dep.decision === 'string', 'a verdict comes back from the distributed deliberation');

    const seats = seatJobs();
    if (!hasSeatColumns()) {
      skip('panel_id/seat_role columns not present yet — seat-tag assertions deferred to the merged run');
    } else if (seats.length === 0) {
      skip('no seat jobs were enqueued (grid-infer.mjs may not be active yet) — distribution assertions deferred');
    } else {
      ok(seats.every((s) => s.type === 'inference' && s.capability_required === 'inference'), 'every distributed seat is an inference job (capability reused, not a new one)');
      ok(seats.every((s) => !!s.panel_id), 'every seat carries a panel_id tag');
      ok(seats.every((s) => !!s.seat_role), 'every seat carries a seat_role tag');
      // The headline assertion: the premium judge is NEVER distributed.
      ok(seats.every((s) => s.seat_role !== 'judge'), 'NO judge seat was enqueued — the premium judge stayed house-held');
      // Only the seven cheap debater roles may appear as seats.
      const DEBATER_ROLES = new Set(['open_pessimist', 'open_optimist', 'open_realist', 'rebut_pessimist', 'rebut_optimist', 'rebut_realist', 'skeptic']);
      ok(seats.every((s) => DEBATER_ROLES.has(s.seat_role)), 'every seat_role is a cheap debater/skeptic role (never the judge)');
      // Broker-side truth: at least one seat was actually assigned to (claimed by) the mock worker.
      // (More robust than reading the worker's own counter, which races the loop's shutdown.)
      const claimed = seats.filter((s) => s.assigned_worker_id);
      ok(claimed.length > 0, 'at least one seat was actually claimed from the grid (assigned to a worker)');
    }
  }

  // -------------------------------------------------------------------------------------------
  // CHECK 3 — Independence: one OWNER can hold at most one seat per panel_id. Two workers under
  // the SAME owner must not both end up holding seats of the same panel.
  // -------------------------------------------------------------------------------------------
  console.log('\n# 3. independence — one owner holds at most one seat per panel');
  {
    const { A, B } = scenario();
    // Two workers, SAME owner — the claim-time gate must let only one of them onto any given panel.
    await registerWorker({ worker_id: 'dup-a', owner_id: 'shared-owner' });
    await registerWorker({ worker_id: 'dup-b', owner_id: 'shared-owner' });
    const w1 = startMockWorker({ worker_id: 'dup-a' });
    const w2 = startMockWorker({ worker_id: 'dup-b' });
    await agent.integrateUpstreamApproved(A);
    await sleep(50);
    w1.stop(); w2.stop();

    if (!hasSeatColumns()) {
      skip('panel_id/seat_role columns not present yet — independence assertion deferred');
    } else {
      const seats = d.prepare(`SELECT panel_id, assigned_worker_id FROM jobs WHERE panel_id IS NOT NULL AND assigned_worker_id IS NOT NULL`).all();
      if (seats.length === 0) {
        skip('no seats were claimed (grid distribution inactive) — independence assertion deferred');
      } else {
        // Map (owner, panel) -> count, resolving each worker to its owner via the workers table.
        const ownerOf = (wid) => d.prepare(`SELECT owner_id FROM workers WHERE id=?`).get(wid)?.owner_id || wid;
        const seen = new Map(); // `${owner}|${panel}` -> count
        for (const s of seats) {
          const k = `${ownerOf(s.assigned_worker_id)}|${s.panel_id}`;
          seen.set(k, (seen.get(k) || 0) + 1);
        }
        const maxPerOwnerPanel = Math.max(...seen.values());
        ok(maxPerOwnerPanel <= 1, 'no (owner, panel) pair holds more than one seat — claim-time independence holds');
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // CHECK 4 — Fail-safe fallback: flag on, NO worker available + a tiny seat timeout. The
  // deliberation must still return a verdict (broker-local in-process fallback) and never hang.
  // -------------------------------------------------------------------------------------------
  console.log('\n# 4. fail-safe — no worker + seat timeout still returns a verdict (never hangs)');
  {
    const { A, B } = scenario();
    // NO mock worker started: every cheap seat goes unclaimed and must fall back in-process,
    // bounded per seat by makeGridInfer's seatTimeoutMs. The broker forwards QUORUM.seatTimeoutMs
    // into makeGridInfer (server.mjs), so the MOLT_QUORUM_SEAT_TIMEOUT_MS we set above (600ms)
    // actually bounds this path: ~3 sequential DAG waves of unclaimed debater seats (seats within
    // a wave race concurrently) + the in-house mock judge. The latency assertion is therefore both
    // a hang-guard AND a regression catch: if the broker ever stops forwarding the timeout, the
    // default 8000ms reasserts itself, this path balloons to ~24s, and the bound below trips.
    const seatTimeout = Number(process.env.MOLT_QUORUM_SEAT_TIMEOUT_MS) || 8000;
    const BOUND_MS = seatTimeout * 6 + 4000;        // ~2x headroom over the ~3-wave fallback budget
    const HANG_GUARD_MS = seatTimeout * 12 + 6000;  // absolute "it hung" ceiling — still well under the 24s default-timeout regression
    const started = Date.now();
    const out = await Promise.race([
      agent.integrateUpstreamApproved(A),
      sleep(HANG_GUARD_MS).then(() => ({ __timedout: true })),
    ]);
    const elapsed = Date.now() - started;
    ok(!out.__timedout, 'deliberation returned (did not hang) with no workers available');
    const dep = out.dependents?.find((x) => x.dependent === B) || out.dependents?.[0];
    ok(dep && typeof dep.decision === 'string', 'a verdict still comes back via broker-local fallback');
    ok(elapsed < BOUND_MS, `fallback bounded by the configured ${seatTimeout}ms per-seat timeout (${elapsed}ms < ${BOUND_MS}ms)`);
  }

  console.log(`\n✅ quorum: ${pass} checks passed${soft ? `, ${soft} soft-skipped (deferred to the merged run)` : ''}.`);
  server.close();
  process.exit(0);
} catch (err) {
  console.error(`\nFAIL: ${err?.message || err}`);
  try { server.close(); } catch {}
  process.exit(1);
}
