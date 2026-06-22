// The grid's single source of truth. node:sqlite (built into Node >=24), zero deps.
// Tables follow WHITEPAPER §11 with light additions (a seq counter, JSON columns).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { PATHS } from '../shared/config.mjs';
import { eventId } from '../shared/ids.mjs';

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(PATHS.data, { recursive: true });
  db = new DatabaseSync(PATHS.db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  bootstrap(db);
  migrate(db);
  return db;
}

// Add columns to pre-existing databases (node:sqlite has no IF NOT EXISTS for columns).
function migrate(d) {
  const addCol = (table, col, ddl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addCol('objectives', 'source_issue', 'source_issue INTEGER');
  addCol('objectives', 'pr_url', 'pr_url TEXT');
  // Redundant verify: set when a low-rep worker's result needs a secondary check before approve.
  addCol('objectives', 'needs_review', 'needs_review INTEGER NOT NULL DEFAULT 0');
  // Integration agent run-gate: set when the agent holds/escalates a dependent's release even
  // though the deterministic floor is satisfied. The scheduler refuses to run a held objective.
  addCol('objectives', 'dep_hold', 'dep_hold INTEGER NOT NULL DEFAULT 0');
  // Heterogeneous reputation: per (worker, capability, model/provider).
  addCol('reputation_events', 'model', 'model TEXT');
  addCol('reputation_events', 'provider', 'provider TEXT');
  // Fault tolerance: remember who dropped a job so continuation avoids re-handing it.
  addCol('jobs', 'last_failed_worker_id', 'last_failed_worker_id TEXT');
  addCol('jobs', 'checkpoint_seq', 'checkpoint_seq INTEGER DEFAULT 0');
  // Ensure the primary team account exists for the fuel ledger.
  ensurePrimaryAccount(d);
  // Seed cost model with known Bedrock pricing (INSERT OR IGNORE).
  seedCostModel(d);
}

function ensurePrimaryAccount(d) {
  d.prepare(
    `INSERT INTO accounts(id, name, role, balance_cents, status, created_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`
  ).run('acct_primary', 'Team (primary)', 'team', 0, 'active', Date.now());
}

function seedCostModel(d) {
  const ins = d.prepare(
    `INSERT OR IGNORE INTO cost_model(id, provider, model, input_cents_per_1k, output_cents_per_1k, flat_cents, created_at)
     VALUES(?,?,?,?,?,?,?)`
  );
  const t = Date.now();
  // Bedrock prices (USD per 1M tokens → cents per 1k tokens):
  //   claude-3-haiku:   $0.25/1M in  $1.25/1M out  → 0.025 / 0.125 cents per 1k
  //   claude-sonnet:    $3.00/1M in  $15.00/1M out  → 0.3   / 1.5   cents per 1k
  ins.run('cm_haiku',    'bedrock', 'claude-3-haiku',                              0.025, 0.125, 0, t);
  ins.run('cm_haiku3v',  'bedrock', 'anthropic.claude-3-haiku-20240307-v1:0',      0.025, 0.125, 0, t);
  ins.run('cm_sonnet46', 'bedrock', 'anthropic.claude-sonnet-4-6',                 0.3,   1.5,   0, t);
  ins.run('cm_local',    'local',   '*',                                            0,     0,     0, t);
  ins.run('cm_mock',     'mock',    'mock-1',                                       0,     0,     0, t);
}

function bootstrap(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS seq (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT,
      repo TEXT,
      branch_base TEXT DEFAULT 'main',
      contract_json TEXT,            -- completion contract (§12)
      status TEXT NOT NULL DEFAULT 'planning',
      created_by TEXT,
      source_issue INTEGER,          -- GitHub issue number this objective came from
      pr_url TEXT,                   -- PR opened on approval (github mode)
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL REFERENCES objectives(id),
      job_key TEXT,                  -- planner-local key, e.g. 'impl'
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT,
      capability_required TEXT,
      trust_required INTEGER DEFAULT 0,
      adapter_hint TEXT,             -- preferred adapter, e.g. 'codex'
      spec_json TEXT,                -- inputs/acceptance/constraints
      status TEXT NOT NULL DEFAULT 'blocked',  -- blocked|pending|claimed|completed|accepted|rejected|failed
      priority INTEGER DEFAULT 100,
      estimated_minutes INTEGER DEFAULT 20,
      attempts INTEGER DEFAULT 0,
      lease_token TEXT,
      lease_until INTEGER,
      assigned_worker_id TEXT,
      branch TEXT,                   -- grid/J-####
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_dependencies (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      depends_on_job_id TEXT NOT NULL REFERENCES jobs(id),
      PRIMARY KEY (job_id, depends_on_job_id)
    );

    -- Inter-objective dependencies (cross-issue "Depends on #N"). depends_on_objective_id is
    -- NULL until the upstream issue is imported and resolveAndGate() binds it; depends_on_issue
    -- keeps the raw GitHub issue number so forward/out-of-batch refs resolve later. status:
    -- 'active' = enforced, 'cycle' = a back-edge dropped by cycle detection (never enforced).
    CREATE TABLE IF NOT EXISTS objective_dependencies (
      objective_id TEXT NOT NULL REFERENCES objectives(id),
      depends_on_objective_id TEXT REFERENCES objectives(id),
      depends_on_issue INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (objective_id, depends_on_issue)
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      status TEXT NOT NULL DEFAULT 'online',
      last_heartbeat INTEGER,
      trust_tier INTEGER DEFAULT 0,
      manifest_json TEXT,
      active_slots INTEGER DEFAULT 0,
      max_slots INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      worker_id TEXT NOT NULL REFERENCES workers(id),
      status TEXT NOT NULL DEFAULT 'running',
      lease_token TEXT,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      worker_id TEXT,
      kind TEXT NOT NULL,            -- patch|summary|tests|review|status
      path TEXT,
      hash TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      validator_type TEXT NOT NULL, -- schema|static|automated|review
      validator_worker_id TEXT,
      result TEXT NOT NULL,         -- pass|fail
      score_json TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reputation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      event_type TEXT NOT NULL,
      delta REAL DEFAULT 0,
      evidence_job_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    -- Partial progress so a dropped job can be RESUMED, not restarted (fault tolerance).
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      worker_id TEXT,
      seq INTEGER NOT NULL DEFAULT 0,   -- monotonic per job; latest wins on requeue
      state_json TEXT NOT NULL,         -- adapter-defined partial-progress payload
      note TEXT,
      created_at INTEGER NOT NULL
    );

    -- Team-gating + (Phase 2) fuel budget. Balance is in USDC cents; simulated until MOLT_FUEL_REAL=1.
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'team',   -- team|worker|consumer
      balance_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,                 -- public part (mk_...), sent with the secret as id.secret
      account_id TEXT REFERENCES accounts(id),
      hash TEXT NOT NULL,                  -- sha256(secret); the raw secret is never stored
      name TEXT,
      scopes TEXT NOT NULL DEFAULT 'dispatch,worker',  -- csv: dispatch|worker|approve|admin
      last_used INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Fuel ledger: every reserve/charge/refund/credit/payout in one append-only log.
    -- amount_cents > 0 = inflow (credit/refund), amount_cents < 0 = outflow (reserve/charge/payout).
    -- Balance = SUM(amount_cents) per account.
    CREATE TABLE IF NOT EXISTS fuel_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      job_id TEXT REFERENCES jobs(id),
      op TEXT NOT NULL,         -- reserve|charge|refund|credit|payout
      amount_cents INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    -- Cost model: cents per 1k tokens per (provider, model). model='*' = wildcard for a provider.
    CREATE TABLE IF NOT EXISTS cost_model (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_cents_per_1k REAL NOT NULL DEFAULT 0,
      output_cents_per_1k REAL NOT NULL DEFAULT 0,
      flat_cents REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, model)
    );
  `);
}

export function now() {
  return Date.now();
}

// node:sqlite has no .transaction() helper (unlike better-sqlite3) — wrap manually.
export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// Monotonic per-name counter persisted in the DB.
export function nextSeq(name) {
  const d = getDb();
  d.prepare('INSERT INTO seq(name, value) VALUES(?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  d.prepare('UPDATE seq SET value = value + 1 WHERE name = ?').run(name);
  return d.prepare('SELECT value FROM seq WHERE name = ?').get(name).value;
}

// Append to the event log (used everywhere for the audit trail / dashboard feed).
export function logEvent(entity_type, entity_id, event_type, payload) {
  const d = getDb();
  d.prepare(
    'INSERT INTO events(id, entity_type, entity_id, event_type, payload_json, created_at) VALUES(?,?,?,?,?,?)'
  ).run(eventId(), entity_type, entity_id, event_type, payload ? JSON.stringify(payload) : null, now());
}

// Small helpers so callers don't sprinkle JSON.parse everywhere.
export function parseRow(row, jsonCols = []) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) {
    if (out[c]) {
      try {
        out[c.replace(/_json$/, '')] = JSON.parse(out[c]);
      } catch {
        /* leave raw */
      }
    }
  }
  return out;
}
