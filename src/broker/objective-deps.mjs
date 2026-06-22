// Inter-objective dependencies — the deterministic floor under the "smart broker".
//
// The broker already models dependencies WITHIN one objective's plan (job_dependencies,
// scheduler "all deps accepted" gate). This adds the same idea ACROSS objectives: objective B
// ("validators") must not be worked until objective A ("schema") is satisfied. Declaring the
// edge is a design call (for now: "Depends on #N" in the GitHub issue body); ENFORCING it is
// the broker's mechanical job and lives here.
//
// This module is conservative and non-bypassable: an unresolved or not-yet-'approved' upstream
// blocks the downstream. The smart per-case judgment (release vs. stack vs. hold) is layered on
// top by the integration agent — but it can only LOOSEN within what this floor permits, never
// leak work before an upstream is at least approved.

import { getDb, now, logEvent } from './db.mjs';

// Satisfaction bar: an upstream objective counts as satisfied only when 'approved'. Not
// 'ready_for_approval' — that means A's jobs were accepted in per-job worktrees but A's code is
// not yet integrated into the base B forks from. 'approved' is the state where integration has
// happened (local mode merges to base; PR mode opens the integration PR — the integration agent
// adjudicates the PR-not-yet-merged nuance on top of this floor).
export const SATISFIED_STATUS = 'approved';

// ---- Declaration / parsing -------------------------------------------------
// Parse "Depends on #N" / "Blocked by #N" (case-insensitive, comma lists) from an issue body.
// Line-anchored so a stray "#5" elsewhere in prose isn't mistaken for a dependency.
export function parseDependencyIssues(text) {
  if (!text) return [];
  const out = new Set();
  for (const line of String(text).split('\n')) {
    if (!/(depends?\s*on|blocked\s*by)/i.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) out.add(Number(m[1]));
  }
  return [...out];
}

// Record edges for one objective (idempotent). depends_on_objective_id stays NULL until the
// upstream issue is imported and resolveAndGate() binds it. Self-dependencies are dropped.
export function recordObjectiveDeps(objectiveId, sourceIssue, depIssues) {
  const d = getDb();
  const ins = d.prepare(
    `INSERT OR IGNORE INTO objective_dependencies(objective_id, depends_on_objective_id, depends_on_issue, status, created_at)
     VALUES(?, NULL, ?, 'active', ?)`
  );
  let recorded = 0;
  for (const issue of depIssues) {
    if (sourceIssue != null && issue === sourceIssue) {
      logEvent('objective', objectiveId, 'dependency_self_ignored', { issue });
      continue;
    }
    const r = ins.run(objectiveId, issue, now());
    if (r.changes) recorded++;
  }
  return recorded;
}

// ---- Resolution + cycle detection + gating ---------------------------------
// The single resolution entry point — called by importIssues (after the batch) and by the
// single-objective create path. Binds issue#->objectiveId, detects cycles (dropping the
// back-edges so a cycle can never deadlock the pipeline), then reconciles each dependent
// objective's display status. Idempotent: safe to run on every import.
export function resolveAndGate() {
  const d = getDb();

  // 1) Bind unresolved edges via objectives.source_issue. Guard against an ambiguous issue#
  //    mapping to more than one objective (don't silently mis-bind).
  const unresolved = d
    .prepare(`SELECT objective_id, depends_on_issue FROM objective_dependencies WHERE depends_on_objective_id IS NULL AND status='active'`)
    .all();
  let resolved = 0;
  const bind = d.prepare(`UPDATE objective_dependencies SET depends_on_objective_id=? WHERE objective_id=? AND depends_on_issue=?`);
  for (const row of unresolved) {
    const matches = d.prepare(`SELECT id FROM objectives WHERE source_issue=? ORDER BY created_at ASC`).all(row.depends_on_issue);
    if (matches.length === 0) {
      logEvent('objective', row.objective_id, 'dependency_unresolved', { issue: row.depends_on_issue });
      continue;
    }
    if (matches.length > 1) {
      logEvent('objective', row.objective_id, 'dependency_ambiguous', { issue: row.depends_on_issue, candidates: matches.map((m) => m.id) });
    }
    bind.run(matches[0].id, row.objective_id, row.depends_on_issue);
    resolved++;
  }

  // 2) Detect cycles over resolved active edges; drop (status='cycle') each back-edge so the
  //    floor never deadlocks. A dropped edge is logged and surfaced — never silently enforced.
  const cycles = detectAndBreakCycles();

  // 3) Reconcile display status for every objective that has active deps.
  const affected = d.prepare(`SELECT DISTINCT objective_id FROM objective_dependencies WHERE status='active'`).all();
  let blocked = 0;
  for (const { objective_id } of affected) {
    if (applyObjectiveGatingStatus(objective_id)) blocked++;
  }
  return { resolved, cycles, blocked };
}

