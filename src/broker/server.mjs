// The broker: the grid's control plane. Pull-based — workers ask for work (WHITEPAPER §5).
// Zero-dep node:http. Endpoints follow §11; read endpoints feed the dashboard.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { getDb, now, nextSeq, logEvent, parseRow, transaction, subscribeEvents } from './db.mjs';
import { objectiveId as mkObjectiveId, workerId as mkWorkerId, jobId as mkJobId, leaseToken, checkpointId } from '../shared/ids.mjs';
import { BROKER, DEFAULTS, PATHS, FUEL, GAME, QUORUM, JOIN } from '../shared/config.mjs';
import { verifyAgentClaim } from './agent-verify.mjs';
import { createInvite, listInvites, revokeInvite, verifyInvite } from './invites.mjs';
import { applyStoredOverrides } from './runtime-config.mjs'; // boot-apply persisted restart overrides
import { planObjective } from './planner.mjs';
import { pickJob, workerOffersBedrock } from './scheduler.mjs';
import { onResult } from './lifecycle.mjs';
import { reputationFor, recordEvent } from './reputation.mjs';
import { buildResultCtx, approveObjective } from './broker-ops.mjs';
import { listIssues } from './gh.mjs';
import { parseDependencyIssues, recordObjectiveDeps, resolveAndGate, unsatisfiedDepsFor, clearObjectiveHold, clearNeedsReview, applyObjectiveGatingStatus, objectivesWithUnsatisfiedDeps, objectivesOnHold } from './objective-deps.mjs';
import { setIntegrationInfer } from './agents/integration-agent.mjs';
import { setPlannerInfer } from './agents/planner-agent.mjs';
import { importKey } from './keys.mjs';
import { makeProviderInfer } from './agents/deliberate.mjs';
import { getAdapter } from '../worker/adapters/index.mjs';
import { getBalance, creditFuel, fuelLog, reserveFuel, refundFuel, estimateJobCost, estimateCost, chargeFuel, PRIMARY_ACCOUNT, recordPayout } from './fuel.mjs';
import { verifyPayment, settlePayment, buildPaymentRequirement, centsToMicro, extractPaymentHeader } from './payments/x402.mjs';
// Admin control-plane modules (runtime-config.mjs + admin-queries.mjs) are built by a sibling
// agent. We load them via the SAME guarded dynamic-import pattern this file already uses for
// grid-infer.mjs (see maybeEnableAgents): a hard `import ... from './runtime-config.mjs'` would
// crash the WHOLE broker at module-eval time if the file hasn't landed yet, taking every existing
// route down with it. Instead we lazily import both at boot into these holders. Until the modules
// exist the holders stay null and the /admin + /deliberations + /reputation routes return a 500
// JSON (their defensive wrappers); the moment the sibling's files land, the routes activate with no
// further change here. The PINNED contract these expose:
//   runtime-config.mjs: getConfigSnapshot({authed}) -> [knob], setOverride(key,val,{authed}) -> {ok,...}
//   admin-queries.mjs:  deliberationsView() -> [...], reputationView() -> [...], adminSummary() -> {...}
let getConfigSnapshot = null;
let setOverride = null;
let cfgFn = null; // runtime-config cfg() — lets the premium budget gate honor a live minBalance override
let deliberationsView = null;
let reputationView = null;
let adminSummary = null;
async function loadAdminModules() {
  try {
    const cfg = await import('./runtime-config.mjs');
    getConfigSnapshot = cfg.getConfigSnapshot || null;
    setOverride = cfg.setOverride || null;
    cfgFn = cfg.cfg || null;
  } catch (e) {
    console.log(`[broker] runtime-config.mjs unavailable (${e.message}); /admin/config inactive until it lands`);
  }
  try {
    const aq = await import('./admin-queries.mjs');
    deliberationsView = aq.deliberationsView || null;
    reputationView = aq.reputationView || null;
    adminSummary = aq.adminSummary || null;
  } catch (e) {
    console.log(`[broker] admin-queries.mjs unavailable (${e.message}); /admin/summary,/deliberations,/reputation inactive until it lands`);
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Ingress caps: an unbounded request body is an OOM lever for an anonymous caller. Cap the
// cumulative bytes and bound the read with a socket timeout so a slow-loris stall can't pin a
// connection forever. A 413 is surfaced via a sentinel the router translates to a response.
const MAX_BODY_BYTES = 1_000_000;
const BODY_TIMEOUT_MS = 30_000;
const BODY_TOO_LARGE = Symbol('body_too_large');

function readBody(req) {
  // Explicit event handling (not `for await`): once the cap is hit we resolve BODY_TOO_LARGE but
  // KEEP a no-op data listener so the rest of the in-flight upload drains to the floor and the
  // socket can close cleanly (connection:close). Mixing `for await` with a manual pause/drain
  // races and can hang keep-alive clients, so we own the lifecycle here.
  return new Promise((resolve) => {
    req.setTimeout(BODY_TIMEOUT_MS);
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    req.on('data', (c) => {
      if (done) return; // already over cap / resolved — drain remaining chunks to the floor
      size += c.length;
      if (size > MAX_BODY_BYTES) return finish(BODY_TOO_LARGE);
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return finish({});
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish({}); }
    });
    req.on('timeout', () => finish(BODY_TOO_LARGE));
    req.on('error', () => finish({}));
  });
}

// ---- Rate limiting -----------------------------------------------------------
// Dependency-free, in-memory token-ish window keyed by source IP AND worker_id. Anonymous/open
// ingress (workers and jobs) is the abuse surface: a single source or a single forged worker_id
// could flood register/claim/heartbeat. Buckets prune so the map can't grow unbounded.
const RATE = {
  windowMs: Number(process.env.MOLT_RATE_WINDOW_MS || 10_000),
  max: Number(process.env.MOLT_RATE_MAX || 60), // requests per key per window
  maxConcurrentClaims: Number(process.env.MOLT_MAX_CONCURRENT_CLAIMS || 32),
};
const rateBuckets = new Map(); // key -> { count, resetAt }
let inflightClaims = 0;

function pruneRateBuckets(t) {
  for (const [k, b] of rateBuckets) if (b.resetAt <= t) rateBuckets.delete(k);
}

// Returns true if the key is OVER its window budget (i.e. the request should be rejected).
function rateLimited(key) {
  const t = Date.now();
  if (rateBuckets.size > 4096) pruneRateBuckets(t); // opportunistic prune
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= t) {
    b = { count: 0, resetAt: t + RATE.windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return b.count > RATE.max;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Rate-limit the open ingress surface (POST /workers/* and /jobs/*) by the asserted worker_id, so a
// forged id flooding from rotating IPs is still throttled. The IP dimension is checked separately
// (pre-body) in the router. Returns a 429 sentinel object (or null when allowed).
function checkIngressRate(req, path, body) {
  if (!/^\/(workers|jobs)\b/.test(path)) return null;
  const wid = (body && typeof body.worker_id === 'string') ? body.worker_id.slice(0, 64) : '-';
  if (rateLimited(`wid:${wid}`)) {
    return { error: 'rate limit exceeded', code: 429 };
  }
  return null;
}

// ---- Route handlers ----------------------------------------------------------

const MAX_SLOTS_PER_WORKER = 8; // server cap — a worker cannot self-declare unbounded concurrency

// A client-supplied worker_id must be a constrained slug — never trusted verbatim. A raw id can
// otherwise carry path/SQL-adjacent metacharacters, control bytes, or megabyte payloads that leak
// into branch names (`grid/<id>`), worktree paths, and event logs. Slugify to the safe charset and
// length; if nothing survives, mint a fresh server-side id.
function constrainWorkerId(raw, ownerId) {
  if (typeof raw === 'string') {
    const slug = raw
      .replace(/[^A-Za-z0-9._:-]/g, '-') // safe charset only
      .replace(/\.{2,}/g, '-') // never '..' — no path/git-ref traversal if worker_id is ever interpolated into a path
      .slice(0, 64)
      .replace(/^[-.]+|[-.]+$/g, ''); // no leading/trailing dot or dash
    if (slug) return slug;
  }
  return mkWorkerId(ownerId || 'worker');
}

// Constant-time check of a presented join token against the configured join secret. False for any
// non-string / length mismatch (timingSafeEqual requires equal-length buffers).
function joinTokenOk(token) {
  if (typeof token !== 'string' || !JOIN.secret) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(JOIN.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function registerWorker(body) {
  const d = getDb();
  // Join gate (the real lock on "who can join"): the gate is ON when a shared secret is configured OR
  // invite-only mode is enabled. A registration passes by presenting EITHER a matching shared token
  // (constant-time compared) OR a valid per-node invite token (single/multi-use, recorded on success).
  // Enforced REGARDLESS of MOLT_OPEN_GRID so open mode can't bypass it; the public `molt go` flow is
  // inert without a credential. Layers on top of the identity claim below. A valid invite's id is
  // remembered so we can attribute the worker to it after the row is upserted.
  const gateOn = !!JOIN.secret || JOIN.requireInvite;
  let inviteId = null;
  if (gateOn) {
    const tok = body && body.join_token;
    if (JOIN.secret && joinTokenOk(tok)) { /* shared secret accepted */ }
    else {
      const v = verifyInvite(tok, { workerId: body && body.worker_id });
      if (!v.ok) return { ok: false, error: 'join_denied' };
      inviteId = v.inviteId;
    }
  }
  // Identity: when the grid requires claimed agents, verify the signed agent credential with the
  // game (relying-party). The bound game account becomes the worker's owner so reputation/stake
  // accrue per ACCOUNT, not per keypair. Trust is still EARNED — verify-don't-trust still holds.
  if (GAME.requireIdentity) {
    const v = await verifyAgentClaim(body.agent, { now: now() });
    if (!v.ok) return { ok: false, error: v.error };
    body = { ...body, owner_id: 'acct:' + v.accountId };
  }
  const id = body.worker_id ? constrainWorkerId(body.worker_id, body.owner_id) : mkWorkerId(body.owner_id || 'worker');
  const existing = d.prepare('SELECT id FROM workers WHERE id = ?').get(id);
  const manifest = body.manifest || { capabilities: body.capabilities, interfaces: body.interfaces };
  const maxSlots = Math.max(1, Math.min(Number(body.max_slots) || 1, MAX_SLOTS_PER_WORKER));
  if (existing) {
    // trust_tier is NEVER set from the client — trust is EARNED via reputation, not declared.
    d.prepare(
      `UPDATE workers SET status='online', last_heartbeat=?, manifest_json=?, max_slots=? WHERE id=?`
    ).run(now(), JSON.stringify(manifest), maxSlots, id);
  } else {
    d.prepare(
      `INSERT INTO workers(id, owner_id, status, last_heartbeat, trust_tier, manifest_json, active_slots, max_slots, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(id, body.owner_id || null, 'online', now(), 0, JSON.stringify(manifest), 0, maxSlots, now());
  }
  // Attribute the worker to the invite it joined under (per-node provenance). Only set when an invite —
  // not the shared secret — admitted this registration. The workers.invite_id column is added by the
  // invites module's migration.
  if (inviteId) d.prepare('UPDATE workers SET invite_id=? WHERE id=?').run(inviteId, id);
  logEvent('worker', id, 'registered', { capabilities: manifest.capabilities });
  return { worker_id: id, coverage: gridDemandCoverage(manifest.capabilities) };
}

// ---- Grid-demand coverage ----------------------------------------------------
// On registration the broker tells the worker whether its advertised capabilities actually cover
// the work the grid currently has QUEUED (WHITEPAPER §5/§6: pull-based, capability-matched dispatch).
// This is READ-ONLY reporting — it touches no scheduling/trust gate (verify-don't-trust unchanged);
// it just lets a worker self-assess "is there work here I can do?" instead of polling claim blind.
//
// "Pending" = a job that is READY to be worked: status='pending' (so NOT blocked/claimed/completed/
// accepted — claim() flips a taken job to 'claimed', so 'pending' already excludes assigned/running
// work) AND every one of its job_dependencies has been ACCEPTED. That dependency gate mirrors the
// scheduler's per-job HARD check in claimableJobsFor() (`deps.some(dep => dep.status !== 'accepted')`).
// We intentionally do NOT apply the cross-objective dependency / integration-hold gate here: those are
// per-worker/per-objective scheduling concerns and recomputing them would make registration heavier;
// the dep-accepted approximation is the cheap, stable "what's claimable in principle" signal we want.
function gridDemandCoverage(capabilities) {
  // Resilience: registration must NEVER fail because coverage computation failed. Any DB/parse error
  // yields a benign empty-but-well-shaped object rather than throwing out of registerWorker().
  const advertised = Array.isArray(capabilities) ? capabilities : [];
  try {
    const d = getDb();
    // SINGLE cheap grouped query: count ready jobs per required capability. NOT EXISTS finds jobs with
    // any non-accepted dependency and excludes them (a job with zero dep rows trivially passes).
    const rows = d
      .prepare(
        `SELECT capability_required AS cap, COUNT(*) AS n
           FROM jobs
          WHERE status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM job_dependencies jd
                JOIN jobs dep ON dep.id = jd.depends_on_job_id
               WHERE jd.job_id = jobs.id AND dep.status != 'accepted'
            )
          GROUP BY capability_required`
      )
      .all();
    const pending_by_capability = {};
    for (const r of rows) {
      // A job may have a NULL capability_required (any worker can take it). Bucket those under '*' so
      // they still surface as demand without colliding with a real named capability.
      const cap = r.cap || '*';
      pending_by_capability[cap] = (pending_by_capability[cap] || 0) + r.n;
    }
    const adSet = new Set(advertised);
    const demanded = Object.keys(pending_by_capability);
    const covered = demanded.filter((cap) => adSet.has(cap));
    const uncovered = demanded.filter((cap) => !adSet.has(cap));
    return { worker_capabilities: advertised, pending_by_capability, uncovered, covered };
  } catch {
    // Partial-but-valid shape on failure — the consumer can rely on the fields always existing.
    return { worker_capabilities: advertised, pending_by_capability: {}, uncovered: [], covered: [] };
  }
}

function heartbeat(body) {
  // If the worker row is gone (fresh DB / eviction), the UPDATE matches 0 rows. Signal that so the
  // worker can re-register instead of heartbeating into the void forever.
  const r = getDb().prepare('UPDATE workers SET last_heartbeat=?, status=? WHERE id=?').run(now(), 'online', body.worker_id);
  if (r.changes === 0) return { ok: false, error: 'unknown_worker' };
  return { ok: true };
}

function claim(body) {
  const d = getDb();
  const workerId = body.worker_id;
  // Verify-don't-trust: a worker must be registered, and EVERY scheduling gate value is read from
  // server state — capabilities/max_slots from the registered manifest row, active_slots from a
  // live count, trust from earned reputation — never from the claim body.
  const row = d.prepare('SELECT * FROM workers WHERE id=?').get(workerId);
  // `error: 'unknown_worker'` is machine-detectable so the worker re-registers (vs. idling as if the
  // queue were empty). `reason` kept for back-compat with any human-readable consumers.
  if (!row) return { job: null, reason: 'worker not registered', error: 'unknown_worker' };
  d.prepare('UPDATE workers SET last_heartbeat=?, status=? WHERE id=?').run(now(), 'online', workerId);
  const manifest = (() => { try { return JSON.parse(row.manifest_json || '{}'); } catch { return {}; } })();
  const activeSlots = d.prepare("SELECT COUNT(*) AS c FROM assignments WHERE worker_id=? AND status='running'").get(workerId).c;
  const worker = {
    id: workerId,
    capabilities: manifest.capabilities || [],
    trust_tier: row.trust_tier ?? 0,
    adapter_hint: manifest.adapter_hint || null,
    max_slots: row.max_slots ?? 1,
    active_slots: activeSlots,
  };
  if (worker.active_slots >= worker.max_slots) return { job: null, reason: 'worker at capacity' };

  const job = pickJob(worker);
  if (!job) return { job: null };

  const token = leaseToken();
  const leaseUntil = now() + (DEFAULTS.leaseSeconds * 1000);
  const branch = `grid/${job.id}`;

  transaction(() => {
    d.prepare(
      `UPDATE jobs SET status='claimed', lease_token=?, lease_until=?, assigned_worker_id=?, branch=?, updated_at=? WHERE id=? AND status='pending'`
    ).run(token, leaseUntil, worker.id, branch, now(), job.id);
    d.prepare(
      `INSERT INTO assignments(job_id, worker_id, status, lease_token, started_at) VALUES(?,?,?,?,?)`
    ).run(job.id, worker.id, 'running', token, now());
    d.prepare('UPDATE workers SET active_slots = active_slots + 1 WHERE id = ?').run(worker.id);
  });

  // Reserve fuel for paid (Bedrock) workers at claim time.
  // If balance is insufficient, pickJob already excluded the job — this is belt-and-suspenders.
  if (workerOffersBedrock(worker.id)) {
    const bedrockModel = (() => {
      try {
        const models = JSON.parse(d.prepare('SELECT manifest_json FROM workers WHERE id=?').get(worker.id)?.manifest_json || '{}').models || [];
        return (models.find((m) => m.provider === 'bedrock') || {}).model || 'claude-3-haiku';
      } catch { return 'claude-3-haiku'; }
    })();
    reserveFuel(PRIMARY_ACCOUNT, job.id, estimateJobCost(job, 'bedrock', bedrockModel));
  }

  const objective = parseRow(d.prepare('SELECT * FROM objectives WHERE id=?').get(job.objective_id), ['contract_json']);
  const spec = job.spec_json ? JSON.parse(job.spec_json) : {};
  logEvent('job', job.id, 'claimed', { worker: worker.id });

  // For dependent jobs (e.g. review), point at the dependency's branch + patch artifact
  // so the worker can check it out / read the diff.
  let review_target = null;
  const deps = d.prepare('SELECT depends_on_job_id FROM job_dependencies WHERE job_id=?').all(job.id);
  if (deps.length) {
    const depJob = d.prepare('SELECT * FROM jobs WHERE id=?').get(deps[0].depends_on_job_id);
    if (depJob) {
      review_target = {
        job_id: depJob.id,
        branch: depJob.branch,
        patch_path: join(PATHS.artifacts, depJob.id, 'patch.diff'),
      };
    }
  }

  return {
    job: {
      job_id: job.id,
      objective_id: job.objective_id,
      type: job.type,
      title: job.title,
      prompt: job.prompt,
      capability_required: job.capability_required,
      adapter_hint: job.adapter_hint,
      spec,
      lease_token: token,
      lease_seconds: DEFAULTS.leaseSeconds,
      repo: objective?.repo,
      branch_base: objective?.branch_base || 'main',
      branch,
      acceptance_criteria: spec.acceptance_criteria || [],
      worktree: join(PATHS.worktrees, job.id),
      review_target,
      // Resume payload: if a prior worker dropped this job, hand over its latest checkpoint
      // so the claiming worker continues instead of restarting (PLAN: resumable handoff).
      checkpoint: latestCheckpoint(job.id),
      attempts: job.attempts || 0,
    },
  };
}

// ---- Checkpoints: partial progress so a dropped job RESUMES, not restarts -----
function saveCheckpoint(jobId, body) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) return { error: 'unknown job', code: 404 };
  if (!body.lease_token || body.lease_token !== job.lease_token) {
    return { error: 'invalid or expired lease', code: 409 };
  }
  // Cap checkpoint state so a worker can't bloat the resume payload that gets replayed to the next
  // worker. (The partial is also fenced as untrusted data at replay time in the providers.)
  const stateJson = JSON.stringify(body.state ?? {});
  if (stateJson.length > 256_000) return { error: 'checkpoint state too large', code: 413 };
  const seq = (job.checkpoint_seq || 0) + 1;
  transaction(() => {
    d.prepare(
      `INSERT INTO checkpoints(id, job_id, worker_id, seq, state_json, note, created_at) VALUES(?,?,?,?,?,?,?)`
    ).run(checkpointId(), jobId, job.assigned_worker_id, seq, stateJson, body.note ? String(body.note).slice(0, 500) : null, now());
    d.prepare('UPDATE jobs SET checkpoint_seq=?, updated_at=? WHERE id=?').run(seq, now(), jobId);
  });
  return { ok: true, seq };
}

function latestCheckpoint(jobId) {
  const row = getDb().prepare('SELECT state_json FROM checkpoints WHERE job_id=? ORDER BY seq DESC LIMIT 1').get(jobId);
  if (!row) return null;
  try {
    return JSON.parse(row.state_json);
  } catch {
    return null;
  }
}

// ---- Quorum: distributed deliberation seats ---------------------------------
// A deliberate() run is a "panel". Its CHEAP-tier debate seats (pessimist/optimist/realist
// opens+rebuts + the skeptic) are distributed to worker NODES as plain `inference` jobs; the
// single PREMIUM judge is NEVER enqueued — it runs house-held in-broker. We IMPLEMENT two
// injection-boundary functions the deliberation agent consumes via makeGridInfer:
//   dispatchSeat(...) -> seatId   : enqueue one seat as an independent inference job
//   collectSeat(...)  -> { text, usage } | null : await that seat's terminal result, or time out
// There are deliberately NO inter-seat job_dependencies — the in-process runDag already enforces
// DAG ordering (it only dispatches a seat after its deps' infer() calls resolve). panel_id exists
// ONLY for the claim-time independence rule (one seat per panel per owner) + debugging.
//
// Seat read-back lives in this in-memory map, populated by submitResult when a seat completes. The
// whole deliberation runs in THIS process (the broker), so an in-process map is the natural, lossless
// channel for the seat's text+usage; the durable event log ('seat_result') is the audit copy. Entries
// are consumed-and-deleted by collectSeat so the map can't grow unbounded across many panels.
const seatResults = new Map();

// Each panel needs an objective to hang its seat jobs on (jobs.objective_id is NOT NULL). Seats are
// agent-internal deliberation, not domain work, so we lazily create one sentinel holder objective per
// panel_id (status 'planning' so it never enters the merge/approve lifecycle) and reuse it for every
// seat of that panel. Idempotent: a panel's holder is created once, on its first seat.
function ensurePanelObjective(panelId) {
  const d = getDb();
  const existing = d.prepare("SELECT id FROM objectives WHERE id=?").get(panelHolderId(panelId));
  if (existing) return existing.id;
  const id = panelHolderId(panelId);
  d.prepare(
    `INSERT INTO objectives(id, title, prompt, repo, branch_base, contract_json, status, created_by, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, `quorum panel ${panelId}`, null, null, 'main', JSON.stringify({ objective_type: 'inference', quorum_panel: panelId }), 'planning', 'quorum', now(), now());
  return id;
}
function panelHolderId(panelId) {
  // Keep it inside the objectives id space but namespaced so it can never collide with O-## ids.
  return `Q-${panelId}`;
}

// dispatchSeat — insert ONE cheap-tier seat as an independent `inference` job and return its id.
// The prompt is assembled exactly as makeProviderInfer builds it (system ? system+"\n\n"+prompt :
// prompt) so a worker runs the identical text whether the seat is local or distributed. The job is
// born 'pending' (no dependencies — runDag gates ordering upstream) and tagged panel_id/seat_role.
function dispatchSeat({ panelId, seatKey, role, phase, system, prompt }) {
  const d = getDb();
  const objectiveId = ensurePanelObjective(panelId);
  const seatId = mkJobId(nextSeq('job'));
  const combinedPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const ts = now();
  d.prepare(
    `INSERT INTO jobs(id, objective_id, job_key, type, title, prompt, capability_required,
                      trust_required, adapter_hint, spec_json, status, priority,
                      estimated_minutes, attempts, panel_id, seat_role, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`
  ).run(
    seatId,
    objectiveId,
    seatKey || role,
    'inference',
    `deliberation seat: ${role}/${phase}`,
    combinedPrompt,
    'inference',
    0,
    null,
    JSON.stringify({}),
    'pending',
    100,
    5,
    panelId,
    seatKey || `${phase}_${role}`,
    ts,
    ts
  );
  logEvent('job', seatId, 'seat_dispatched', { panel_id: panelId, seat_role: seatKey || `${phase}_${role}`, role, phase });
  return seatId;
}

// collectSeat — await a dispatched seat reaching a TERMINAL completed state, returning its output
// text + usage; return null on timeout. Implemented as a bounded poll over the job/result state:
// submitResult marks the job 'completed' and populates seatResults; we poll for that entry. A seat
// that is rejected/retried/failed (no terminal output) drains its timeout and returns null, which
// the deliberation primitive treats as an empty seat (the panel still adjudicates / fails safe).
async function collectSeat({ seatId, timeoutMs } = {}) {
  const d = getDb();
  const deadline = now() + (Number.isFinite(timeoutMs) ? timeoutMs : QUORUM.seatTimeoutMs);
  const intervalMs = 50;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (seatResults.has(seatId)) {
      const out = seatResults.get(seatId);
      seatResults.delete(seatId); // consume-once so the map stays bounded
      return out;
    }
    // Terminal-but-no-output (rejected/failed after retries): stop early, the seat produced nothing.
    const row = d.prepare('SELECT status FROM jobs WHERE id=?').get(seatId);
    if (row && (row.status === 'rejected' || row.status === 'failed')) return null;
    if (now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function submitResult(jobId, body) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) return { error: 'unknown job', code: 404 };
  if (!body.lease_token || body.lease_token !== job.lease_token) {
    return { error: 'invalid or expired lease', code: 409 };
  }

  // mark completed + persist result
  const { lease_token: _lt, artifacts: _af, ...resultData } = body;
  d.prepare('UPDATE jobs SET status=?, result_json=?, updated_at=? WHERE id=?').run('completed', JSON.stringify(resultData), now(), jobId);
  if (job.assigned_worker_id) {
    d.prepare('UPDATE workers SET active_slots = MAX(0, active_slots - 1) WHERE id=?').run(job.assigned_worker_id);
  }

  // record artifacts the worker wrote to the shared artifacts dir
  for (const a of body.artifacts || []) {
    d.prepare(
      `INSERT INTO artifacts(job_id, worker_id, kind, path, hash, created_at) VALUES(?,?,?,?,?,?)`
    ).run(jobId, job.assigned_worker_id, a.kind, a.path || null, a.hash || null, now());
  }
  // Quorum seat read-back: for a distributed deliberation seat (panel_id set) the in-broker
  // collectSeat() needs the seat's OUTPUT TEXT + USAGE, which the artifacts table doesn't carry
  // (it stores only path/hash). Persist them durably in the event log under 'seat_result' so a
  // bounded poll can recover them after the seat reaches a terminal state. Scoped to seat jobs —
  // non-seat results are unaffected (panel_id is NULL for every existing job). The usage shape
  // mirrors makeProviderInfer's return ({ tokens? } plus the worker's tokens_in/out) so the
  // deliberation usage accumulator reads it the same way it reads an in-process infer.
  if (job.panel_id) {
    const usage = body.usage || {};
    seatResults.set(jobId, {
      text: body.output != null ? String(body.output) : '',
      usage: {
        tokens: usage.tokens ?? (((usage.input_tokens ?? body.tokens_in ?? 0) + (usage.output_tokens ?? body.tokens_out ?? 0)) || undefined),
        input_tokens: usage.input_tokens ?? body.tokens_in,
        output_tokens: usage.output_tokens ?? body.tokens_out,
      },
    });
    logEvent('job', jobId, 'seat_result', { panel_id: job.panel_id, seat_role: job.seat_role });
  }
  logEvent('job', jobId, 'result_submitted', { status: body.status });

  // S2 pipeline: when an inference job with s2_type completes successfully, auto-create
  // a validation job that checks output structure and ingests approved content.
  if (body.status === 'completed' && body.output) {
    try {
      const spec = typeof job.spec_json === 'string' ? JSON.parse(job.spec_json || '{}') : (job.spec_json || {});
      if (spec.s2_type) {
        const vId = mkJobId(nextSeq('job'));
        d.prepare(`INSERT INTO jobs(id,objective_id,job_key,type,title,prompt,capability_required,trust_required,adapter_hint,spec_json,status,priority,estimated_minutes,attempts,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,0,?,?,?,200,2,0,?,?)`)
         .run(vId, job.objective_id, `${job.job_key}-s2validate`, 's2.validate',
              `Validate S2 ${spec.s2_type} for ${spec.s2_area || 'unknown'}`,
              body.output, 's2.validate', 's2-validator',
              JSON.stringify({ s2_type: spec.s2_type, s2_area: spec.s2_area, entropy_seed: spec.entropy_seed, ingest_url: process.env.GAME_INGEST_URL || '' }),
              'pending', now(), now());
        logEvent('job', vId, 'created', { kind: 's2_validation', parent: jobId, s2_type: spec.s2_type });
      }
    } catch (_) { /* non-critical — don't fail result submission if validation job creation errors */ }
  }

  const ctx = await buildResultCtx(job);
  const verdict = await onResult(jobId, body, ctx);
  return { ok: true, verdict };
}

async function createObjective(body) {
  const out = await createObjectiveRow(body);
  // Record + resolve declared inter-objective deps (explicit body.depends_on issue numbers, or
  // "Depends on #N" in the prompt). resolveAndGate binds #N -> objective via source_issue.
  const depIssues = [...new Set([...(body.depends_on || []), ...parseDependencyIssues(body.prompt)])];
  if (depIssues.length) recordObjectiveDeps(out.objective_id, body.source_issue ?? null, depIssues);
  const dependencies = resolveAndGate();
  return { ...out, dependencies };
}

async function createObjectiveRow(body) {
  const d = getDb();
  const id = mkObjectiveId(nextSeq('objective'));
  const contract = body.contract || {};
  d.prepare(
    `INSERT INTO objectives(id, title, prompt, repo, branch_base, contract_json, status, created_by, source_issue, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    body.title,
    body.prompt || null,
    body.repo || null,
    body.branch_base || 'main',
    JSON.stringify(contract),
    'planning',
    body.created_by || 'cli',
    body.source_issue ?? null,
    now(),
    now()
  );
  logEvent('objective', id, 'created', { title: body.title, source_issue: body.source_issue });

  const objective = parseRow(d.prepare('SELECT * FROM objectives WHERE id=?').get(id), ['contract_json']);
  const jobs = await planObjective(objective);
  d.prepare('UPDATE objectives SET status=?, updated_at=? WHERE id=?').run('in_progress', now(), id);
  return { objective_id: id, jobs };
}

// Import open GitHub issues as objectives (one per issue), deduped by issue number.
async function importIssues(body) {
  if (!body.repo) return { error: 'repo path required', code: 400 };
  const res = await listIssues({ repo: body.repo, label: body.label, limit: body.limit });
  if (res.error) return { error: res.error, code: 400 };

  const d = getDb();
  const created = [];
  const skipped = [];
  for (const issue of res.issues) {
    // Parse "Depends on #N" for EVERY issue — including already-imported ones — so dependencies
    // declared on a pre-existing issue are backfilled, not just recorded on first import.
    const depIssues = parseDependencyIssues(issue.body);
    const exists = d.prepare('SELECT id FROM objectives WHERE source_issue=?').get(issue.number);
    if (exists) {
      if (depIssues.length) recordObjectiveDeps(exists.id, issue.number, depIssues);
      skipped.push({ issue: issue.number, objective: exists.id });
      continue;
    }
    const out = await createObjectiveRow({
      title: `#${issue.number} ${issue.title}`,
      prompt: (issue.body || issue.title || '').slice(0, 16000), // cap untrusted issue text at import
      repo: body.repo,
      branch_base: body.base || 'main',
      contract: defaultIssueContract(body.test),
      created_by: 'github-issue',
      source_issue: issue.number,
    });
    if (depIssues.length) recordObjectiveDeps(out.objective_id, issue.number, depIssues);
    created.push({ issue: issue.number, ...out });
  }
  // One resolution pass after the whole batch — binds forward/same-batch refs, breaks cycles,
  // and gates dependents. Conservative: unresolved upstreams keep a dependent blocked.
  const dependencies = resolveAndGate();
  return { slug: res.slug, created, skipped, dependencies };
}

