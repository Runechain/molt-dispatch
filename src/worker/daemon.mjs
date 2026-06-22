// molt-worker: a local daemon that pulls work from the broker and executes it with a
// locally-authenticated adapter. The broker never sees credentials — the adapter owns
// the logged-in session on this machine (WHITEPAPER §5/§9).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { BROKER, DEFAULTS, PATHS, AUTH } from '../shared/config.mjs';
import { workerId as mkWorkerId } from '../shared/ids.mjs';
import { getAdapter, resolveAdapter, listAdapters, adapterMeta } from './adapters/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inflight = null; // AbortController for the job currently running (so SIGINT can stop it)

function authHeaders() {
  const h = { 'content-type': 'application/json' };
  if (AUTH.apiKey) h.authorization = `Bearer ${AUTH.apiKey}`;
  return h;
}

async function api(path, body) {
  const res = await fetch(`${BROKER.url}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function startWorker(opts = {}) {
  mkdirSync(PATHS.worktrees, { recursive: true });
  mkdirSync(PATHS.artifacts, { recursive: true });

  const requested = opts.adapters && opts.adapters.length ? opts.adapters : listAdapters();
  // Keep only adapters whose runtime is actually available locally.
  const enabled = [];
  for (const name of requested) {
    const a = getAdapter(name);
    if (a && (await a.detect())) enabled.push(name);
    else if (a) console.log(`[worker] adapter '${name}' unavailable (runtime not detected) — skipping`);
  }
  if (enabled.length === 0) {
    console.error('[worker] no usable adapters. Try --adapters mock, or log into claude/codex.');
    process.exit(1);
  }

  const capabilities = [...new Set(enabled.flatMap((n) => getAdapter(n).capabilities))];
  const id = opts.workerId || mkWorkerId(opts.owner || hostname());
  const trustTier = opts.trustTier ?? Number(process.env.MOLT_TRUST ?? 4);
  const maxSlots = opts.maxSlots ?? 1;

  // Heterogeneous manifest: advertise the concrete provider/model behind each enabled adapter
  // so the broker can match inference jobs to nodes and score reputation per model.
  const models = enabled.map(adapterMeta).filter((m) => m && m.kind === 'provider' && m.model);
  const manifest = {
    capabilities,
    interfaces: Object.fromEntries(enabled.map((n) => [n, { available: true }])),
    models,
  };
  if (models.length) console.log(`[worker] models: ${models.map((m) => `${m.provider}:${m.model}`).join(', ')}`);
  const reg = await api('/workers/register', {
    worker_id: id,
    owner_id: opts.owner || hostname(),
    trust_tier: trustTier,
    max_slots: maxSlots,
    manifest,
  });
  const myId = reg.worker_id || id;
  console.log(`[worker] ${myId} online — adapters: ${enabled.join(', ')}`);
  console.log(`[worker] capabilities: ${capabilities.join(', ')}`);

  let activeSlots = 0;
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    if (inflight) {
      try {
        inflight.abort();
      } catch {
        /* ignore */
      }
    }
    console.log('\n[worker] shutting down');
    process.exit(0);
  });

  // heartbeat
  (async function heartbeatLoop() {
    while (!stopped) {
      await api('/workers/heartbeat', { worker_id: myId }).catch(() => {});
      await sleep(DEFAULTS.heartbeatSeconds * 1000);
    }
  })();

  // claim/work loop
  while (!stopped) {
    if (activeSlots >= maxSlots) {
      await sleep(DEFAULTS.claimPollSeconds * 1000);
      continue;
    }
    let claim;
    try {
      claim = await api('/jobs/claim', {
        worker_id: myId,
        capabilities,
        trust_tier: trustTier,
        max_slots: maxSlots,
        active_slots: activeSlots,
      });
    } catch (err) {
      console.log('[worker] broker unreachable, retrying...');
      await sleep(DEFAULTS.claimPollSeconds * 1000);
      continue;
    }

    if (!claim || !claim.job) {
      await sleep(DEFAULTS.claimPollSeconds * 1000);
      continue;
    }

    activeSlots++;
    // Run sequentially in M1; structure allows parallel later.
    await executeJob(claim.job, enabled, myId).catch((err) => {
      console.error(`[worker] job ${claim.job.job_id} errored:`, err?.message || err);
    });
    activeSlots--;
  }
}

async function executeJob(job, enabledNames, myId) {
  console.log(`[worker] claimed ${job.job_id} (${job.type}) — ${job.title}`);
  const picked = await resolveAdapter(job, enabledNames);
  if (!picked) {
    await submit(job, { lease_token: job.lease_token, status: 'failed', error: 'no adapter for capability ' + job.capability_required });
    return;
  }
  console.log(`[worker] -> adapter '${picked.name}'`);

  // Worktree isolation: only for jobs that touch a repo and a non-mock adapter (M2+).
  let workspace = null;
  const needsWorktree = picked.name !== 'mock' && job.repo;
  try {
    if (needsWorktree) {
      const ws = await import('./workspace.mjs');
      workspace = await ws.prepareWorktree(job);
    }

    inflight = new AbortController();
    const artifactsDir = artifactsDirFor(job);
    const ctx = {
      worktree: workspace?.dir || null,
      artifactsDir,
      log: (m) => console.log(`   ${m}`),
      // Resumable handoff: providers stream partial progress here; if this worker dies the
      // broker keeps the latest checkpoint and the next worker continues from it.
      checkpoint: job.checkpoint || null,
      signal: inflight.signal,
      saveCheckpoint: (state) => api(`/jobs/${job.job_id}/checkpoint`, { lease_token: job.lease_token, state }),
    };
    if (job.checkpoint) console.log(`[worker] resuming ${job.job_id} from checkpoint`);

    const draft = await picked.adapter.run(job, ctx);
    draft.review_worker_id = myId;

    // collect artifacts the workspace captured (patch/status/tests), if any
    let artifacts = workspace ? await workspace.capture(draft) : draft.artifacts || [];
    // Persist inference completions to a file artifact (inline text isn't stored by the broker).
    if (draft.output != null) {
      const p = join(artifactsDir, 'completion.txt');
      writeFileSync(p, String(draft.output));
      artifacts = [{ kind: 'completion', path: p }, ...artifacts.filter((a) => a.kind !== 'completion')];
    }

    await submit(job, { lease_token: job.lease_token, ...draft, artifacts });
    console.log(`[worker] submitted ${job.job_id} (${draft.status})`);
  } catch (err) {
    await submit(job, { lease_token: job.lease_token, status: 'failed', error: String(err?.message || err) });
    console.error(`[worker] ${job.job_id} failed:`, err?.message || err);
  } finally {
    // Implementation worktrees are kept so the broker can run static/automated validation
    // against them and merge on approval; the broker removes them later. Other jobs
    // (e.g. review) own their worktree and clean it up here.
    inflight = null;
    const brokerOwnsWorktree = job.type === 'code.implementation';
    if (workspace?.cleanup && !brokerOwnsWorktree) await workspace.cleanup().catch(() => {});
  }
}

function artifactsDirFor(job) {
  const dir = `${PATHS.artifacts}/${job.job_id}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function submit(job, body) {
  const res = await fetch(`${BROKER.url}/jobs/${job.job_id}/result`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (out.verdict) {
    console.log(`[worker] broker verdict: ${out.verdict.pass ? 'PASS' : 'FAIL'}${out.verdict.reasons?.length ? ' — ' + out.verdict.reasons.join('; ') : ''}`);
  }
  return out;
}
