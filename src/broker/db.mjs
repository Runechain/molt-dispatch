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
  return db;
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
