// Integration agent — the judgment layer over the dependency floor.
//
// The deterministic floor (objective-deps.mjs) blocks a dependent B until its upstream A is
// 'approved'. But 'approved' is nuanced: in PR mode it means A's PR was OPENED, not necessarily
// merged to the base B forks from. Rather than hardcode "merge-gate vs stack", the broker
// DELIBERATES per case — a cheap debate panel argues, a premium judge rules — and only asks a
// human when it genuinely can't decide. This is "make the broker smart": logic is the floor,
// the agent is the judgment, the human is the last resort.
//
// Decisions: release (B may run), hold (not safe yet — wait), escalate (human must decide).
// The agent can only TIGHTEN within the floor (it never releases an objective the floor blocks)
// and is OFF by default — unconfigured, the broker keeps the deterministic floor behavior.

import { deliberate } from './deliberate.mjs';
import { getDb, now, logEvent } from '../db.mjs';
import {
  objectivesDependingOn,
  objectiveDepsSatisfied,
  applyObjectiveGatingStatus,
  setObjectiveHold,
  clearObjectiveHold,
} from '../objective-deps.mjs';

let INFER = null;

// Bound premium fan-out: at most this many full debates per approval event; beyond it, remaining
// dependents are held (and surfaced) for later re-evaluation rather than each spending a debate.
const MAX_DELIBERATIONS = Number(process.env.MOLT_MAX_DELIBERATIONS || 8);

// Wire a real inference function (cheap+premium tiers) at broker start. Left null => the broker
// falls back to the deterministic floor (release-on-approve). See makeProviderInfer in deliberate.mjs.
export function setIntegrationInfer(fn) {
  INFER = typeof fn === 'function' ? fn : null;
}
export function integrationConfigured() {
  return typeof INFER === 'function';
}

// Facts the panel reasons over: "is it safe for dependent B to START now that upstream A is approved?"
function gatherContext(dependentId, upstreamId) {
  const d = getDb();
  const dep = d.prepare(`SELECT id,title,branch_base,status FROM objectives WHERE id=?`).get(dependentId);
  const up = d.prepare(`SELECT id,title,repo,branch_base,pr_url,status,source_issue FROM objectives WHERE id=?`).get(upstreamId);
  const prMode = !!up?.pr_url;
  return {
    upstream: {
      id: up?.id,
      title: up?.title,
      status: up?.status,
      issue: up?.source_issue ?? null,
      integration: prMode ? 'pr_opened' : 'merged_to_base_or_no_repo',
      pr_url: up?.pr_url ?? null,
    },
    dependent: { id: dep?.id, title: dep?.title, base: dep?.branch_base },
    facts: [
      prMode
        ? `The upstream is in PR mode: its PR (${up.pr_url}) is OPEN and may NOT yet be merged into "${up.branch_base}". A dependent forking that base would NOT see the upstream's code.`
        : `The upstream was merged into base "${up?.branch_base}" (or has no repo), so its code is present on the base the dependent forks.`,
      'Releasing a dependent that builds on absent upstream code wastes work and risks broken merges.',
    ],
  };
}

const QUESTION =
  'Now that the upstream objective is approved, may the dependent objective START? ' +
  'Choose "release" ONLY if the upstream\'s code is genuinely available on the base the dependent will fork. ' +
  'Choose "hold" if it is not yet available (e.g. the PR is open but unmerged) and we should simply wait. ' +
  'A human review ("escalate") is for genuine conflict or ambiguity only.';

// For each dependent newly satisfied by upstreamId's approval, deliberate and apply the verdict.
// Returns a per-dependent decision summary.
export async function integrateUpstreamApproved(upstreamId) {
  const results = [];
  let deliberations = 0;
  for (const depId of objectivesDependingOn(upstreamId)) {
    // The floor still rules: if other upstreams aren't approved, the dependent isn't eligible yet.
    if (!objectiveDepsSatisfied(depId)) {
      results.push({ dependent: depId, decision: 'hold', reason: 'other upstream dependencies not yet approved' });
      continue;
    }
    if (!INFER) {
      // Deterministic floor: release on approval.
      clearObjectiveHold(depId);
      applyObjectiveGatingStatus(depId);
      results.push({ dependent: depId, decision: 'release', reason: 'deterministic floor (integration agent not configured)' });
      continue;
    }
    // PRE-HOLD across the (multi-second) deliberation. The floor gate opened the instant the
    // upstream flipped to 'approved'; without this, a concurrent /jobs/claim could leak this
    // dependent's jobs during the await. Held now, released only on a 'release' verdict.
    setObjectiveHold(depId);

    // Cost cap: beyond the fan-out limit, leave the dependent held + surfaced instead of debating.
    if (deliberations >= MAX_DELIBERATIONS) {
      logEvent('objective', depId, 'integration_deferred', { upstream: upstreamId, reason: 'deliberation cap reached' });
      results.push({ dependent: depId, decision: 'hold', reason: 'deliberation cap reached — held for re-evaluation' });
      continue;
    }
    deliberations++;
    let verdict;
    try {
      verdict = await deliberate({
        question: QUESTION,
        context: gatherContext(depId, upstreamId),
        decisions: ['release', 'hold'],
        infer: INFER,
        log: (m) => logEvent('objective', depId, 'integration_deliberation', { msg: m }),
      });
    } catch (err) {
      // A broken panel must not silently release — hold and surface.
      verdict = { decision: 'escalate', escalate: true, escalateReason: `deliberation error: ${err.message}`, confidence: 0 };
    }
    applyVerdict(depId, upstreamId, verdict);
    results.push({
      dependent: depId,
      decision: verdict.decision,
      escalate: !!verdict.escalate,
      confidence: verdict.confidence,
      reason: verdict.escalate ? verdict.escalateReason : verdict.rationale,
    });
  }
  return { upstream: upstreamId, dependents: results };
}

function applyVerdict(depId, upstreamId, verdict) {
  const d = getDb();
  if (verdict.decision === 'release') {
    clearObjectiveHold(depId);
    applyObjectiveGatingStatus(depId);
    logEvent('objective', depId, 'integration_release', { upstream: upstreamId, confidence: verdict.confidence, rationale: verdict.rationale });
    return;
  }
  // hold or escalate: tighten the run-gate via dep_hold (unconditional). Only downgrade the
  // DISPLAY status to 'blocked' if the dependent is still pre-terminal — never drag a
  // ready_for_approval/approved dependent backwards.
  setObjectiveHold(depId);
  const cur = d.prepare(`SELECT status FROM objectives WHERE id=?`).get(depId)?.status;
  if (['planning', 'in_progress', 'blocked'].includes(cur)) {
    d.prepare(`UPDATE objectives SET status='blocked', updated_at=? WHERE id=?`).run(now(), depId);
  }
  if (verdict.decision === 'escalate') {
    d.prepare(`UPDATE objectives SET needs_review=1, updated_at=? WHERE id=?`).run(now(), depId);
    logEvent('objective', depId, 'integration_escalate', { upstream: upstreamId, reason: verdict.escalateReason, confidence: verdict.confidence });
  } else {
    logEvent('objective', depId, 'integration_hold', { upstream: upstreamId, confidence: verdict.confidence, rationale: verdict.rationale });
  }
}