function defaultIssueContract(testCmd) {
  return {
    objective_type: 'code.feature',
    // Request agent decomposition (logic-first, then decompose). Falls back to the template when
    // the planner agent isn't configured (MOLT_PLANNER_AGENT unset), so default behavior is safe.
    planner: 'agent',
    hard_completion_gates: testCmd ? [`'${testCmd}' passes`] : ['implements the change described in the issue'],
    forbidden_without_approval: ['adding npm dependencies'],
    constraints: { max_files_changed: 20 },
    validation: testCmd ? { automated: [testCmd] } : {},
    quality_thresholds: { implementation_review_score_min: 0.7, confidence_min: 0.6 },
  };
}

// ---- Fuel ledger endpoints ---------------------------------------------------

function getFuelBalance(accountId = PRIMARY_ACCOUNT) {
  return { account_id: accountId, balance_cents: getBalance(accountId) };
}

function postFuelCredit(body) {
  const amountCents = Number(body.amount_cents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { error: 'amount_cents must be a positive number', code: 400 };
  }
  const accountId = body.account_id || PRIMARY_ACCOUNT;
  creditFuel(accountId, amountCents, body.note || null);
  return { ok: true, account_id: accountId, credited_cents: amountCents, balance_cents: getBalance(accountId) };
}

