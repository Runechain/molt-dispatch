// Runtime config — the operator OVERRIDE layer that sits ON TOP of the static env defaults.
//
// WHITEPAPER note. The grid's control surface is a wall of MOLT_* environment variables read at
// process boot by src/shared/config.mjs (and a handful of consumers). That is fine for a deploy,
// but an operator staring at a live broker has no safe way to nudge a single knob without an env
// edit + a restart + a redeploy. This module is the thin mutability layer that closes that gap.
//
// THREE STATIC FACTS govern the design:
//   1. config.mjs stays the SOLE source of env/boot defaults. We READ it; we never make it import
//      us (that would be an import cycle: config -> runtime-config -> db -> config). config.mjs has
//      ZERO knowledge this layer exists.
//   2. Overrides live in a DB table (runtime_config). We reach the DB LAZILY — getDb() is called at
//      request time, never at module load — so importing this module is side-effect-free and can't
//      trigger a cycle through db.mjs's own `import { PATHS } from '../shared/config.mjs'`.
//   3. Not every knob is web-mutable. A knob's MUTABILITY tier decides whether a stored override is
//      honored live (`live`), needs a process restart (`restart`), or is refused outright over the
//      web (`deploy` infra wiring, `danger` security switches). cfg() only honors `live` overrides;
//      everything else still reads the boot value until the operator restarts/redeploys.
//
// The consuming code (lifecycle, integration-agent, grid-infer) calls cfg('<key>') at decision time
// for LIVE knobs so an override takes effect with no restart. The server-routes + page agents build
// the admin panel against getConfigSnapshot/setOverride/clearOverride.

import {
  BROKER,
  AUTH,
  GAME,
  JOIN,
  QUORUM,
  FUEL,
  DEFAULTS,
  PATHS,
} from '../shared/config.mjs';
import { getDb, now } from './db.mjs';

// ---- Coercion / validation helpers -------------------------------------------
// Each parse() takes the RAW stored/env string (or a primitive) and returns the typed value, or
// throws on malformed input. setOverride() catches the throw and returns { error:'bad_value' };
// cfg() and the snapshot trust already-validated stored values but still parse env defaults so the
// effective value is always the right JS type regardless of whether it came from env or override.

function parseNumber(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('not a finite number');
  return n;
}
function parseBool(raw) {
  // Accept the canonical env form ('1'/'0') plus the obvious truthy/falsy spellings a web form sends.
  if (raw === true || raw === false) return raw;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no', ''].includes(s)) return false;
  throw new Error('not a boolean');
}
function parseString(raw) {
  return raw == null ? '' : String(raw);
}

const PARSERS = { number: parseNumber, bool: parseBool, string: parseString };

// ---- Env/default readers -----------------------------------------------------
// One function per knob returning its CURRENT env/boot value, sourced from config.mjs's already-
// computed objects (so we never re-derive a default and risk it drifting from config.mjs). These are
// the fallbacks cfg() returns when no live override is stored, and the boot value the snapshot shows
// for restart/deploy/danger knobs. config.mjs uses lazy getters for a few (BROKER.url, GAME.*), so
// reading through the object — not capturing at import — keeps late env sets (e.g. `molt go`) honest.
const ENV = {
  // live tier
  repThreshold: () => FUEL.repThreshold,
  seatTimeoutMs: () => QUORUM.seatTimeoutMs,
  maxDeliberations: () => Number(process.env.MOLT_MAX_DELIBERATIONS || 8),
  minBalance: () => FUEL.minBalance,
  workerStaleSeconds: () => DEFAULTS.workerStaleSeconds,
  rateMax: () => Number(process.env.MOLT_RATE_MAX || 60),
  rateWindowMs: () => Number(process.env.MOLT_RATE_WINDOW_MS || 10_000),
  // restart tier
  quorumGridEnabled: () => QUORUM.gridEnabled,
  delibCheap: () => process.env.MOLT_DELIB_CHEAP || 'local',
  delibPremium: () => process.env.MOLT_DELIB_PREMIUM || 'bedrock',
  delibCheapModel: () => process.env.MOLT_DELIB_CHEAP_MODEL || '',
  delibPremiumModel: () => process.env.MOLT_DELIB_PREMIUM_MODEL || '',
  integrationAgent: () => process.env.MOLT_INTEGRATION_AGENT === '1',
  plannerAgent: () => process.env.MOLT_PLANNER_AGENT === '1',
  // deploy tier (infra wiring — never web-mutable)
  port: () => BROKER.port,
  host: () => BROKER.host,
  dataDir: () => PATHS.data,
  pathPrefix: () => BROKER.pathPrefix,
  brokerUrl: () => BROKER.url,
  // danger tier (security switches — never web-mutable, redacted to anon)
  openGrid: () => process.env.MOLT_OPEN_GRID === '1',
  fuelReal: () => FUEL.real,
  requireIdentity: () => GAME.requireIdentity,
  auth: () => AUTH.enabled,
  // Presence-only: the panel shows whether the join gate is armed, NEVER the secret value itself.
  joinGate: () => (JOIN.secret ? 'set' : 'unset'),
};

