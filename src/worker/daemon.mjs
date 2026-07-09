// molt-worker: a local daemon that pulls work from the broker and executes it with a
// locally-authenticated adapter. The broker never sees credentials — the adapter owns
// the logged-in session on this machine (WHITEPAPER §5/§9).
//
// Durability contract ("just tell it go or stop; it survives breakage"): every network call is
// bounded by a timeout, every failure retries with capped jittered backoff instead of crashing, the
// worker RE-REGISTERS if the broker forgets it (restart/eviction), and `stop` drains the in-flight
// job (submits its result, cleans its worktree) before exiting.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { BROKER, DEFAULTS, PATHS, AUTH, GAME } from '../shared/config.mjs';
import { workerId as mkWorkerId } from '../shared/ids.mjs';
import { loadOrCreateAgentKey, ensureClaimed } from './agent-identity.mjs';
import { resolveJoinToken } from './join-credential.mjs';
import { getAdapter, resolveAdapter, listAdapters, adapterMeta } from './adapters/index.mjs';
import { preflightReport } from './preflight.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Capped exponential backoff with jitter — so a fleet recovering from a shared outage doesn't
// stampede the broker in lockstep. `attempt` grows the delay; jitter (0.5–1.5x) de-synchronizes.
const backoff = (attempt, base = 1000, cap = 30000) =>
  Math.min(cap, base * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random());

let inflight = null; // AbortController for the job currently running (stop/reassign can abort it)

function authHeaders() {
  const h = { 'content-type': 'application/json' };
  if (AUTH.apiKey) h.authorization = `Bearer ${AUTH.apiKey}`;
  return h;
}

