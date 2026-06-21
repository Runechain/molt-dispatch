# molt-dispatch

**A local-install Distributed Agent Compute Grid (DACG).**

A pull-based broker that turns a high-level objective into bounded *work units*, hands
them to heterogeneous AI workers (Claude, Codex) running on your own machine under your
own logins, validates the results with tests + review, and recomposes the accepted work
into a merged branch — with a single human approval at the end.

This is the per-person, local version of the system described in `dawgpaper/WHITEPAPER.md`.
Everything runs on one machine: **broker + worker + dashboard**, zero external services,
zero npm dependencies. Your AI subscriptions never leave your computer — each adapter
drives a locally-authenticated CLI; the broker only ever sees jobs and artifacts.

```
objective  →  plan (job DAG)  →  worker claims  →  codex implements
           →  validate (schema · static · tests · review)  →  accept
           →  human approves  →  merge
```

## Requirements

- **Node ≥ 24** (uses the built-in `node:sqlite` and native ESM — no build step).
- **git ≥ 2.5** (worktrees).
- Logged-in CLIs for the adapters you want to use:
  - `claude` — `claude /login` (Pro/Max subscription or API). Used for review/reasoning.
  - `codex` — `codex login` (ChatGPT account or API). Used for implementation.
- The `mock` adapter needs nothing and exercises the whole loop with zero AI cost.

Check your logins:

```bash
claude --version && codex login status
```

## Quick start (zero-cost mock loop)

Three terminals (or background the broker):

```bash
# 1. start the control plane
node bin/molt.mjs broker start

# 2. create + plan an objective
node bin/molt.mjs objective create "Add a waitlist endpoint" --prompt "POST /api/waitlist"

# 3. run a worker that drains the queue (no AI, no cost)
node bin/molt.mjs worker start --adapters mock

# watch it
node bin/molt.mjs status
node bin/molt.mjs approve O-01
```

## The "hello world of the grid" (real agents)

Runs a real objective against the bundled example repo: **Codex implements** a function
until the tests pass, **Claude reviews** the diff, the broker runs `npm test` itself, and
on success the objective becomes approvable.

```bash
node bin/molt.mjs broker start            # terminal 1
node bin/molt.mjs objective create -f examples/waitlist-objective.json
node bin/molt.mjs worker start --adapters codex,claude   # terminal 2

node bin/molt.mjs dashboard               # open the web UI
node bin/molt.mjs status                  # or watch from the CLI
# when O-01 is ready_for_approval:
node bin/molt.mjs approve O-01            # merges grid/J-0001 into the example repo's main
```

There are **no midstream human questions** — the human only defines the objective + its
completion contract up front, and approves the merge at the end.

## Commands

```
molt broker start                              start the control plane (run first)
molt worker start [--adapters mock,codex,claude] [--owner N] [--max-slots N] [--trust N]
molt objective create "<title>" [--prompt T] [--repo PATH] [--base BRANCH]
molt objective create -f <spec.json>           create from a JSON spec (with completion contract)
molt approve <objective-id>                     human gate: approve & merge accepted work
molt status [objective-id]                      objectives / jobs / workers / reputation
molt dashboard                                  open the web dashboard
```

## How it works

| Concept | Where | Whitepaper |
| --- | --- | --- |
| Pull-based broker + REST API | `src/broker/server.mjs` | §5, §11 |
| Objective → job DAG (template planner) | `src/broker/planner.mjs` | §13 |
| Filter-then-rank scheduler | `src/broker/scheduler.mjs` | §6 |
| Layered validation (schema · static · automated · review) | `src/broker/validator.mjs` | §7 |
| Mechanical accept / retry / unlock (completion contract) | `src/broker/lifecycle.mjs` | §12 |
| Per-capability reputation | `src/broker/reputation.mjs` | §8 |
| Worker daemon (register/heartbeat/claim/submit) | `src/worker/daemon.mjs` | §5 |
| Git-worktree isolation | `src/worker/workspace.mjs` | §10 |
| Adapters (mock / codex / claude) | `src/worker/adapters/` | §4 |
| Human approval + merge | `src/broker/broker-ops.mjs` | §9 |
| Data model (SQLite) | `src/broker/db.mjs` | §11 |

### The completion contract

An objective carries a contract (see `examples/waitlist-objective.json`) that the broker
enforces mechanically — no taste, just rules:

```jsonc
"contract": {
  "hard_completion_gates": ["...", "the test suite (node --test) passes"],
  "forbidden_without_approval": ["modifying any file under test/"],
  "constraints": { "max_files_changed": 3 },
  "protected_paths": ["test/"],          // machine-checkable scope guard
  "validation": { "automated": ["npm test"] },
  "quality_thresholds": { "implementation_review_score_min": 0.7, "confidence_min": 0.6 }
}
```

### Adapter isolation

Codex is run with an isolated `CODEX_HOME` (`.codex-grid-home/`, auth symlinked from
`~/.codex`) so grid jobs don't inherit your global plugins/AGENTS.md/reasoning settings —
the agent edits directly instead of planning-and-waiting. Credentials stay local; the
broker never receives them.

## Notes & limits (this is Phase 0)

- Single machine, single user. Remote/public workers, trust tiers across machines,
  reputation markets, and an LLM planner are deferred (whitepaper Phases 4–5).
- The planner is a deterministic template (`code.feature` → implement → review).
- Validation trusts the local machine to run the acceptance commands.

## License

Dual-licensed: GNU AGPL-3.0-or-later + commercial (see whitepaper).