function getFuelLog(accountId = PRIMARY_ACCOUNT, limit = 50) {
  return fuelLog(accountId, limit);
}

// ---- Payment endpoints (x402 value rail) -------------------------------------

// POST /payments/verify — verify an incoming x402 payment against requirements and, if valid,
// credit the payer's account balance (or grant access to the paid resource).
// With MOLT_FUEL_REAL=0, facilitator calls are simulated — no real on-chain action occurs.
async function postPaymentsVerify(body) {
  const { payment_header, payment_requirements } = body;
  if (!payment_header || !payment_requirements) {
    return { error: 'payment_header and payment_requirements required', code: 400 };
  }
  const result = await verifyPayment(payment_header, payment_requirements);
  if (!result.isValid) {
    return { error: `payment invalid: ${result.invalidReason || 'rejected by facilitator'}`, code: 402 };
  }
  // Settle on-chain (no-op when MOLT_FUEL_REAL=0).
  await settlePayment(payment_header, payment_requirements);
  return { ok: true, settled: !result.simulated, simulated: result.simulated ?? false };
}

// POST /payments/request — contributor requests payout for an accepted job.
// Records a pending payout entry in the fuel ledger; actual USDC transfer is human-operated.
function postPaymentsRequest(body) {
  const { job_id, wallet_address, amount_cents } = body;
  if (!job_id || !wallet_address) {
    return { error: 'job_id and wallet_address required', code: 400 };
  }
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id=? AND status=?').get(job_id, 'accepted');
  if (!job) return { error: 'job not found or not accepted', code: 404 };
  const cents = Number(amount_cents) || 0;
  recordPayout(PRIMARY_ACCOUNT, job_id, cents, wallet_address);
  return { ok: true, job_id, wallet_address, amount_cents: cents, note: 'pending human/treasury disbursement' };
}