// ---- KNOBS: the full operator control surface --------------------------------
// Every row describes ONE knob. `mutability` is the contract the admin UI + setOverride enforce:
//   live    — an override takes effect immediately; cfg() returns it without a restart.
//   restart — an override is PERSISTED and surfaced (pendingOverride) but cfg() keeps returning the
//             boot value until the process restarts and re-reads env. restartRequired=true on set.
//   deploy  — infra wiring (port/host/paths/url). NOT web-mutable: changing it needs a redeploy, and
//             a stored override here would be a lie, so setOverride refuses it.
//   danger  — security/economic switches. NOT web-mutable (an operator flipping MOLT_AUTH off from
//             the very panel it guards is exactly the footgun we refuse) and `value` is redacted for
//             unauthenticated snapshot readers.
// `envVar` documents the boot source; `group` buckets the UI; `type` drives coercion/validation.
export const KNOBS = [
  // ---- live: tunable without a restart -----------------------------------------
  { key: 'repThreshold',       label: 'Reputation threshold',        group: 'reputation', envVar: 'MOLT_REP_THRESHOLD',           mutability: 'live',    danger: false, type: 'number', parse: parseNumber },
  { key: 'seatTimeoutMs',      label: 'Quorum seat timeout (ms)',    group: 'quorum',     envVar: 'MOLT_QUORUM_SEAT_TIMEOUT_MS',  mutability: 'live',    danger: false, type: 'number', parse: parseNumber },
  { key: 'maxDeliberations',   label: 'Max deliberations / event',   group: 'quorum',     envVar: 'MOLT_MAX_DELIBERATIONS',       mutability: 'live',    danger: false, type: 'number', parse: parseNumber },
  { key: 'minBalance',         label: 'Min fuel balance (cents)',    group: 'fuel',       envVar: 'MOLT_MIN_BALANCE',             mutability: 'live',    danger: false, type: 'number', parse: parseNumber },
  { key: 'workerStaleSeconds', label: 'Worker stale window (s)',     group: 'workers',    envVar: 'MOLT_WORKER_STALE_SECONDS',    mutability: 'live',    danger: false, type: 'number', parse: parseNumber },
  { key: 'rateMax',            label: 'Rate limit (req/window)',     group: 'limits',     envVar: 'MOLT_RATE_MAX',                mutability: 'live',    danger: false, type: 'number', parse: parseNumber },
  { key: 'rateWindowMs',       label: 'Rate window (ms)',            group: 'limits',     envVar: 'MOLT_RATE_WINDOW_MS',          mutability: 'live',    danger: false, type: 'number', parse: parseNumber },

  // ---- restart: persisted, but read at boot (needs a restart to take effect) ----
  { key: 'quorumGridEnabled',  label: 'Quorum grid distribution',    group: 'quorum',     envVar: 'MOLT_QUORUM_GRID',             mutability: 'restart', danger: false, type: 'bool',   parse: parseBool },
  { key: 'delibCheap',         label: 'Cheap deliberation provider', group: 'quorum',     envVar: 'MOLT_DELIB_CHEAP',             mutability: 'restart', danger: false, type: 'string', parse: parseString },
  { key: 'delibPremium',       label: 'Premium (judge) provider',    group: 'quorum',     envVar: 'MOLT_DELIB_PREMIUM',           mutability: 'restart', danger: false, type: 'string', parse: parseString },
  { key: 'delibCheapModel',    label: 'Cheap deliberation model',    group: 'quorum',     envVar: 'MOLT_DELIB_CHEAP_MODEL',       mutability: 'restart', danger: false, type: 'string', parse: parseString },
  { key: 'delibPremiumModel',  label: 'Premium (judge) model',       group: 'quorum',     envVar: 'MOLT_DELIB_PREMIUM_MODEL',     mutability: 'restart', danger: false, type: 'string', parse: parseString },
  { key: 'integrationAgent',   label: 'Integration agent enabled',   group: 'agents',     envVar: 'MOLT_INTEGRATION_AGENT',       mutability: 'restart', danger: false, type: 'bool',   parse: parseBool },
  { key: 'plannerAgent',       label: 'Planner agent enabled',       group: 'agents',     envVar: 'MOLT_PLANNER_AGENT',           mutability: 'restart', danger: false, type: 'bool',   parse: parseBool },

  // ---- deploy: infra wiring, never web-mutable ---------------------------------
  { key: 'port',               label: 'Broker port',                 group: 'network',    envVar: 'MOLT_PORT',                    mutability: 'deploy',  danger: false, type: 'number', parse: parseNumber },
  { key: 'host',               label: 'Broker host',                 group: 'network',    envVar: 'MOLT_HOST',                    mutability: 'deploy',  danger: false, type: 'string', parse: parseString },
  { key: 'dataDir',            label: 'Data directory',              group: 'network',    envVar: 'MOLT_DATA_DIR',                mutability: 'deploy',  danger: false, type: 'string', parse: parseString },
  { key: 'pathPrefix',         label: 'Path prefix',                 group: 'network',    envVar: 'MOLT_PATH_PREFIX',             mutability: 'deploy',  danger: false, type: 'string', parse: parseString },
  { key: 'brokerUrl',          label: 'Broker URL',                  group: 'network',    envVar: 'MOLT_BROKER_URL',              mutability: 'deploy',  danger: false, type: 'string', parse: parseString },

  // ---- danger: security/economic switches, never web-mutable, redacted to anon --
  { key: 'openGrid',           label: 'Open grid (untrusted)',       group: 'security',   envVar: 'MOLT_OPEN_GRID',               mutability: 'danger',  danger: true,  type: 'bool',   parse: parseBool },
  { key: 'fuelReal',           label: 'Real fuel spend',             group: 'security',   envVar: 'MOLT_FUEL_REAL',               mutability: 'danger',  danger: true,  type: 'bool',   parse: parseBool },
  { key: 'requireIdentity',    label: 'Require claimed identity',    group: 'security',   envVar: 'MOLT_REQUIRE_IDENTITY',        mutability: 'danger',  danger: true,  type: 'bool',   parse: parseBool },
  { key: 'auth',               label: 'Team auth enabled',           group: 'security',   envVar: 'MOLT_AUTH',                    mutability: 'danger',  danger: true,  type: 'bool',   parse: parseBool },
  { key: 'joinGate',           label: 'Join gate (invite token)',    group: 'security',   envVar: 'MOLT_JOIN_SECRET',             mutability: 'danger',  danger: true,  type: 'string', secret: true, parse: parseString },
];