// POST to the broker. Bounded by a timeout (a hung connection must not freeze a loop forever) and
// surfaces the HTTP status as `_status` so callers can distinguish 429/5xx from a real result.
async function api(path, body, { timeoutMs = 8000 } = {}) {
  const res = await fetch(`${BROKER.url}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let out = {};
  try { out = await res.json(); } catch { out = {}; }
  if (out && typeof out === 'object') out._status = res.status;
  return out;
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

  // Connect-time preflight (WHITEPAPER §8): detect() only proves a tool is PRESENT, not authed. Run
  // the DEEP auth/reachability probe now and print a doctor-style block, so the operator sees BEFORE
  // we advertise — a tool that's installed-but-logged-out would otherwise claim jobs and fail them
  // closed, each failure a `rejected` reputation hit. Default = warn-and-proceed (this runs headless
  // under go-live.sh, so it must NEVER block by default). --strict turns the same findings into a
  // hard refusal: if the preferred baseline is unmet OR any advertised capability is backed by an
  // unauthed tool, we exit(1) instead of registering.
  const { strictBlocked } = await preflightReport({ enabled, capabilities, strict: !!opts.strict });
  if (strictBlocked) {
    console.error('[worker] --strict preflight failed — not registering. Fix the above or drop the adapter.');
    process.exit(1);
  }

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

  // Identity: when the grid requires claimed agents, sign each registration with this keypair; the
  // broker verifies it with the game. We register FIRST and only run the interactive claim if the
  // broker reports we're not bound yet — so an already-claimed agent reconnects with NO prompt.
  const agentKey = GAME.requireIdentity ? loadOrCreateAgentKey() : null;
  const NEEDS_CLAIM = new Set(['agent_not_claimed', 'agent_not_verified', 'agent_credential_missing']);
  const TRANSIENT = new Set(['identity_authority_unreachable', 'agent_auth_stale']);
  const registerBody = () => ({
    worker_id: id,
    owner_id: opts.owner || hostname(),
    trust_tier: trustTier,
    max_slots: maxSlots,
    manifest,
    agent: agentKey ? agentKey.buildAuth() : undefined, // fresh-signed each attempt (bounds replay)
    // Operator-issued join credential, resolved FRESH each attempt: MOLT_JOIN_SECRET env first, else the
    // token persisted by `molt worker join` (.molt-join.json). Re-reading per attempt means a worker that
    // started before being joined picks up the token the moment the operator runs `molt worker join` —
    // no restart needed. The broker rejects registration without it when the grid's join gate is on.
    join_token: resolveJoinToken() || undefined,
  });

  // Register the worker, retrying durably through every failure mode. Reusable so the heartbeat /
  // claim loops can re-register if the broker later forgets this worker. `interactive:true` allows
  // the one-time human claim prompt (startup only); re-registrations run silently.
  let claimedOnce = false;
  // The most recent successful register response — kept so we can read the broker's grid-demand
  // `coverage` block (added to /workers/register) after registration without changing register()'s
  // return contract (callers only ever need the worker id).
  let lastRegister = null;
  async function register({ interactive = false } = {}) {
    let attempt = 0, settling = false, staleWarned = false, joinHintShown = false;
    for (;;) {
      let reg;
      try {
        reg = await api('/workers/register', registerBody(), { timeoutMs: 15000 });
      } catch {
        console.log('[worker] broker unreachable — retrying…');
        await sleep(backoff(attempt++));
        continue;
      }
      const status = reg._status || 0;
      // Non-2xx WITHOUT an identity verdict (rate limit, 5xx, transient auth) → back off + retry,
      // never mistake it for a successful registration.
      if (status >= 400 && reg.ok !== false) {
        console.log(`[worker] register HTTP ${status} — retrying…`);
        await sleep(backoff(attempt++));
        continue;
      }
      if (reg && reg.ok === false) {
        if (agentKey && NEEDS_CLAIM.has(reg.error)) {
          if (interactive && !claimedOnce) {
            // First confirmation on this account — waits indefinitely, auto-refreshing the code.
            await ensureClaimed({ key: agentKey, gameUrl: GAME.url, label: opts.owner || hostname(), timeoutMs: 0 });
            claimedOnce = true; attempt = 0; continue;
          }
          // Already confirmed (or a silent re-register): the binding may still be propagating to the
          // broker — keep retrying with backoff instead of exiting on a transient consistency lag.
          if (!settling) { console.log('[worker] waiting for the identity binding to settle…'); settling = true; }
          await sleep(backoff(attempt++, 1000, 15000));
          continue;
        }
        if (TRANSIENT.has(reg.error)) {
          if (reg.error === 'agent_auth_stale' && attempt >= 6 && !staleWarned) {
            console.error("[worker] agent_auth_stale persists — this machine's clock is likely >5min off the broker; NTP-sync it.");
            staleWarned = true;
          }
          console.log(`[worker] ${reg.error} — retrying…`);
          await sleep(backoff(attempt++));
          continue;
        }
        if (reg.error === 'claim was denied' || reg.error === 'agent_denied') {
          console.error('[worker] this agent was denied — exiting. Re-run to claim a fresh key.');
          process.exit(1);
        }
        // The grid's join gate rejected our token (missing / unknown / revoked / exhausted). This is the
        // single most common onboarding failure, so make it ACTIONABLE instead of an opaque retry spin:
        // tell the operator exactly what to run. We keep retrying (durable by default) because the token
        // is re-read each attempt — running `molt worker join <token>` in another shell unblocks this
        // process live, no restart. The hint prints once so the loop doesn't spam.
        if (reg.error === 'join_denied') {
          if (!joinHintShown) {
            const had = !!resolveJoinToken();
            console.error(
              had
                ? '[worker] join_denied — the broker rejected your join token (unknown, revoked, or used up).\n' +
                    '         Get a fresh invite from the operator, then run:  molt worker join <token>'
                : '[worker] join_denied — this grid is invite-only and no join token is set.\n' +
                    '         Ask the operator for an invite (looks like inv_xxxx.yyyy), then run:  molt worker join <token>\n' +
                    '         (waiting — once you join in another terminal, this worker connects automatically.)'
            );
            joinHintShown = true;
          }
          await sleep(backoff(attempt++, 2000, 15000));
          continue;
        }
        // Unrecognized rejection — durable by default: back off and retry rather than crash.
        console.log(`[worker] registration rejected (${reg.error || 'unknown'}) — retrying…`);
        await sleep(backoff(attempt++));
        continue;
      }
      lastRegister = reg;
      return reg.worker_id || id;
    }
  }

  const myId = await register({ interactive: true });
  console.log(`[worker] ${myId} online — adapters: ${enabled.join(', ')}`);
  console.log(`[worker] capabilities: ${capabilities.join(', ')}`);
  // Grid-demand coverage (broker contract, optional): which QUEUED capabilities this node can/can't
  // serve right now. Consume it if present; degrade silently if the broker doesn't send it.
  printCoverage(lastRegister?.coverage);

  let activeSlots = 0;
  let stopped = false;
  let forceTimer = null;
  // Graceful shutdown for BOTH signals: SIGINT (Ctrl-C) and SIGTERM (what `molt stop` sends). Flip
  // `stopped`, abort the in-flight job so it submits a result + cleans its worktree, then exit once
  // the loops drain. A hard cap bounds `stop` even if a job ignores the abort; a 2nd signal forces.
  const shutdown = (sig) => {
    if (stopped) { process.exit(0); return; }
    stopped = true;
    console.log(`\n[worker] ${sig} — finishing in-flight work, then stopping…`);
    if (inflight) { try { inflight.abort(); } catch { /* ignore */ } }
    forceTimer = setTimeout(() => process.exit(0), 12000);
    forceTimer.unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // heartbeat — also a second, independent recovery trigger: if the broker reports it no longer
  // knows this worker, re-register (works even while the claim loop is busy in a job).
  (async function heartbeatLoop() {
    let fails = 0;
    while (!stopped) {
      try {
        const hb = await api('/workers/heartbeat', { worker_id: myId }, { timeoutMs: 5000 });
        if (hb && hb.error === 'unknown_worker') {
          console.warn('[worker] broker no longer has our registration — re-registering…');
          await register({ interactive: false });
        }
        fails = 0;
      } catch {
        if (++fails === 3) console.warn('[worker] heartbeats failing — broker may have dropped this worker; jobs may be reassigned.');
      }
      await sleep(DEFAULTS.heartbeatSeconds * 1000);
    }
  })();

  // claim/work loop
  let claimAttempt = 0;
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
    } catch {
      console.log('[worker] broker unreachable, retrying…');
      await sleep(backoff(claimAttempt++, DEFAULTS.claimPollSeconds * 1000, 30000));
      continue;
    }
    if (stopped) break;

    // Broker forgot us (fresh DB / eviction) → re-register instead of polling an empty void forever.
    if (claim && claim.error === 'unknown_worker') {
      console.warn('[worker] broker lost our registration — re-registering…');
      await register({ interactive: false });
      claimAttempt = 0;
      continue;
    }
    // Throttled → back off (don't mistake a 429 for "no work available").
    if (claim && claim._status === 429) {
      await sleep(backoff(claimAttempt++, DEFAULTS.claimPollSeconds * 1000, 30000));
      continue;
    }
    claimAttempt = 0;

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

  // Loops drained on `stopped` — exit cleanly (in-flight result submitted, worktree cleaned).
  if (forceTimer) clearTimeout(forceTimer);
  console.log('[worker] stopped.');
  process.exit(0);
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
      // If the broker has reassigned/forgotten the job (404/409), stop burning compute on it.
      saveCheckpoint: async (state) => {
        const r = await api(`/jobs/${job.job_id}/checkpoint`, { lease_token: job.lease_token, state }).catch(() => null);
        if (r && (r._status === 404 || r._status === 409)) {
          console.warn(`[worker] checkpoint rejected (${r.error || r._status}) — job was reassigned; aborting to stop wasting compute.`);
          try { inflight?.abort(); } catch { /* ignore */ }
        }
        return r;
      },
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

    const result = await submit(job, { lease_token: job.lease_token, ...draft, artifacts });
    if (result && (result.error === 'submit_failed' || result._status === 404 || result._status === 409)) {
      console.warn(`[worker] ${job.job_id} result not accepted (${result.error || result._status}).`);
    } else {
      console.log(`[worker] submitted ${job.job_id} (${draft.status})`);
    }
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

// Render the broker's grid-demand coverage block (optional contract):
//   coverage: { worker_capabilities, pending_by_capability:{cap:count}, uncovered:[], covered:[] }
// One line per pending capability, tagged covered / UNCOVERED, then a note if anything queued can't
// be claimed by this node. Absent coverage → print nothing (the broker may be an older build).
function printCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object') return;
  const pending = coverage.pending_by_capability || {};
  const covered = new Set(coverage.covered || []);
  const caps = Object.keys(pending);
  if (caps.length) {
    const parts = caps.map((cap) => {
      const n = pending[cap];
      const tag = covered.has(cap) ? 'covered' : 'UNCOVERED — no local adapter';
      return `${cap}×${n} (${tag})`;
    });
    console.log(`[worker] Grid demand: ${parts.join(', ')}`);
  }
  const uncovered = coverage.uncovered || [];
  if (uncovered.length) {
    console.log(`[worker] note: queued ${uncovered.join(', ')} job(s) won't be claimed by this node (no matching adapter).`);
  }
}