// ---- Read endpoints (dashboard / CLI status) ---------------------------------

// Force-clear an integration hold/escalation and re-gate. The human's lever once they've
// resolved whatever the agent escalated (e.g. merged the upstream PR).
function releaseObjective(objectiveId) {
  const d = getDb();
  if (!d.prepare('SELECT id FROM objectives WHERE id=?').get(objectiveId)) return { error: 'unknown objective', code: 404 };
  clearObjectiveHold(objectiveId);
  clearNeedsReview(objectiveId);
  applyObjectiveGatingStatus(objectiveId);
  logEvent('objective', objectiveId, 'integration_released_by_operator', {});
  return { ok: true, objective_id: objectiveId, status: d.prepare('SELECT status FROM objectives WHERE id=?').get(objectiveId).status };
}

function listObjectives() {
  // Annotate with blocked_on — the operator's escape hatch when an objective is wedged behind
  // an upstream (never-approved, unresolved, or failed dependency). Empty array = not blocked.
  return getDb()
    .prepare('SELECT * FROM objectives ORDER BY created_at DESC')
    .all()
    .map((o) => ({ ...o, blocked_on: unsatisfiedDepsFor(o.id) }));
}
function listJobs(objectiveId) {
  const d = getDb();
  const rows = objectiveId
    ? d.prepare('SELECT * FROM jobs WHERE objective_id=? ORDER BY created_at ASC').all(objectiveId)
    : d.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
  return rows.map((j) => {
    const { result_json, ...rest } = j;
    return {
      ...rest,
      result: result_json ? JSON.parse(result_json) : null,
      depends_on: d.prepare('SELECT depends_on_job_id FROM job_dependencies WHERE job_id=?').all(j.id).map((r) => r.depends_on_job_id),
    };
  });
}
function listWorkers() {
  // Liveness is DERIVED from the heartbeat we already collect (every heartbeatSeconds), never from
  // an outbound poll: the grid is pull-based, so an ephemeral worker that left simply stops
  // heartbeating and drops off the roster ~workerStaleSeconds later. Mirror of how sweepLeases ages
  // out a dead worker's jobs. The stored `status` column is just an internal cache (sweepWorkers
  // keeps it roughly in sync for direct readers + the event stream) — the roster's truth is here.
  const cutoff = now() - DEFAULTS.workerStaleSeconds * 1000;
  return getDb()
    .prepare('SELECT * FROM workers ORDER BY created_at ASC')
    .all()
    .map((w) => {
      const online = (w.last_heartbeat ?? 0) >= cutoff;
      return { ...w, online, status: online ? 'online' : 'offline', reputation: reputationFor(w.id) };
    });
}
function listEvents(limit = 100) {
  return getDb().prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ---- Redaction: anonymous GET projections ------------------------------------
// When MOLT_AUTH=1 and the caller is NOT authed, read endpoints must not leak the things a public
// dashboard scrape would otherwise expose: objective prompts, absolute repo paths, raw
// contract/spec/payload JSON, created_by/source_issue provenance, the event stream, and the fuel
// ledger detail. The authed view is unchanged — these only run on the anonymous path.
function redactObjective(o) {
  const { prompt, repo, contract_json, created_by, source_issue, ...rest } = o;
  return { ...rest, repo: repo ? '<redacted>' : null };
}
function redactJob(j) {
  const { prompt, spec_json, contract_json, payload_json, last_failed_worker_id, result, ...rest } = j;
  return rest;
}
function redactFuelEntry(e) {
  // Keep coarse shape (kind/amount/time) but drop the free-text note, wallet, and any payload.
  const { note, payload_json, wallet_address, account_id, ...rest } = e;
  return rest;
}
function redactWorker(w) {
  // Anonymous callers get coarse status only — never owner_id, the full manifest, or heartbeat ts.
  // `online`/`status` are heartbeat-derived (see listWorkers) so even the public roster is honest.
  return { id: w.id, status: w.status, online: w.online, trust_tier: w.trust_tier, active_slots: w.active_slots, max_slots: w.max_slots, reputation: w.reputation };
}

// ---- Lease sweep: requeue jobs whose worker died (lease expired) --------------

export function sweepLeases() {
  const d = getDb();
  const expired = d
    .prepare(`SELECT * FROM jobs WHERE status='claimed' AND lease_until IS NOT NULL AND lease_until < ?`)
    .all(now());
  for (const job of expired) {
    // Requeue but REMEMBER who dropped it (continuation avoids re-handing to the dropper)
    // and KEEP the checkpoint row so the next worker resumes from partial progress.
    d.prepare(
      `UPDATE jobs SET status='pending', lease_token=NULL, lease_until=NULL, assigned_worker_id=NULL, last_failed_worker_id=?, updated_at=? WHERE id=?`
    ).run(job.assigned_worker_id || null, now(), job.id);
    d.prepare(`UPDATE assignments SET status='expired', finished_at=? WHERE job_id=? AND finished_at IS NULL`).run(now(), job.id);
    if (job.assigned_worker_id) {
      d.prepare('UPDATE workers SET active_slots = MAX(0, active_slots - 1) WHERE id=?').run(job.assigned_worker_id);
      recordEvent(job.assigned_worker_id, job.capability_required, 'lease_expired', job.id);
    }
    // Refund any fuel reserved by the dropped worker so the balance is available for the next.
    refundFuel(PRIMARY_ACCOUNT, job.id);
    logEvent('job', job.id, 'lease_expired', { worker: job.assigned_worker_id, resumable: !!latestCheckpoint(job.id) });
  }
}

// ---- Worker sweep: age out workers whose heartbeat went stale -------------------
// Passive liveness — we NEVER poll workers. Workers are ephemeral and may leave without notice
// (a laptop closes, a process exits); the grid is pull-based, so a gone worker simply stops
// claiming and no work is ever pushed at it. Here we let the heartbeat we already collect expire:
// any 'online' worker we haven't heard from in workerStaleSeconds is flipped offline so the stored
// status + event stream match the heartbeat-derived roster (see listWorkers). A returning worker's
// next heartbeat/re-register flips it straight back online. Job/slot recovery is NOT done here —
// sweepLeases owns that (requeue + slot refund + fuel refund) so we never double-handle a dropped
// worker's in-flight job.
export function sweepWorkers() {
  const d = getDb();
  const cutoff = now() - DEFAULTS.workerStaleSeconds * 1000;
  const stale = d
    .prepare(`SELECT id, last_heartbeat FROM workers WHERE status='online' AND (last_heartbeat IS NULL OR last_heartbeat < ?)`)
    .all(cutoff);
  for (const w of stale) {
    d.prepare(`UPDATE workers SET status='offline' WHERE id=?`).run(w.id);
    logEvent('worker', w.id, 'worker_offline', { last_heartbeat: w.last_heartbeat ?? null });
  }
}

// ---- Readiness: can the grid actually distribute the work it is holding? --------
// /health says the broker process is up. Readiness asks the harder question: is there pending work,
// and can a LIVE worker claim it? The silent failure is STARVATION — pending, dependency-ready jobs
// whose capability is advertised by ZERO online workers (or there are no online workers at all).
// From the outside that looks identical to an empty queue, so we name it explicitly. "Online" uses
// the SAME heartbeat-freshness threshold the scheduler uses to hand out jobs (workerStaleSeconds),
// so this report never disagrees with what claim() would actually do. Blocked-on-dependency jobs are
// counted separately — they are EXPECTED to wait and are not a readiness problem.
export function readiness() {
  const d = getDb();
  const cutoff = now() - DEFAULTS.workerStaleSeconds * 1000;

  const onlineWorkers = d
    .prepare('SELECT manifest_json, active_slots, max_slots FROM workers WHERE last_heartbeat IS NOT NULL AND last_heartbeat >= ?')
    .all(cutoff)
    .map((w) => {
      let caps = [];
      try { caps = JSON.parse(w.manifest_json || '{}').capabilities || []; } catch { /* ignore */ }
      return { caps, hasSlot: (w.active_slots ?? 0) < (w.max_slots ?? 1) };
    });
  const capsOnline = new Set(onlineWorkers.flatMap((w) => w.caps));
  const capsWithSlot = new Set(onlineWorkers.filter((w) => w.hasSlot).flatMap((w) => w.caps));
  // A job with no capability_required can be done by ANY worker — but only if one exists.
  const anyOnline = onlineWorkers.length > 0;
  const anyWithSlot = onlineWorkers.some((w) => w.hasSlot);
  const someoneCanDo = (cap) => (cap ? capsOnline.has(cap) : anyOnline);
  const someoneFreeCanDo = (cap) => (cap ? capsWithSlot.has(cap) : anyWithSlot);

  const pending = d.prepare("SELECT id, objective_id, capability_required FROM jobs WHERE status='pending'").all();
  const objBlocked = objectivesWithUnsatisfiedDeps();
  const objHeld = objectivesOnHold();
  const unmetDeps = d.prepare(
    `SELECT COUNT(*) AS n FROM job_dependencies jd JOIN jobs j ON j.id = jd.depends_on_job_id WHERE jd.job_id = ? AND j.status != 'accepted'`
  );

  const jobs = { pending_total: pending.length, claimable_now: 0, saturated: 0, starved: 0, blocked: 0 };
  const gaps = new Map(); // capability -> count of starved jobs
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
      jobs.saturated++; // a capable worker exists but none has a free slot right now
    } else {
      jobs.claimable_now++;
    }
  }

  // Starvation is the only condition that means "not ready" — work is waiting and no live worker can
  // take it. Saturation (capable but busy) and idle (nothing pending) are both fine resting states.
  const status = jobs.starved > 0 ? 'starved' : jobs.claimable_now > 0 ? 'draining' : jobs.saturated > 0 ? 'saturated' : 'idle';

  return {
    ok: true,
    ready: jobs.starved === 0,
    status,
    time: now(),
    workers: {
      online: onlineWorkers.length,
      idle: onlineWorkers.filter((w) => w.hasSlot).length,
      busy: onlineWorkers.filter((w) => !w.hasSlot).length,
    },
    jobs,
    capability_gaps: [...gaps.entries()].map(([capability, pending]) => ({ capability, pending })),
  };
}

