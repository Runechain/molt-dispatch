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
  get url() {
    return `http://${this.host}:${this.port}`;
  },
};

// Lease / scheduling defaults
export const DEFAULTS = {
  leaseSeconds: 1800, // 30 min default lease for a claimed job
  heartbeatSeconds: 10, // worker heartbeat cadence
  claimPollSeconds: 3, // worker poll cadence when idle
  leaseSweepSeconds: 15, // broker requeues expired leases this often
};

// Team-gating. Off by default so the local quick-start needs no key; deployed/team
// installs set MOLT_AUTH=1. Clients (CLI/worker) send MOLT_API_KEY when present.
export const AUTH = {
  enabled: process.env.MOLT_AUTH === '1',
  apiKey: process.env.MOLT_API_KEY || null,
  header: 'authorization',
};

// Fuel / budget. Real spend stays behind a flag + a hard cap.
// Balance is denominated in USDC-cents (100 cents = $1.00).
export const FUEL = {
  real: process.env.MOLT_FUEL_REAL === '1',           // false = simulated, no real spend
  primaryAccount: 'acct_primary',                     // well-known team account id
  repThreshold: Number(process.env.MOLT_REP_THRESHOLD || 0.4), // below this = low-rep = redundant verify
  minBalance: Number(process.env.MOLT_MIN_BALANCE || 1), // minimum cents to dispatch a paid (Bedrock) job
};
