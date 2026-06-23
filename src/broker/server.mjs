// The broker: the grid's control plane. Pull-based — workers ask for work (WHITEPAPER §5).
// Zero-dep node:http. Endpoints follow §11; read endpoints feed the dashboard.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { getDb, now, nextSeq, logEvent, parseRow, transaction } from './db.mjs';
import { objectiveId as mkObjectiveId, workerId as mkWorkerId, leaseToken, checkpointId } from '../shared/ids.mjs';
import { BROKER, DEFAULTS, PATHS, FUEL } from '../shared/config.mjs';
import { planObjective } from './planner.mjs';
import { pickJob, workerOffersBedrock } from './scheduler.mjs';
import { onResult } from './lifecycle.mjs';
import { reputationFor, recordEvent } from './reputation.mjs';
import { buildResultCtx, approveObjective } from './broker-ops.mjs';
import { listIssues } from './gh.mjs';
import { parseDependencyIssues, recordObjectiveDeps, resolveAndGate, unsatisfiedDepsFor, clearObjectiveHold, clearNeedsReview, applyObjectiveGatingStatus } from './objective-deps.mjs';
import { setIntegrationInfer } from './agents/integration-agent.mjs';
import { setPlannerInfer } from './agents/planner-agent.mjs';
import { importKey } from './keys.mjs';
import { makeProviderInfer } from './agents/deliberate.mjs';
import { getAdapter } from '../worker/adapters/index.mjs';
import { getBalance, creditFuel, fuelLog, reserveFuel, refundFuel, estimateJobCost, estimateCost, chargeFuel, PRIMARY_ACCOUNT, recordPayout } from './fuel.mjs';
import { verifyPayment, settlePayment, buildPaymentRequirement, centsToMicro, extractPaymentHeader } from './payments/x402.mjs';

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

async function registerWorker(body) {
  const d = getDb();
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
  logEvent('worker', id, 'registered', { capabilities: manifest.capabilities });
  return { worker_id: id };
}

function heartbeat(body) {
  getDb().prepare('UPDATE workers SET last_heartbeat=?, status=? WHERE id=?').run(now(), 'online', body.worker_id);
  return { ok: true };
}

function claim(body) {
  const d = getDb();
  const workerId = body.worker_id;
  // Verify-don't-trust: a worker must be registered, and EVERY scheduling gate value is read from
  // server state — capabilities/max_slots from the registered manifest row, active_slots from a
  // live count, trust from earned reputation — never from the claim body.
  const row = d.prepare('SELECT * FROM workers WHERE id=?').get(workerId);
  if (!row) return { job: null, reason: 'worker not registered' };
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
  const seq = (job.checkpoint_seq || 0) + 1;
  transaction(() => {
    d.prepare(
      `INSERT INTO checkpoints(id, job_id, worker_id, seq, state_json, note, created_at) VALUES(?,?,?,?,?,?,?)`
    ).run(checkpointId(), jobId, job.assigned_worker_id, seq, JSON.stringify(body.state || {}), body.note || null, now());
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

async function submitResult(jobId, body) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) return { error: 'unknown job', code: 404 };
  if (!body.lease_token || body.lease_token !== job.lease_token) {
    return { error: 'invalid or expired lease', code: 409 };
  }

  // mark completed + free the worker slot
  d.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run('completed', now(), jobId);
  if (job.assigned_worker_id) {
    d.prepare('UPDATE workers SET active_slots = MAX(0, active_slots - 1) WHERE id=?').run(job.assigned_worker_id);
  }

  // record artifacts the worker wrote to the shared artifacts dir
  for (const a of body.artifacts || []) {
    d.prepare(
      `INSERT INTO artifacts(job_id, worker_id, kind, path, hash, created_at) VALUES(?,?,?,?,?,?)`
    ).run(jobId, job.assigned_worker_id, a.kind, a.path || null, a.hash || null, now());
  }
  logEvent('job', jobId, 'result_submitted', { status: body.status });

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
  return rows.map((j) => ({
    ...j,
    depends_on: d.prepare('SELECT depends_on_job_id FROM job_dependencies WHERE job_id=?').all(j.id).map((r) => r.depends_on_job_id),
  }));
}
function listWorkers() {
  return getDb()
    .prepare('SELECT * FROM workers ORDER BY created_at ASC')
    .all()
    .map((w) => ({ ...w, reputation: reputationFor(w.id) }));
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
  const { prompt, spec_json, contract_json, payload_json, last_failed_worker_id, ...rest } = j;
  return rest;
}
function redactFuelEntry(e) {
  // Keep coarse shape (kind/amount/time) but drop the free-text note, wallet, and any payload.
  const { note, payload_json, wallet_address, account_id, ...rest } = e;
  return rest;
}
function redactWorker(w) {
  // Anonymous callers get coarse status only — never owner_id, the full manifest, or heartbeat ts.
  return { id: w.id, status: w.status, trust_tier: w.trust_tier, active_slots: w.active_slots, max_slots: w.max_slots, reputation: w.reputation };
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
    const data = await readFile(filePath);
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
function maybeEnableAgents() {
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
    ? () => { if (getBalance(PRIMARY_ACCOUNT) < FUEL.minBalance) throw new Error('insufficient fuel for premium agent call'); }
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
  const sharedInfer = () => (infer ||= makeProviderInfer({ getAdapter, tierAdapters, tierModels, log: () => {}, budgetGate, meter }));
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
    const r = importKey(raw, { name: 'bootstrap' });
    console.log(r.seeded ? `[broker] bootstrap API key seeded (id=${r.id})` : `[broker] bootstrap API key already present (id=${r.id})`);
  } catch (e) {
    console.log(`[broker] bootstrap key NOT seeded: ${e.message}`);
  }
}

export function startBroker() {
  getDb(); // bootstrap schema
  seedBootstrapKey();
  maybeEnableAgents();
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
      if (method === 'POST' && path === '/workers/register') return json(res, 200, await registerWorker(body));
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
      if (method === 'GET' && path === '/health') return json(res, 200, { ok: true, time: now() });

      // Dashboard
      if (method === 'GET') return await serveStatic(req, res, path);

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err?.stack || err) });
    }
  });

  setInterval(sweepLeases, DEFAULTS.leaseSweepSeconds * 1000).unref();

  server.listen(BROKER.port, BROKER.host, () => {
    console.log(`[broker] listening on ${BROKER.url}`);
    console.log(`[broker] dashboard at ${BROKER.url}/dashboard`);
  });
  return server;
}
