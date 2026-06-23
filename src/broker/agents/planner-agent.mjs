// Planner agent — "run logic first, then decompose all jobs."
//
// The template planner is deterministic but shallow: it stamps a fixed implement->review pair
// and never reads the objective, so a big objective becomes one giant impl job. The planner
// agent fixes that: logic first produces the deterministic scaffold + the rules, then a custom
// agent DECOMPOSES the objective into the full, file-scoped job DAG. Validated against
// PLAN_SCHEMA; planObjective falls back to the template if the agent is unconfigured or fails.
//
// Provider-agnostic: the caller injects `infer` (see makeProviderInfer in deliberate.mjs).
// Decomposition is the call that matters, so it runs on the PREMIUM tier. OFF by default.

import { extractJson } from '../../shared/jsonout.mjs';
import { PLAN_SCHEMA, validateAgainst } from '../../shared/schema.mjs';
import { fenceUntrusted, sanitizeTitle } from '../../shared/prompt-safety.mjs';
import { logEvent } from '../db.mjs';

const CAPS = ['code.implementation', 'tests.unit', 'code.review', 'docs.technical', 'product.specification'];

let INFER = null;
export function setPlannerInfer(fn) {
  INFER = typeof fn === 'function' ? fn : null;
}
export function plannerConfigured() {
  return typeof INFER === 'function';
}

// Logic-first pass: the deterministic facts and rules the agent must honor. Computed in code,
// never by a model — this is the "run logic first" half.
function logicScaffold(objective) {
  const c = objective.contract || {};
  return {
    objective_type: c.objective_type || 'code.feature',
    baseline: 'A code.feature minimally decomposes into implement -> review; expand it into the real, file-scoped DAG.',
    hard_completion_gates: c.hard_completion_gates || [],
    constraints: {
      max_files_changed: c.constraints?.max_files_changed ?? 12,
      protected_paths: c.protected_paths || [],
    },
    available_capabilities: CAPS,
  };
}

function plannerAgentPrompt(objective, scaffold) {
  return [
    'You are the PLANNER AGENT. Logic has already produced the deterministic scaffold below. Your job is to DECOMPOSE the objective into the full job DAG — bounded, independently checkable, FILE-SCOPED work units.',
    `\nObjective: "${sanitizeTitle(objective.title)}"`,
    objective.prompt ? `Detail:\n${fenceUntrusted(objective.prompt)}` : '',
    `\nLogic-first scaffold (honor these):\n${JSON.stringify(scaffold, null, 2)}`,
    '\nRules:',
    `  - Use ONLY these capabilities: ${CAPS.join(', ')}.`,
    '  - Every implementation unit (code.implementation) MUST be followed by a code.review unit that depends_on it.',
    '  - Keep each unit small and to a tight file scope; prefer creating new files over editing shared/monolithic ones; use depends_on to serialize units that must land in order.',
    '  - At most 8 units total.',
    '\nRespond with ONLY JSON (no prose, no fences):',
    '{"jobs":[{"key":"impl_x","type":"code.implementation","title":"...","capability":"code.implementation","prompt":"detailed file-scoped instructions","depends_on":[]},',
    ' {"key":"review_x","type":"code.review","title":"...","capability":"code.review","prompt":"what to check","depends_on":["impl_x"]}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

// Returns a validated PLAN_SCHEMA plan ({ jobs: [...] }) or null (→ planObjective falls back to
// the template). Never throws.
export async function decomposeWithAgent(objective) {
  if (!INFER) return null;
  const scaffold = logicScaffold(objective);
  let res;
  try {
    res = await INFER({
      tier: 'premium',
      role: 'planner',
      phase: 'decompose',
      system: 'You decompose software objectives into bounded work units. You output only the requested JSON.',
      prompt: plannerAgentPrompt(objective, scaffold),
    });
  } catch (e) {
    logEvent('objective', objective.id, 'planner_agent_error', { error: e.message });
    return null;
  }
  const plan = extractJson(res?.text);
  const check = validateAgainst(PLAN_SCHEMA, plan);
  if (!check.valid) {
    logEvent('objective', objective.id, 'planner_agent_invalid', { errors: check.errors.slice(0, 5) });
    return null;
  }
  logEvent('objective', objective.id, 'planner_agent_decomposed', { units: plan.jobs.length });
  return plan;
}
