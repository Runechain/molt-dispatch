// Central config + filesystem paths for the grid.
// Everything is rooted at the project dir so the whole thing is a single local install.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..'); // molt-dispatch/

// State root. Defaults to the project dir (single local install). MOLT_DATA_DIR relocates
// db/artifacts/worktrees — used by tests (temp dir) and by the deployed broker (EFS mount).
const DATA_ROOT = process.env.MOLT_DATA_DIR ? resolve(process.env.MOLT_DATA_DIR) : ROOT;

export const PATHS = {
  root: ROOT,
  data: join(DATA_ROOT, 'data'),
  db: join(DATA_ROOT, 'data', 'molt.db'),
  artifacts: join(DATA_ROOT, 'artifacts'),
  worktrees: join(DATA_ROOT, 'worktrees'),
  dashboard: join(ROOT, 'dashboard'), // static assets always ship with the code
};

export const BROKER = {
  host: process.env.MOLT_HOST || '127.0.0.1',
  port: Number(process.env.MOLT_PORT || 7077),
  // MOLT_BROKER_URL overrides the computed URL — set on workers that connect to the
  // deployed broker (e.g. MOLT_BROKER_URL=https://play.runechaingame.com/grid).
  get url() {
    return process.env.MOLT_BROKER_URL || `http://${this.host}:${this.port}`;
  },
  // Path prefix stripped by the broker before routing — set when behind an ALB path rule.
  // e.g. MOLT_PATH_PREFIX=/grid means /grid/jobs -> /jobs internally.
  pathPrefix: process.env.MOLT_PATH_PREFIX || '',
};

// RUNECHAIN game = the identity authority. The worker claims its agent keypair against a player's
// game account (POST /claim/start + poll); the broker verifies signed worker requests as a relying
// party (POST /claim/verify). requireIdentity gates this — OFF by default (keyless legacy grid),
// flip MOLT_REQUIRE_IDENTITY=1 on BOTH the broker and the worker to require claimed agents.
export const GAME = {
  // Lazy getters so a command (e.g. `molt go`) can set the env *after* this module loads.
  get url() { return (process.env.MOLT_GAME_URL || 'https://play.runechaingame.com').replace(/\/$/, ''); },
  get requireIdentity() { return process.env.MOLT_REQUIRE_IDENTITY === '1'; },
};

// Lease / scheduling defaults
export const DEFAULTS = {
  leaseSeconds: 1800, // 30 min default lease for a claimed job
  heartbeatSeconds: 10, // worker heartbeat cadence
  claimPollSeconds: 3, // worker poll cadence when idle
  leaseSweepSeconds: 15, // broker requeues expired leases this often
  workerStaleSeconds: Number(process.env.MOLT_WORKER_STALE_SECONDS) || 30, // no heartbeat in this window => reported offline (3x heartbeat)
};

// Team-gating. Off by default so the local quick-start needs no key; deployed/team
// installs set MOLT_AUTH=1. Clients (CLI/worker) send MOLT_API_KEY when present.
export const AUTH = {
  enabled: process.env.MOLT_AUTH === '1',
  apiKey: process.env.MOLT_API_KEY || null,
  header: 'authorization',
};

// Join gate. When MOLT_JOIN_SECRET is set, EVERY worker registration must present a matching
// join_token (constant-time checked) — independent of MOLT_OPEN_GRID, so open mode can't bypass it.
// This is the real lock on "who can join": the public `molt go` flow is inert without this token,
// which the operator issues out-of-band to invited nodes only. It layers ON TOP of identity-claim
// (MOLT_REQUIRE_IDENTITY). Unset (null) = gate OFF — backward-compatible, existing flows unchanged.
export const JOIN = {
  // Lazy getter (like GAME) so a late env set (`molt go`) or a test toggle is honored, and the secret
  // is never captured at import time.
  get secret() { return process.env.MOLT_JOIN_SECRET || null; },
};

// Quorum / distributed deliberation. The deliberation panel (src/broker/agents/deliberate.mjs)
// runs its CHEAP-tier debate seats (pessimist/optimist/realist opens+rebuts + skeptic) as plain
// `inference` jobs on worker NODES, while the single PREMIUM judge stays house-held in-broker.
// OFF by default — when off, the agents use the in-broker makeProviderInfer path verbatim and
// there is ZERO behavior change (no seats are ever enqueued, the claimable filter never sees a
// panel_id, every existing test/flow is byte-identical). Flip MOLT_QUORUM_GRID=1 to distribute.
export const QUORUM = {
  gridEnabled: process.env.MOLT_QUORUM_GRID === '1',      // off by default — zero behavior change
  seatTimeoutMs: Number(process.env.MOLT_QUORUM_SEAT_TIMEOUT_MS || 8000),
};

// Fuel / budget. Real spend stays behind a flag + a hard cap.
// Balance is denominated in USDC-cents (100 cents = $1.00).
export const FUEL = {
  real: process.env.MOLT_FUEL_REAL === '1',           // false = simulated, no real spend
  primaryAccount: 'acct_primary',                     // well-known team account id
  repThreshold: Number(process.env.MOLT_REP_THRESHOLD || 0.4), // below this = low-rep = redundant verify
  minBalance: Number(process.env.MOLT_MIN_BALANCE || 1), // minimum cents to dispatch a paid (Bedrock) job
};
