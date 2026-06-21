// Central config + filesystem paths for the grid.
// Everything is rooted at the project dir so the whole thing is a single local install.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..'); // molt-dispatch/

export const PATHS = {
  root: ROOT,
  data: join(ROOT, 'data'),
  db: join(ROOT, 'data', 'molt.db'),
  artifacts: join(ROOT, 'artifacts'),
  worktrees: join(ROOT, 'worktrees'),
  dashboard: join(ROOT, 'dashboard'),
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