// Submit a result durably: bounded by a timeout, retried with backoff on transient failure, and —
// if it still can't be delivered — persisted to disk so finished (possibly paid-for) work is never
// silently lost. A 404/409 means the job was reassigned/the lease expired: terminal, so we stop.
async function submit(job, body, { retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BROKER.url}/jobs/${job.job_id}/result`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok) {
        if (out.verdict) {
          console.log(`[worker] broker verdict: ${out.verdict.pass ? 'PASS' : 'FAIL'}${out.verdict.reasons?.length ? ' — ' + out.verdict.reasons.join('; ') : ''}`);
        }
        return out;
      }
      if (res.status === 404 || res.status === 409) {
        console.warn(`[worker] result for ${job.job_id} rejected (${out.error || res.status}) — job was reassigned; dropping.`);
        return { ...out, _status: res.status };
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await sleep(backoff(attempt, 1000, 15000));
  }
  // Exhausted retries — don't silently lose finished work; persist it for replay + log loudly.
  try {
    const p = join(artifactsDirFor(job), 'unsent-result.json');
    writeFileSync(p, JSON.stringify(body, null, 2));
    console.error(`[worker] could not submit ${job.job_id} after ${retries} retries (${lastErr?.message}); saved result to ${p}`);
  } catch {
    console.error(`[worker] could not submit ${job.job_id} (${lastErr?.message}) and could not persist it.`);
  }
  return { error: 'submit_failed' };
}