// DFS back-edge detection over resolved active edges (objective -> depends_on). Marks each
// back-edge status='cycle' (excluded from enforcement) and logs it.
function detectAndBreakCycles() {
  const d = getDb();
  const edges = d
    .prepare(`SELECT objective_id, depends_on_objective_id, depends_on_issue FROM objective_dependencies WHERE status='active' AND depends_on_objective_id IS NOT NULL`)
    .all();
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.objective_id)) adj.set(e.objective_id, []);
    adj.get(e.objective_id).push({ to: e.depends_on_objective_id, issue: e.depends_on_issue });
  }
  const color = new Map(); // undefined=white, 1=gray, 2=black
  const dropped = [];
  const drop = d.prepare(`UPDATE objective_dependencies SET status='cycle' WHERE objective_id=? AND depends_on_issue=?`);
  const dfs = (u) => {
    color.set(u, 1);
    for (const e of adj.get(u) || []) {
      if (color.get(e.to) === 1) {
        // back-edge: u depends_on e.to but e.to (transitively) depends_on u → cycle
        drop.run(u, e.issue);
        dropped.push({ objective: u, depends_on: e.to, issue: e.issue });
        logEvent('objective', u, 'dependency_cycle', { depends_on: e.to, issue: e.issue });
      } else if (!color.get(e.to)) {
        dfs(e.to);
      }
    }
    color.set(u, 2);
  };
  for (const u of adj.keys()) if (!color.get(u)) dfs(u);
  return dropped;
}

// Set objective.status to 'blocked' when it has unsatisfied active deps, else 'in_progress'.
// Only moves objectives that are in a pre-terminal state — never disturbs ready_for_approval /
// approved / failed. Returns true if it ended 'blocked'. (Display only; the scheduler gate is
// the real enforcement, so this can never cause a leak even if it races.)
export function applyObjectiveGatingStatus(objectiveId) {
  const d = getDb();
  const o = d.prepare(`SELECT status FROM objectives WHERE id=?`).get(objectiveId);
  if (!o) return false;
  if (!['planning', 'in_progress', 'blocked'].includes(o.status)) return false;
  const blocked = !objectiveDepsSatisfied(objectiveId);
  const next = blocked ? 'blocked' : 'in_progress';
  if (next !== o.status) {
    d.prepare(`UPDATE objectives SET status=?, updated_at=? WHERE id=?`).run(next, now(), objectiveId);
    logEvent('objective', objectiveId, blocked ? 'blocked_on_dependency' : 'unblocked', unsatisfiedDepsFor(objectiveId));
  }
  return blocked;
}

// ---- Queries (enforcement + liveness) --------------------------------------

// True when every active dep is resolved AND its upstream objective is 'approved'.
export function objectiveDepsSatisfied(objectiveId) {
  const d = getDb();
  const deps = d
    .prepare(
      `SELECT od.depends_on_objective_id AS dep, o.status AS dep_status
         FROM objective_dependencies od
         LEFT JOIN objectives o ON o.id = od.depends_on_objective_id
        WHERE od.objective_id=? AND od.status='active'`
    )
    .all(objectiveId);
  return deps.every((x) => x.dep != null && x.dep_status === SATISFIED_STATUS);
}

// The set of objective ids that currently have at least one unsatisfied active dependency.
// Computed once per claim so the scheduler gate is a single query, not N subqueries.
export function objectivesWithUnsatisfiedDeps() {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT od.objective_id AS oid, od.depends_on_objective_id AS dep, o.status AS dep_status
         FROM objective_dependencies od
         LEFT JOIN objectives o ON o.id = od.depends_on_objective_id
        WHERE od.status='active'`
    )
    .all();
  const blocked = new Set();
  for (const r of rows) {
    if (r.dep == null || r.dep_status !== SATISFIED_STATUS) blocked.add(r.oid);
  }
  return blocked;
}

// Human-readable reason an objective is held — the operator's escape hatch (rendered in
// listObjectives / molt status). Empty array means "not blocked on any upstream".
export function unsatisfiedDepsFor(objectiveId) {
  const d = getDb();
  const deps = d
    .prepare(
      `SELECT od.depends_on_issue AS issue, od.depends_on_objective_id AS dep, o.status AS dep_status
         FROM objective_dependencies od
         LEFT JOIN objectives o ON o.id = od.depends_on_objective_id
        WHERE od.objective_id=? AND od.status='active'`
    )
    .all(objectiveId);
  return deps
    .filter((x) => x.dep == null || x.dep_status !== SATISFIED_STATUS)
    .map((x) => ({ issue: x.issue, depends_on: x.dep, upstream_status: x.dep == null ? 'unresolved' : x.dep_status }));
}

// Objectives that declare a (resolved, active) dependency on the given objective.
export function objectivesDependingOn(objectiveId) {
  return getDb()
    .prepare(`SELECT DISTINCT objective_id FROM objective_dependencies WHERE depends_on_objective_id=? AND status='active'`)
    .all(objectiveId)
    .map((r) => r.objective_id);
}

// ---- Lifecycle hooks -------------------------------------------------------

// Called after an objective reaches 'approved'. Re-gates its dependents; returns the ids that
// became fully satisfied (now eligible to run). The integration agent layers its release/hold/
// escalate judgment on this seam; the deterministic floor simply unblocks the display status.
export function onUpstreamApproved(objectiveId) {
  const unblocked = [];
  for (const depId of objectivesDependingOn(objectiveId)) {
    const stillBlocked = applyObjectiveGatingStatus(depId);
    if (!stillBlocked && objectiveDepsSatisfied(depId)) unblocked.push(depId);
  }
  return unblocked;
}

// Called when an objective fails permanently. Dependents are PARKED (not cascade-failed — A can
// be re-run later) but the wedge is surfaced so it isn't a silent stall.
export function onUpstreamFailed(objectiveId) {
  const dependents = objectivesDependingOn(objectiveId);
  for (const depId of dependents) {
    logEvent('objective', depId, 'dependency_failed', { failed: objectiveId });
  }
  return dependents;
}