// ---- Static dashboard serving ------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' || urlPath === '/dashboard' || urlPath === '/dashboard/' ? '/index.html' : urlPath.replace(/^\/dashboard/, '');
  const filePath = normalize(join(PATHS.dashboard, rel));
  if (!filePath.startsWith(PATHS.dashboard)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not file');
    let data = await readFile(filePath);
    // The CSP below forbids inline <script>, so the dashboard can't compute its own path prefix
    // in-page. Inject a real <base> server-side instead (CSP allows <base>): relative assets
    // (style.css, app.js) then resolve under the ALB prefix (/grid/dashboard), and app.js derives
    // its API prefix from document.baseURI. Keeps the strict CSP intact — no inline-script hole.
    if (extname(filePath) === '.html') {
      data = Buffer.from(String(data).replace('<head>', `<head>\n    <base href="${BROKER.pathPrefix || ''}/dashboard/">`));
    }
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      // Lock the dashboard to same-origin assets: no inline/remote script injection vector.
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ---- Auth: team-gating via API keys ------------------------------------------
// Keys are presented as `Authorization: Bearer <id>.<secret>`. Only the id and a sha256
// of the secret are stored (api_keys table); the raw secret never persists.
function authOk(req) {
  const hdr = req.headers['authorization'] || '';
  const m = hdr.match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  const dot = m[1].indexOf('.');
  if (dot < 0) return false;
  const id = m[1].slice(0, dot);
  const secret = m[1].slice(dot + 1);
  if (!id || !secret) return false;
  const d = getDb();
  const row = d.prepare('SELECT * FROM api_keys WHERE id=? AND revoked=0').get(id);
  if (!row) return false;
  const hash = createHash('sha256').update(secret).digest('hex');
  if (hash !== row.hash) return false;
  d.prepare('UPDATE api_keys SET last_used=? WHERE id=?').run(now(), id);
  return true;
}

// Worker/contribution endpoints (/workers/*, /jobs/*) are open ONLY under the explicit opt-in
// MOLT_OPEN_GRID=1. The permissionless posture is UNSAFE until reviewer-independence, server-side
// trust derivation, and per-worker identity land (security audit 2026-06-22: an anonymous worker
// can otherwise forge a green review, self-grade, spoof trust/changed_files, and grief reputation).
// So it defaults OFF — with MOLT_AUTH=1 every mutating endpoint, workers included, needs the key.
export function requiresOperatorAuth(method, path) {
  if (method !== 'POST') return false;
  if (process.env.MOLT_OPEN_GRID === '1' && /^\/(workers|jobs)\b/.test(path)) return false;
  return true;
}

// ---- Server ------------------------------------------------------------------

// Opt-in agent wiring. Both agents share one provider-backed infer (cheap=local Qwen,
// premium=Bedrock; override via MOLT_DELIB_CHEAP / MOLT_DELIB_PREMIUM). Off by default — the
// broker runs the deterministic floor + template planner unless explicitly enabled.
// async because, when the quorum grid is enabled, it dynamically imports the grid-infer wrapper.
async function maybeEnableAgents() {
  const tierAdapters = {
    cheap: process.env.MOLT_DELIB_CHEAP || 'local',
    premium: process.env.MOLT_DELIB_PREMIUM || 'bedrock',
  };
  const tierModels = {
    cheap: process.env.MOLT_DELIB_CHEAP_MODEL || undefined,
    premium: process.env.MOLT_DELIB_PREMIUM_MODEL || undefined,
  };
  // The fuel gate/meter govern only the funded Bedrock path. Directly-billed providers (DeepSeek,
  // local) are paid out-of-band via their own API key, not drawn from the fuel ledger, so they run
  // without a budget gate. (Premium-on-Bedrock still fails safe to 'escalate' when the ledger is dry.)
  const premiumIsBedrock = tierAdapters.premium === 'bedrock';
  const budgetGate = premiumIsBedrock
    ? () => { if (getBalance(PRIMARY_ACCOUNT) < (cfgFn ? cfgFn('minBalance') : FUEL.minBalance)) throw new Error('insufficient fuel for premium agent call'); }
    : null;
  let meterSeq = 0;
  const meter = premiumIsBedrock
    ? ({ provider, model, usage }) => {
        const inTok = usage.input_tokens ?? usage.tokens_in ?? 0;
        const outTok = usage.output_tokens ?? usage.tokens_out ?? 500;
        const cents = estimateCost(provider || 'bedrock', model || 'claude-3-haiku', inTok, outTok);
        chargeFuel(PRIMARY_ACCOUNT, `agent-${now()}-${++meterSeq}`, cents, `agent premium call ${provider || '?'}/${model || '?'}`);
      }
    : null;
  let infer = null;
  // The in-broker provider infer — cheap seats AND the premium judge all run in-process. This is
  // TODAY's path and stays verbatim when QUORUM.gridEnabled is OFF (zero behavior change).
  const localInferOf = () => (infer ||= makeProviderInfer({ getAdapter, tierAdapters, tierModels, log: () => {}, budgetGate, meter }));

  // When MOLT_QUORUM_GRID=1, wrap that local infer with makeGridInfer (built by the sibling agent in
  // ./agents/grid-infer.mjs). makeGridInfer distributes the CHEAP-tier seats as inference jobs via our
  // dispatchSeat/collectSeat injection boundary while keeping the PREMIUM judge on localInfer. We load
  // grid-infer.mjs DYNAMICALLY + guarded so the broker still boots if the file isn't present yet; once
  // it exists, the wrapper activates automatically. On the OFF path this whole block is skipped and
  // sharedInfer === localInfer, so the agents behave exactly as before.
  let gridInfer = null;
  if (QUORUM.gridEnabled) {
    try {
      const mod = await import('./agents/grid-infer.mjs');
      const makeGridInfer = mod.makeGridInfer || mod.default;
      if (typeof makeGridInfer === 'function') {
        gridInfer = makeGridInfer({ localInfer: localInferOf(), dispatchSeat, collectSeat, seatTimeoutMs: QUORUM.seatTimeoutMs, log: () => {} });
        console.log('[broker] quorum grid ON — cheap deliberation seats distributed to the grid (premium judge house-held)');
      } else {
        console.log('[broker] quorum grid requested but ./agents/grid-infer.mjs exports no makeGridInfer; falling back to in-broker deliberation');
      }
    } catch (e) {
      console.log(`[broker] quorum grid requested but grid-infer.mjs unavailable (${e.message}); falling back to in-broker deliberation`);
    }
  }
  const sharedInfer = () => gridInfer || localInferOf();
  const tag = (t) => `${tierAdapters[t]}${tierModels[t] ? ':' + tierModels[t] : ''}`;
  if (process.env.MOLT_INTEGRATION_AGENT === '1') {
    setIntegrationInfer(sharedInfer());
    console.log(`[broker] integration agent ON (cheap=${tag('cheap')}, premium=${tag('premium')})`);
  }
  if (process.env.MOLT_PLANNER_AGENT === '1') {
    setPlannerInfer(sharedInfer());
    console.log(`[broker] planner agent ON (premium=${tag('premium')})`);
  }
}

// Seed the team API key from MOLT_BOOTSTRAP_KEY on boot (the deployed-broker key bootstrap —
// the EFS/WAL DB can't be written by an outside process). Idempotent; logs the id, never the secret.
function seedBootstrapKey() {
  const raw = process.env.MOLT_BOOTSTRAP_KEY;
  if (!raw) return;
  try {
    const r = importKey(raw, { name: 'bootstrap', force: true }); // force: re-seed on rotation (else a stale hash locks the operator out)
    console.log(r.rotated ? `[broker] bootstrap API key ROTATED to current MOLT_BOOTSTRAP_KEY (id=${r.id})`
      : r.seeded ? `[broker] bootstrap API key seeded (id=${r.id})` : `[broker] bootstrap API key already present (id=${r.id})`);
  } catch (e) {
    console.log(`[broker] bootstrap key NOT seeded: ${e.message}`);
  }
}

export function startBroker() {
  getDb(); // bootstrap schema
  seedBootstrapKey();
  // Boot-apply persisted restart-tier overrides into process.env BEFORE the agents read env, so a
  // restart actually applies what the operator set in the panel (otherwise restart knobs stay
  // 'pending' forever). Synchronous + ahead of maybeEnableAgents.
  try {
    const applied = applyStoredOverrides();
    if (applied.length) console.log(`[broker] applied stored restart override(s): ${applied.join(', ')}`);
  } catch (e) { console.log(`[broker] applyStoredOverrides error: ${e.message}`); }
  // Fire-and-forget: when the quorum grid is OFF this runs fully synchronously (no awaits hit), so
  // wiring is in place before the server binds; when ON it awaits a dynamic import — guard the
  // promise so a missing/broken grid-infer module can never crash boot with an unhandled rejection.
  Promise.resolve(maybeEnableAgents()).catch((e) => console.log(`[broker] agent wiring error: ${e.message}`));
  // Lazily wire the admin control-plane modules (runtime-config + admin-queries). Same fire-and-forget
  // posture: if the sibling's files aren't present yet this resolves quietly and the /admin routes
  // report "module not loaded" until they land; it can never crash boot.
  Promise.resolve(loadAdminModules()).catch((e) => console.log(`[broker] admin module wiring error: ${e.message}`));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${BROKER.host}:${BROKER.port}`);
    const rawPath = url.pathname;
    // Strip the ALB path prefix so the router sees /health, /jobs, etc. regardless
    // of whether the broker sits at / or /grid (MOLT_PATH_PREFIX=/grid).
    const prefix = BROKER.pathPrefix;
    const path = prefix && rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) || '/' : rawPath;
    const method = req.method;
    try {
      // MOLT_AUTH=1 gates mutating endpoints; with MOLT_OPEN_GRID=1 worker/job ingress is opened but
      // operator/spend endpoints (commission work, approve merges, credit/settle fuel) stay gated.
      // MOLT_AUTH unset/0 = fully open. Checked live.
      const authed = process.env.MOLT_AUTH === '1' ? authOk(req) : true;
      if (process.env.MOLT_AUTH === '1' && requiresOperatorAuth(method, path) && !authed) {
        return json(res, 401, { error: 'unauthorized: operator endpoint — send Authorization: Bearer <api-key>' });
      }

      // Parse the body once for POST routes so we can rate-limit by worker_id and reject oversized
      // bodies uniformly before any handler runs.
      let body = null;
      if (method === 'POST') {
        // IP-keyed rate gate first (cheap, no body needed) so a flood is shed before we read it.
        const ip = clientIp(req);
        if (/^\/(workers|jobs)\b/.test(path) && rateLimited(`ip:${ip}`)) {
          return json(res, 429, { error: 'rate limit exceeded' });
        }
        body = await readBody(req);
        if (body === BODY_TOO_LARGE) {
          // Close the connection: the client's upload was truncated, so the socket can't be safely
          // reused for keep-alive.
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
          return res.end(JSON.stringify({ error: 'request body too large' }));
        }
        // worker_id-keyed gate (a forged id flooding from rotating IPs).
        const rl = checkIngressRate(req, path, body);
        if (rl) return json(res, rl.code, { error: rl.error });
      }

      // API
      if (method === 'POST' && path === '/workers/register') { const r = await registerWorker(body); return json(res, r.ok === false ? 401 : 200, r); }
      if (method === 'POST' && path === '/workers/heartbeat') return json(res, 200, heartbeat(body));
      if (method === 'POST' && path === '/jobs/claim') {
        // Global concurrent-claim ceiling: a hard cap on simultaneous claim handling so a burst
        // can't exhaust DB/CPU even if it slips the per-key window.
        if (inflightClaims >= RATE.maxConcurrentClaims) {
          return json(res, 429, { error: 'broker at claim capacity, retry shortly' });
        }
        inflightClaims += 1;
        try { return json(res, 200, claim(body)); }
        finally { inflightClaims -= 1; }
      }
      const checkpointMatch = path.match(/^\/jobs\/([^/]+)\/checkpoint$/);
      if (method === 'POST' && checkpointMatch) {
        const r = saveCheckpoint(checkpointMatch[1], body);
        return json(res, r.code || 200, r);
      }
      const resultMatch = path.match(/^\/jobs\/([^/]+)\/result$/);
      if (method === 'POST' && resultMatch) {
        const r = await submitResult(resultMatch[1], body);
        return json(res, r.code || 200, r);
      }
      if (method === 'POST' && path === '/objectives') return json(res, 200, await createObjective(body));
      if (method === 'POST' && path === '/github/import-issues') {
        const r = await importIssues(body);
        return json(res, r.code || 200, r);
      }
      const approveMatch = path.match(/^\/objectives\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) { const r = await approveObjective(approveMatch[1]); return json(res, r.code || 200, r); }
      // Operator escape hatch: force-release an objective the integration agent held/escalated
      // (e.g. after the human merged the upstream PR). Clears dep_hold + needs_review and re-gates.
      const releaseMatch = path.match(/^\/objectives\/([^/]+)\/release$/);
      if (method === 'POST' && releaseMatch) { const r = releaseObjective(releaseMatch[1]); return json(res, r.code || 200, r); }

      // Fuel ledger. Anonymous callers (MOLT_AUTH=1 + unauthed) get a redacted ledger projection.
      if (method === 'GET' && path === '/fuel/balance') return json(res, 200, getFuelBalance(url.searchParams.get('account') || PRIMARY_ACCOUNT));
      if (method === 'GET' && path === '/fuel/log') {
        const log = getFuelLog(url.searchParams.get('account') || PRIMARY_ACCOUNT, Number(url.searchParams.get('limit') || 50));
        return json(res, 200, authed ? log : log.map(redactFuelEntry));
      }
      if (method === 'POST' && path === '/fuel/credit') { const r = postFuelCredit(body); return json(res, r.code || 200, r); }

      // Payments (x402 value rail)
      if (method === 'POST' && path === '/payments/verify') { const r = await postPaymentsVerify(body); return json(res, r.code || 200, r); }
      if (method === 'POST' && path === '/payments/request') { const r = postPaymentsRequest(body); return json(res, r.code || 200, r); }

      // ── Join: open onboarding ──
      // GET /join         → no token needed. Agents get JSON with the run command. Browsers get
      //                     a self-contained .command file (macOS: double-click → Terminal runs it).
      // GET /join/<token> → same, but bakes the invite token into the install for gated brokers.
      // No landing page, no key generation, no ceremony. The URL IS the onboarding.
      if (method === 'GET' && (path === '/join' || path.startsWith('/join/'))) {
        const joinToken = path.length > 6 ? path.slice(6).split('/')[0] : '';
        const repo = 'https://github.com/water-bear86/molt-dispatch.git';
        const brokerUrl = BROKER.url;

        const tokenSteps = joinToken
          ? [`printf '%s\\n' '${joinToken}' > ~/.molt/.molt-token && chmod 600 ~/.molt/.molt-token`]
          : [];
        const runSteps = [
          `git clone --depth 1 ${repo} ~/.molt 2>/dev/null || git -C ~/.molt pull --ff-only --quiet`,
          ...tokenSteps,
          `MOLT_BROKER_URL=${brokerUrl} node ~/.molt/bin/molt.mjs go`,
        ];

        // Agents (Claude Code, Codex, curl) get JSON they can run directly.
        const accept = req.headers.accept || '';
        if (accept.includes('application/json') || accept.includes('text/plain') || !accept.includes('text/html')) {
          return json(res, 200, {
            service: 'molt — distributed agent compute grid',
            action: 'Run the commands below to join.',
            broker: brokerUrl,
            prereqs: 'Node >= 24, git, and an inference provider (Claude Code CLI or DEEPSEEK_API_KEY)',
            run: runSteps,
            run_oneliner: runSteps.join(' && '),
          });
        }

        // Browsers get a self-contained .command file — no landing page, no second fetch.
        const tokenBash = joinToken
          ? `\nprintf '%s\\n' "${joinToken}" > "$MOLT_HOME/.molt-token"\nchmod 600 "$MOLT_HOME/.molt-token"\necho "  ✓ token saved"`
          : '';
        const script = `#!/bin/bash
# molt — join the distributed agent compute grid
set -euo pipefail
clear
G="\\033[32m"; D="\\033[0m"; R="\\033[31m"
echo ""
echo "  \${G}▰▰▱\${D}  molt — joining the grid"
echo ""
MOLT_HOME="\${MOLT_HOME:-$HOME/.molt}"
REPO="${repo}"

# prereqs
if ! command -v node &>/dev/null; then echo "  \${R}✗\${D} Node.js not found — install Node >= 24: https://nodejs.org" >&2; echo ""; read -rsp "press any key..."; exit 1; fi
NV=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [ "$NV" -lt 24 ]; then echo "  \${R}✗\${D} Node $NV found — need >= 24: https://nodejs.org" >&2; echo ""; read -rsp "press any key..."; exit 1; fi
echo "  ✓ node $NV"
if ! command -v git &>/dev/null; then echo "  \${R}✗\${D} git not found" >&2; echo ""; read -rsp "press any key..."; exit 1; fi
echo "  ✓ git"

# install / update
if [ -d "$MOLT_HOME/.git" ]; then
  echo "  ↻ updating"; git -C "$MOLT_HOME" pull --ff-only --quiet 2>/dev/null || true
else
  echo "  ↓ installing"; git clone --depth 1 --quiet "$REPO" "$MOLT_HOME"
fi
${tokenBash}
echo "  ✓ ready"
echo ""

# join
export MOLT_BROKER_URL="${brokerUrl}"
exec node "$MOLT_HOME/bin/molt.mjs" go
`;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="join-molt.command"',
        });
        return res.end(script);
      }

      // Read endpoints. When auth is enforced and the caller is unauthed, return a REDACTED
      // projection (no prompts, absolute repo paths, raw contract/spec/payload JSON, provenance,
      // event stream). The authed view is unchanged. /health and the dashboard stay open.
      if (method === 'GET' && path === '/objectives') {
        const objs = listObjectives();
        return json(res, 200, authed ? objs : objs.map(redactObjective));
      }
      if (method === 'GET' && path === '/jobs') {
        const jobs = listJobs(url.searchParams.get('objective'));
        return json(res, 200, authed ? jobs : jobs.map(redactJob));
      }
      if (method === 'GET' && path === '/workers') return json(res, 200, authed ? listWorkers() : listWorkers().map(redactWorker));
      if (method === 'GET' && path === '/events') {
        // The event stream leaks objective titles, issue numbers, and worker activity — gate it
        // entirely for anonymous callers rather than trying to redact each payload.
        if (!authed) return json(res, 200, []);
        return json(res, 200, listEvents(Number(url.searchParams.get('limit') || 100)));
      }
      if (method === 'GET' && path === '/events/stream') {
        // Live event stream (Server-Sent Events) — the operator's `molt logs` tail. Same gating as
        // /events: an authed operator gets the full live stream; an anonymous caller on a gated
        // broker gets an open-but-empty stream (consistent with /events returning []).
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no', // ask proxies/ALB not to buffer the stream
        });
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, time: now(), live: authed })}\n\n`);
        const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* ignore */ } }, 15000);
        const unsub = authed
          ? subscribeEvents((evt) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* ignore */ } })
          : () => {};
        req.on('close', () => { clearInterval(hb); unsub(); });
        return; // keep the connection open
      }
      if (method === 'GET' && path === '/health') return json(res, 200, { ok: true, time: now() });
      if (method === 'GET' && path === '/readiness') {
        // /health is liveness (open, for the ECS container check). /readiness is the work-distribution
        // question and exposes backlog + capability detail, so on a gated broker anonymous callers get
        // only the coarse verdict (ready/status) — same gating posture as /events.
        const r = readiness();
        return json(res, 200, authed ? r : { ok: r.ok, ready: r.ready, status: r.status, time: r.time });
      }

      // Admin control plane. Runtime config + admin read-views feed the operator console. Every
      // handler body is wrapped so a query/import error returns a 500 JSON, NEVER an unhandled throw
      // that crashes the server (the outer try/catch also catches, but we keep these self-contained so
      // one bad view can't take down an otherwise-healthy request). Redaction uses the SAME `authed`
      // notion as /workers: danger knob values are redacted by getConfigSnapshot when !authed, and
      // /reputation returns [] for anonymous callers (operator-only detail).
      if (method === 'GET' && path === '/admin/config') {
        // Read the runtime knob snapshot. getConfigSnapshot redacts `danger` values when !authed.
        try {
          if (!getConfigSnapshot) return json(res, 500, { error: 'admin config module not loaded' });
          return json(res, 200, { knobs: getConfigSnapshot({ authed }) });
        } catch (e) { return json(res, 500, { error: `config snapshot failed: ${e.message}` }); }
      }
      if (method === 'POST' && path === '/admin/config') {
        // Setting an override is operator-only: refuse anonymous callers outright (defence in depth —
        // setOverride also rejects unauthorized, but we never even attempt it without auth). On a gated
        // broker requiresOperatorAuth already 401s any POST when unauthed; this guard makes the rule
        // explicit and correct even when MOLT_AUTH is off but the caller is still considered !authed.
        if (!authed) return json(res, 401, { error: 'unauthorized' });
        try {
          if (!setOverride) return json(res, 500, { error: 'admin config module not loaded' });
          const r = setOverride(body.key, body.value, { authed });
          return json(res, r.ok ? 200 : 400, r);
        } catch (e) { return json(res, 500, { error: `set override failed: ${e.message}` }); }
      }
      if (method === 'POST' && path === '/admin/restart') {
        // Operator-only: exit the process to apply PENDING restart-tier overrides. On ECS the service
        // replaces the task (which boots via applyStoredOverrides); locally a supervisor restarts it.
        // Respond 200 FIRST, then exit a beat later so the client receives the ack before the socket drops.
        if (!authed) return json(res, 401, { error: 'unauthorized' });
        json(res, 200, { ok: true, restarting: true });
        console.log('[broker] operator-requested restart — exiting to apply pending restart overrides');
        setTimeout(() => process.exit(0), 250);
        return;
      }
      if (method === 'GET' && path === '/admin/summary') {
        // Aggregate operator dashboard summary (workers / queue-by-capability / fuel / readiness).
        try {
          if (!adminSummary) return json(res, 500, { error: 'admin queries module not loaded' });
          return json(res, 200, adminSummary());
        } catch (e) { return json(res, 500, { error: `admin summary failed: ${e.message}` }); }
      }
      if (method === 'GET' && path === '/deliberations') {
        // Deliberation panels + their seats (quorum debate visibility). Open read-view.
        try {
          if (!deliberationsView) return json(res, 500, { error: 'admin queries module not loaded' });
          return json(res, 200, deliberationsView());
        } catch (e) { return json(res, 500, { error: `deliberations view failed: ${e.message}` }); }
      }
      if (method === 'GET' && path === '/reputation') {
        // Per-worker capability reputation detail. Redact for anonymous callers like /workers:
        // an unauthed caller on a gated broker gets [] rather than owner/trust/event detail.
        try {
          if (!authed) return json(res, 200, []);
          if (!reputationView) return json(res, 500, { error: 'admin queries module not loaded' });
          return json(res, 200, reputationView());
        } catch (e) { return json(res, 500, { error: `reputation view failed: ${e.message}` }); }
      }

      // Per-node invites. Same defensive posture as the other /admin routes: each handler body is
      // wrapped so a thrown error returns 500 JSON rather than crashing the server. Mutating routes
      // (create/revoke) are operator-only; the list mirrors /reputation (operator-only detail, [] anon).
      if (method === 'POST' && path === '/admin/invites') {
        // Mint a new invite — returns the one-time token (shown ONCE). Operator-only.
        if (!authed) return json(res, 401, { error: 'unauthorized' });
        try {
          const r = createInvite({ label: body.label ?? null, maxUses: body.max_uses ?? null, createdBy: 'operator' });
          return json(res, 200, r);
        } catch (e) { return json(res, 500, { error: `create invite failed: ${e.message}` }); }
      }
      if (method === 'GET' && path === '/admin/invites') {
        // List invites (uses/limits/revocation status). Operator-only detail; [] for anonymous callers.
        try {
          return json(res, 200, authed ? listInvites() : []);
        } catch (e) { return json(res, 500, { error: `list invites failed: ${e.message}` }); }
      }
      const revokeInviteMatch = path.match(/^\/admin\/invites\/([^/]+)\/revoke$/);
      if (method === 'POST' && revokeInviteMatch) {
        // Revoke an invite by id so it can no longer admit nodes. Operator-only.
        if (!authed) return json(res, 401, { error: 'unauthorized' });
        try {
          const r = revokeInvite(revokeInviteMatch[1]);
          return json(res, r.ok ? 200 : 404, r);
        } catch (e) { return json(res, 500, { error: `revoke invite failed: ${e.message}` }); }
      }

      // Dashboard
      if (method === 'GET') return await serveStatic(req, res, path);

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err?.stack || err) });
    }
  });

  setInterval(sweepLeases, DEFAULTS.leaseSweepSeconds * 1000).unref();
  setInterval(sweepWorkers, DEFAULTS.leaseSweepSeconds * 1000).unref();

  server.listen(BROKER.port, BROKER.host, () => {
    console.log(`[broker] listening on ${BROKER.url}`);
    console.log(`[broker] dashboard at ${BROKER.url}/dashboard`);
  });
  return server;
}