const BY_KEY = new Map(KNOBS.map((k) => [k.key, k]));

// ---- Override store (lazy DB) ------------------------------------------------
// runtime_config is a flat key->value-as-TEXT table created by db.mjs's migrate(). We read/write it
// only through getDb() at call time. Values are stored as strings and re-parsed on read so the table
// is human-inspectable (`SELECT * FROM runtime_config`) and type changes never corrupt the column.

function readOverrideRaw(key) {
  const row = getDb().prepare('SELECT value FROM runtime_config WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function writeOverrideRaw(key, value) {
  getDb()
    .prepare(
      `INSERT INTO runtime_config(key, value, updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    )
    .run(key, value, now());
}

function deleteOverrideRaw(key) {
  getDb().prepare('DELETE FROM runtime_config WHERE key = ?').run(key);
}

// Effective typed value for a LIVE knob: stored override (if any) parsed to type, else env/default.
// For non-live knobs cfg() short-circuits to env (overrides for those are pending, not effective).
function effectiveValue(knob) {
  if (knob.mutability === 'live') {
    const raw = readOverrideRaw(knob.key);
    if (raw !== undefined) {
      try {
        return knob.parse(raw);
      } catch {
        /* a corrupt stored value must never break a live read — fall through to env default */
      }
    }
  }
  return ENV[knob.key]();
}

// ---- Public API --------------------------------------------------------------

/**
 * cfg(key) -> typed effective value.
 * For LIVE keys: persisted override (if present & valid) wins over the env/boot default.
 * For every other tier: always the env/boot value (a stored override is pending until restart).
 * Unknown key throws — callers reference compile-time-known knob keys, a typo should be loud.
 */
export function cfg(key) {
  const knob = BY_KEY.get(key);
  if (!knob) throw new Error(`runtime-config: unknown knob '${key}'`);
  return effectiveValue(knob);
}

/**
 * getConfigSnapshot({ authed }) -> Array<row> for the admin panel.
 * Each row: { key, label, group, envVar, value, pendingOverride, source, mutability, danger }.
 *   value           — current EFFECTIVE value (what cfg() returns for live; boot value otherwise).
 *   pendingOverride  — the stored override value (typed) if one exists, else null. For restart knobs
 *                      this is the not-yet-applied value an operator set; for live knobs it equals
 *                      `value`; null when nothing is stored.
 *   source          — 'override' (a live override is in force), 'env' (an env var is set), or
 *                      'default' (neither — the hardcoded fallback).
 * Danger-knob `value` (and pendingOverride) are redacted to '***' for unauthenticated readers so a
 * public dashboard scrape can't learn whether auth/open-grid/real-fuel are on.
 */
// "How to change this" for the LOCKED tiers (deploy/danger). Shown when the operator clicks a locked
// control. NEVER contains a secret VALUE — secret knobs render a <token> placeholder, so this is safe
// to expose even to anonymous callers (it's the same env-var recipe regardless of the current value).
function howtoFor(knob) {
  if (knob.mutability !== 'deploy' && knob.mutability !== 'danger') return null;
  const v = knob.envVar;
  if (knob.secret) {
    return [
      'This is a secret — it can only be set, never read back here.',
      `Local:  export ${v}=<your-token> && npm run broker`,
      `Prod:   store it as an SSM SecureString and reference ${v} from the ECS task definition.`,
      'Then restart the broker. Never commit the value.',
    ];
  }
  if (knob.type === 'bool') {
    return [
      `Local:  export ${v}=1   (1 = on, 0 = off) && npm run broker`,
      `Prod:   set ${v} in the ECS task-definition env, then redeploy.`,
      'It takes effect on broker restart — never from the web.',
    ];
  }
  return [
    `Local:  export ${v}=<value> && npm run broker`,
    `Prod:   set ${v} in the ECS task-definition env, then redeploy.`,
  ];
}

export function getConfigSnapshot({ authed = false } = {}) {
  return KNOBS.map((knob) => {
    const storedRaw = readOverrideRaw(knob.key);
    let pendingOverride = null;
    if (storedRaw !== undefined) {
      try {
        pendingOverride = knob.parse(storedRaw);
      } catch {
        pendingOverride = storedRaw; // surface the raw bad value rather than hide it
      }
    }
    const value = effectiveValue(knob);
    // source: an override is "in force" only when it's a live knob with a stored value; a stored
    // override on a restart knob is pending (not yet the effective value), so source reflects boot.
    let source;
    if (knob.mutability === 'live' && storedRaw !== undefined) {
      source = 'override';
    } else {
      source = process.env[knob.envVar] !== undefined && process.env[knob.envVar] !== ''
        ? 'env'
        : 'default';
    }
    const redact = knob.danger && !authed;
    return {
      key: knob.key,
      label: knob.label,
      group: knob.group,
      envVar: knob.envVar,
      value: redact ? '***' : value,
      pendingOverride: redact ? (pendingOverride === null ? null : '***') : pendingOverride,
      source,
      mutability: knob.mutability,
      danger: knob.danger,
      type: knob.type, // 'number' | 'bool' | 'string' — the dashboard renders bool knobs as toggle switches
      howto: howtoFor(knob), // non-null for locked (deploy/danger) knobs; shown on click. Never holds a secret value.
    };
  });
}

/**
 * setOverride(key, rawValue, { authed }) -> { ok, error?, key, value?, mutability?, restartRequired? }.
 * Rejections (ok:false):
 *   unauthorized   — caller is not authed (this mutates broker behavior; auth is mandatory).
 *   unknown_key    — key is not a registered knob.
 *   not_web_mutable — knob is `deploy` or `danger` (infra/security: never settable over the web).
 *   bad_value      — rawValue fails the knob's type coercion.
 * On success the typed value is persisted to runtime_config. restartRequired is true for `restart`
 * knobs (stored but not live until the process re-reads env), false for `live` knobs (effective now).
 */
export function setOverride(key, rawValue, { authed = false } = {}) {
  if (!authed) return { ok: false, error: 'unauthorized', key };
  const knob = BY_KEY.get(key);
  if (!knob) return { ok: false, error: 'unknown_key', key };
  if (knob.mutability === 'deploy' || knob.mutability === 'danger') {
    return { ok: false, error: 'not_web_mutable', key, mutability: knob.mutability };
  }
  let value;
  try {
    value = knob.parse(rawValue);
  } catch (err) {
    return { ok: false, error: 'bad_value', key, detail: err.message };
  }
  // Persist the CANONICAL string form (numbers/bools re-stringified) so the table is consistent and
  // re-parsing it is lossless. Bools store as '1'/'0' to mirror the env convention.
  const stored = knob.type === 'bool' ? (value ? '1' : '0') : String(value);
  writeOverrideRaw(key, stored);
  const restartRequired = knob.mutability === 'restart';
  return { ok: true, key, value, mutability: knob.mutability, restartRequired };
}

/**
 * clearOverride(key, { authed }) -> { ok, error?, key, value?, mutability?, restartRequired? }.
 * Symmetric to setOverride: removes a stored override so the knob reverts to its env/boot default.
 * Same auth + web-mutability gates (you can only clear what you could have set).
 */
export function clearOverride(key, { authed = false } = {}) {
  if (!authed) return { ok: false, error: 'unauthorized', key };
  const knob = BY_KEY.get(key);
  if (!knob) return { ok: false, error: 'unknown_key', key };
  if (knob.mutability === 'deploy' || knob.mutability === 'danger') {
    return { ok: false, error: 'not_web_mutable', key, mutability: knob.mutability };
  }
  deleteOverrideRaw(key);
  return {
    ok: true,
    key,
    value: ENV[key](), // reverts to env/default now that the override is gone
    mutability: knob.mutability,
    restartRequired: knob.mutability === 'restart',
  };
}
