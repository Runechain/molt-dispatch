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

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { BROKER, AUTH, PATHS } from '../src/shared/config.mjs';

const argv = process.argv.slice(2);

function version() {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  return pkg.version;
}

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
      const key = a.slice(1); // '-f' -> 'f'
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
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (AUTH.apiKey) headers.authorization = `Bearer ${AUTH.apiKey}`;
  try {
    res = await fetch(`${BROKER.url}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
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

if (cmd === '--version' || cmd === '-v') {
  console.log(version());
  process.exit(0);
}

switch (cmd) {
  case 'doctor': {
    const { doctor } = await import('../src/doctor.mjs');
    await doctor();
    break;
  }

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
      if (flags.plan) payload.contract = { ...(payload.contract || {}), planner: flags.plan };
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

  case 'infer': {
    // A single prompt -> completion unit on the heterogeneous grid (local Qwen / Bedrock).
    const { flags, positional } = parseFlags(rest);
    const prompt = positional.join(' ') || (typeof flags.prompt === 'string' ? flags.prompt : '');
    if (!prompt) {
      console.error('usage: molt infer "<prompt>" [--title T] [--adapter local|bedrock]');
      process.exit(1);
    }
    const contract = { objective_type: 'inference' };
    if (flags.adapter) contract.adapter_hint = flags.adapter;
    const out = await api('POST', '/objectives', {
      title: flags.title || prompt.slice(0, 60),
      prompt,
      contract,
    });
    if (out.error) {
      console.error(`infer failed: ${out.error}`);
      process.exit(1);
    }
    console.log(`Created ${out.objective_id} (inference) with ${out.jobs?.length ?? 0} job(s):`);
    for (const j of out.jobs || []) console.log(`  ${j.id}  ${j.key}  [${j.status}]`);
    console.log(`See output:  molt result ${out.objective_id}`);
    break;
  }

  case 'key': {
    // Mint/list/revoke team API keys (local DB access; no broker auth needed to bootstrap).
    const { flags, positional } = parseFlags(rest);
    const keys = await import('../src/broker/keys.mjs');
    if (sub === 'create') {
      const out = keys.createKey({ name: flags.name, scopes: flags.scopes });
      console.log('API key created — shown once, store it now:\n');
      console.log(`  ${out.key}\n`);
      console.log(`  account ${out.account_id} · scopes ${out.scopes}`);
      console.log(`\nUse it:  export MOLT_API_KEY=${out.key}`);
      console.log('Enable gating on the broker:  MOLT_AUTH=1 molt broker start');
    } else if (sub === 'list') {
      const rows = keys.listKeys();
      if (!rows.length) console.log('no keys yet — mint one with: molt key create --name <who>');
      for (const r of rows) {
        console.log(`  ${r.id}  ${r.revoked ? '[revoked]' : '[active]'}  ${r.name || ''}  scopes ${r.scopes}  last_used ${r.last_used || 'never'}`);
      }
    } else if (sub === 'revoke') {
      const id = positional[0] || flags.id;
      if (!id) {
        console.error('usage: molt key revoke <key-id>');
        process.exit(1);
      }
      console.log(keys.revokeKey(id) ? `revoked ${id}` : `no such key: ${id}`);
    } else usage();
    break;
  }

  case 'result': {
    // Print inference completions (artifacts/<jobId>/completion.txt) for an objective.
    const id = sub;
    if (!id) {
      console.error('usage: molt result <objective-id>');
      process.exit(1);
    }
    const jobs = await api('GET', `/jobs?objective=${id}`);
    let any = false;
    for (const j of jobs) {
      const p = join(PATHS.artifacts, j.id, 'completion.txt');
      if (existsSync(p)) {
        any = true;
        console.log(`\n=== ${j.id} (${j.status}) ===\n`);
        console.log(readFileSync(p, 'utf8'));
      } else {
        console.log(`  ${j.id} [${j.status}] — no completion artifact yet`);
      }
    }
    if (!any) console.log('(no completions found)');
    break;
  }

  case 'github':
    if (sub === 'import-issues') {
      const { flags } = parseFlags(rest);
      if (!flags.repo) {
        console.error('usage: molt github import-issues --repo <path> [--label L] [--limit N] [--test "npm test"]');
        process.exit(1);
      }
      const out = await api('POST', '/github/import-issues', {
        repo: resolve(process.cwd(), flags.repo),
        label: flags.label,
        limit: flags.limit ? Number(flags.limit) : undefined,
        base: flags.base,
        test: flags.test,
      });
      if (out.error) {
        console.error(`import failed: ${out.error}`);
        process.exit(1);
      }
      console.log(`Imported from ${out.slug}: ${out.created.length} new, ${out.skipped.length} skipped`);
      for (const c of out.created) console.log(`  #${c.issue} -> ${c.objective_id} (${c.jobs.length} jobs)`);
      for (const s of out.skipped) console.log(`  #${s.issue} already imported as ${s.objective}`);
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
    else {
      console.log(`Objective ${id} -> ${out.status} (${out.mode || 'merge'})`);
      if (out.pr_url) console.log(`PR: ${out.pr_url}`);
    }
    break;
  }

  case 'status': {
    const objectives = await api('GET', '/objectives');
    const workers = await api('GET', '/workers');
    console.log('OBJECTIVES');
    for (const o of objectives) {
      console.log(`  ${o.id}  [${o.status}]  ${o.title}`);
      if (o.pr_url) console.log(`      PR: ${o.pr_url}`);
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

  case 'fuel': {
    const { flags, positional } = parseFlags(rest);
    const account = flags.account || 'acct_primary';
    if (sub === 'balance') {
      const out = await api('GET', `/fuel/balance?account=${account}`);
      console.log(`balance: ${out.balance_cents} cents  (account ${out.account_id})`);
    } else if (sub === 'credit') {
      const cents = Number(positional[0]);
      if (!cents || cents <= 0) {
        console.error('usage: molt fuel credit <cents> [--note "..."] [--account acct_primary]');
        process.exit(1);
      }
      const out = await api('POST', '/fuel/credit', { amount_cents: cents, note: flags.note, account_id: account });
      if (out.error) { console.error(`credit failed: ${out.error}`); process.exit(1); }
      console.log(`credited ${cents} cents -> balance now ${out.balance_cents} cents`);
    } else if (sub === 'log') {
      const limit = flags.limit ? Number(flags.limit) : 20;
      const rows = await api('GET', `/fuel/log?account=${account}&limit=${limit}`);
      if (!rows.length) { console.log('(empty ledger)'); break; }
      for (const r of rows) {
        const sign = r.amount_cents > 0 ? '+' : '';
        console.log(`  ${r.id}  ${r.op.padEnd(8)} ${sign}${r.amount_cents}c  ${r.job_id || '—'}  ${r.note || ''}`);
      }
    } else {
      console.error('usage: molt fuel balance|credit|log');
      process.exit(1);
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
  console.log(`molt — Distributed Agent Compute Grid  v${version()}

  molt doctor
  molt broker start                  (set MOLT_AUTH=1 to require API keys)
  molt worker start [--adapters mock,codex,claude,local,bedrock] [--owner NAME] [--max-slots N] [--trust N]
  molt infer "<prompt>" [--title T] [--adapter local|bedrock]
  molt result <objective-id>         (print inference completions)
  molt objective create "<title>" [--prompt TEXT] [--repo PATH] [--base BRANCH] [--plan llm]
  molt objective create -f <spec.json>
  molt key create [--name WHO] [--scopes dispatch,worker]   |   molt key list   |   molt key revoke <id>
  molt fuel balance [--account acct_primary]
  molt fuel credit <cents> [--note TEXT] [--account acct_primary]
  molt fuel log [--limit N] [--account acct_primary]
  molt github import-issues --repo <path> [--label L] [--limit N] [--test "npm test"]
  molt approve <objective-id>        (github repo -> opens a PR; local repo -> merges)
  molt status [objective-id]
  molt dashboard

  env: MOLT_API_KEY (client auth), MOLT_OPENAI_BASE/MODEL (local provider), MOLT_BEDROCK_REGION/MODEL + AWS creds
       MOLT_FUEL_REAL=1 (real x402 spend), MOLT_REP_THRESHOLD (default 0.4), MOLT_MIN_BALANCE (default 1 cent)
`);
  process.exit(1);
}
