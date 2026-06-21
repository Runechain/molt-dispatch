// The broker: the grid's control plane. Pull-based — workers ask for work (WHITEPAPER §5).
// Zero-dep node:http. Endpoints follow §11; read endpoints feed the dashboard.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { getDb, now, nextSeq, logEvent, parseRow, transaction } from './db.mjs';
import { objectiveId as mkObjectiveId, workerId as mkWorkerId, leaseToken } from '../shared/ids.mjs';
import { BROKER, DEFAULTS, PATHS } from '../shared/config.mjs';
import { planObjective } from './planner.mjs';
import { pickJob } from './scheduler.mjs';
import { onResult } from './lifecycle.mjs';
import { reputationFor } from './reputation.mjs';
import { buildResultCtx, approveObjective } from './broker-ops.mjs';

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// ---- Route handlers ----------------------------------------------------------

async function registerWorker(body) {
  const d = getDb();
  const id = body.worker_id || mkWorkerId(body.owner_id || 'worker');
  const existing = d.prepare('SELECT id FROM workers WHERE id = ?').get(id);
  const manifest = body.manifest || { capabilities: body.capabilities, interfaces: body.interfaces };
  if (existing) {
    d.prepare(
      `UPDATE workers SET status='online', last_heartbeat=?, trust_tier=?, manifest_json=?, max_slots=? WHERE id=?`
    ).run(now(), body.trust_tier ?? 0, JSON.stringify(manifest), body.max_slots ?? 1, id);
  } else {
    d.prepare(
      `INSERT INTO workers(id, owner_id, status, last_heartbeat, trust_tier, manifest_json, active_slots, max_slots, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(id, body.owner_id || null, 'online', now(), body.trust_tier ?? 0, JSON.stringify(manifest), 0, body.max_slots ?? 1, now());
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
  d.prepare('UPDATE workers SET last_heartbeat=?, status=? WHERE id=?').run(now(), 'online', body.worker_id);
  const worker = {
    id: body.worker_id,
    capabilities: body.capabilities || [],
    trust_tier: body.trust_tier ?? 0,
    adapter_hint: body.adapter_hint,
    max_slots: body.max_slots ?? 1,
    active_slots: body.active_slots ?? 0,
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

  const objective = parseRow(d.prepare('SELECT * FROM objectives WHERE id=?').get(job.objective_id), ['contract_json']);
  const spec = job.spec_json ? JSON.parse(job.spec_json) : {};
  logEvent('job', job.id, 'claimed', { worker: worker.id });

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
    },
  };
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

function createObjective(body) {
  const d = getDb();
  const id = mkObjectiveId(nextSeq('objective'));
  const contract = body.contract || {};
  d.prepare(
    `INSERT INTO objectives(id, title, prompt, repo, branch_base, contract_json, status, created_by, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    body.title,
    body.prompt || null,
    body.repo || null,
    body.branch_base || 'main',
    JSON.stringify(contract),
    'planning',
    body.created_by || 'cli',
    now(),
    now()
  );
  logEvent('objective', id, 'created', { title: body.title });

  const objective = parseRow(d.prepare('SELECT * FROM objectives WHERE id=?').get(id), ['contract_json']);
  const jobs = planObjective(objective);
  d.prepare('UPDATE objectives SET status=?, updated_at=? WHERE id=?').run('in_progress', now(), id);
  return { objective_id: id, jobs };
}

// ---- Read endpoints (dashboard / CLI status) ---------------------------------

function listObjectives() {
  return getDb().prepare('SELECT * FROM objectives ORDER BY created_at DESC').all();
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

// ---- Lease sweep: requeue jobs whose worker died (lease expired) --------------

function sweepLeases() {
  const d = getDb();
  const expired = d
    .prepare(`SELECT * FROM jobs WHERE status='claimed' AND lease_until IS NOT NULL AND lease_until < ?`)
    .all(now());
  for (const job of expired) {
    d.prepare(
      `UPDATE jobs SET status='pending', lease_token=NULL, lease_until=NULL, assigned_worker_id=NULL, updated_at=? WHERE id=?`
    ).run(now(), job.id);
    d.prepare(`UPDATE assignments SET status='expired', finished_at=? WHERE job_id=? AND finished_at IS NULL`).run(now(), job.id);
    if (job.assigned_worker_id) {
      d.prepare('UPDATE workers SET active_slots = MAX(0, active_slots - 1) WHERE id=?').run(job.assigned_worker_id);
    }
    logEvent('job', job.id, 'lease_expired', { worker: job.assigned_worker_id });
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
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ---- Server ------------------------------------------------------------------

export function startBroker() {
  getDb(); // bootstrap schema
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, BROKER.url);
    const path = url.pathname;
    const method = req.method;
    try {
      // API
      if (method === 'POST' && path === '/workers/register') return json(res, 200, await registerWorker(await readBody(req)));
      if (method === 'POST' && path === '/workers/heartbeat') return json(res, 200, heartbeat(await readBody(req)));
      if (method === 'POST' && path === '/jobs/claim') return json(res, 200, claim(await readBody(req)));
      const resultMatch = path.match(/^\/jobs\/([^/]+)\/result$/);
      if (method === 'POST' && resultMatch) {
        const r = await submitResult(resultMatch[1], await readBody(req));
        return json(res, r.code || 200, r);
      }
      if (method === 'POST' && path === '/objectives') return json(res, 200, createObjective(await readBody(req)));
      const approveMatch = path.match(/^\/objectives\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) return json(res, 200, await approveObjective(approveMatch[1]));

      if (method === 'GET' && path === '/objectives') return json(res, 200, listObjectives());
      if (method === 'GET' && path === '/jobs') return json(res, 200, listJobs(url.searchParams.get('objective')));
      if (method === 'GET' && path === '/workers') return json(res, 200, listWorkers());
      if (method === 'GET' && path === '/events') return json(res, 200, listEvents(Number(url.searchParams.get('limit') || 100)));
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
