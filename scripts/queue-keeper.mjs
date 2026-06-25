#!/usr/bin/env node
// queue-keeper.mjs — keep a TARGET depth of claimable work in the grid so a worker that joins always
// has something to start on. It is the supply side of readiness: the probe tells you the queue is
// empty/starved, this refills it.
//
// How it works: read /readiness, compute current depth = dependency-ready pending jobs
// (pending_total - blocked). While depth < target, submit the next objective from a backlog pool
// (round-robin, so a small pool keeps the queue topped indefinitely). Idempotent top-up — safe to
// run on a schedule; a run that finds the queue already full adds nothing.
//
// POST /objectives is operator-gated, so this needs the operator key.
//
//   MOLT_API_KEY=op1.… MOLT_BROKER_URL=https://play.runechaingame.com/grid \
//     node scripts/queue-keeper.mjs --target 5 --backlog examples/backlog.json [--dry-run]
//
// Exit: 0 = queue at/over target (added 0+), 1 = error (unreachable / bad backlog / submit failed).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { f[k] = argv[++i]; } else { f[k] = true; }
    }
  }
  return f;
}

const flags = parseFlags(process.argv.slice(2));
const BROKER = (process.env.MOLT_BROKER_URL || 'https://play.runechaingame.com/grid').replace(/\/$/, '');
const KEY = flags.key || process.env.MOLT_API_KEY || '';
const TARGET = Number(flags.target ?? process.env.MOLT_QUEUE_TARGET ?? 5);
const BACKLOG = resolve(String(flags.backlog || 'examples/backlog.json'));
const DRY = !!flags['dry-run'];

const die = (msg) => { console.error(`queue-keeper: ${msg}`); process.exit(1); };
const headers = () => (KEY ? { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' });

let pool;
try {
  pool = JSON.parse(readFileSync(BACKLOG, 'utf8'));
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('backlog must be a non-empty JSON array');
} catch (e) { die(`cannot read backlog ${BACKLOG}: ${e.message}`); }

let r;
try {
  const res = await fetch(`${BROKER}/readiness`, { headers: headers() });
  r = await res.json();
} catch { die(`broker unreachable at ${BROKER}`); }
if (!r || r.ok !== true) die(`readiness check failed: ${r?.error || JSON.stringify(r)}`);
if (r.jobs === undefined) die('readiness returned the coarse view — set MOLT_API_KEY to the operator key (POST /objectives needs it too)');

const depth = r.jobs.pending_total - r.jobs.blocked; // dependency-ready work waiting to be claimed
const need = Math.max(0, TARGET - depth);
console.log(`queue depth ${depth} (claimable ${r.jobs.claimable_now}, waiting-on-capacity ${r.jobs.saturated}, starved ${r.jobs.starved}); target ${TARGET} -> add ${need}`);
if (r.jobs.starved > 0) console.log(`  note: ${r.jobs.starved} pending job(s) are STARVED (no capable worker online) — adding work won't help those; check capability_gaps.`);
if (need === 0) { console.log('queue at/over target — nothing to add.'); process.exit(0); }

let added = 0;
for (let i = 0; i < need; i++) {
  const spec = pool[i % pool.length];
  const body = { title: spec.title, prompt: spec.prompt, contract: spec.contract || { objective_type: 'inference' }, ...(spec.repo ? { repo: spec.repo } : {}) };
  if (DRY) { console.log(`  [dry-run] would submit: ${body.title}`); added++; continue; }
  try {
    const res = await fetch(`${BROKER}/objectives`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) { die(`submit failed (${res.status}): ${out.error || 'unknown'}`); }
    console.log(`  + ${out.objective_id || '?'}  ${body.title}`);
    added++;
  } catch (e) { die(`submit failed: ${e.message}`); }
}
console.log(`${DRY ? '[dry-run] ' : ''}added ${added} objective(s); queue now ~${depth + added}.`);
process.exit(0);
