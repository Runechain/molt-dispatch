#!/usr/bin/env node
// molt — CLI for the Distributed Agent Compute Grid.
//
//   molt broker start                 start the control plane (run this first)
//   molt worker start [--adapters …]  start a local worker daemon
//   molt objective create <title> …   create + plan an objective
//   molt objective create -f <file>   create from a JSON spec (title/prompt/repo/contract)
//   molt approve <objective-id>       human gate: approve (and merge in M3)
//   molt status [objective-id]        show objectives/jobs/workers
//   molt dashboard                    open the web dashboard

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BROKER } from '../src/shared/config.mjs';

const argv = process.argv.slice(2);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next == null || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a;
      const next = args[i + 1];
      flags[key] = next;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BROKER.url}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error(`Cannot reach broker at ${BROKER.url}. Start it with:  molt broker start`);
    process.exit(1);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [cmd, sub, ...rest] = argv;

switch (cmd) {
  case 'broker':
    if (sub === 'start') {
      const { startBroker } = await import('../src/broker/server.mjs');
      startBroker();
    } else usage();
    break;

  case 'worker':
    if (sub === 'start') {
      const { flags } = parseFlags(rest);
      const { startWorker } = await import('../src/worker/daemon.mjs');
      await startWorker({
        adapters: flags.adapters ? String(flags.adapters).split(',').map((s) => s.trim()) : undefined,
        owner: flags.owner,
        maxSlots: flags['max-slots'] ? Number(flags['max-slots']) : undefined,
        trustTier: flags.trust != null ? Number(flags.trust) : undefined,
      });
    } else usage();
    break;

  case 'objective':
    if (sub === 'create') {
      const { flags, positional } = parseFlags(rest);
      let payload;
      if (flags.f || flags.file) {
        const file = resolve(process.cwd(), flags.f || flags.file);
        payload = JSON.parse(readFileSync(file, 'utf8'));
        if (payload.repo) payload.repo = resolve(file, '..', payload.repo);
      } else {
        payload = {
          title: positional.join(' '),
          prompt: flags.prompt || undefined,
          repo: flags.repo ? resolve(process.cwd(), flags.repo) : undefined,
          branch_base: flags.base || undefined,
        };
      }
      if (!payload.title) {
        console.error('objective needs a title (positional or in the -f file)');
        process.exit(1);
      }
      const out = await api('POST', '/objectives', payload);
      console.log(`Created ${out.objective_id} with ${out.jobs?.length ?? 0} jobs:`);
      for (const j of out.jobs || []) console.log(`  ${j.id}  ${j.key}  [${j.status}]`);
      break;
    }
    usage();
    break;

  case 'approve': {
    const id = sub;
    if (!id) {
      console.error('usage: molt approve <objective-id>');
      process.exit(1);
    }
    const out = await api('POST', `/objectives/${id}/approve`);
    if (out.error) console.error(`approve failed: ${out.error}`);
    else console.log(`Objective ${id} -> ${out.status}`);
    break;
  }

  case 'status': {
    const objectives = await api('GET', '/objectives');
    const workers = await api('GET', '/workers');
    console.log('OBJECTIVES');
    for (const o of objectives) {
      console.log(`  ${o.id}  [${o.status}]  ${o.title}`);
      if (!sub || sub === o.id) {
        const jobs = await api('GET', `/jobs?objective=${o.id}`);
        for (const j of jobs) {
          const dep = j.depends_on?.length ? ` <- ${j.depends_on.join(',')}` : '';
          console.log(`      ${j.id}  ${(j.job_key || j.type).padEnd(8)} [${j.status}]${dep}`);
        }
      }
    }
    console.log('\nWORKERS');
    for (const w of workers) {
      console.log(`  ${w.id}  [${w.status}]  slots ${w.active_slots}/${w.max_slots}  tier ${w.trust_tier}`);
      for (const r of w.reputation || []) console.log(`      ${r.capability}: trust ${r.trust_score} (${r.accepted}/${r.events})`);
    }
    break;
  }

  case 'dashboard': {
    const url = `${BROKER.url}/dashboard`;
    console.log(`Opening ${url}`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    break;
  }

  default:
    usage();
}

function usage() {
  console.log(`molt — Distributed Agent Compute Grid

  molt broker start
  molt worker start [--adapters mock,codex,claude] [--owner NAME] [--max-slots N] [--trust N]
  molt objective create "<title>" [--prompt TEXT] [--repo PATH] [--base BRANCH]
  molt objective create -f <spec.json>
  molt approve <objective-id>
  molt status [objective-id]
  molt dashboard
`);
  process.exit(1);
}
