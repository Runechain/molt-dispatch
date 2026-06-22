// Planner: objective -> job DAG.
//
// Two planners, selected by contract.planner ('template' default, or 'llm'):
//   - template : deterministic, zero-cost. code.feature -> implement -> review.
//   - llm      : claude decomposes an arbitrary objective into a DAG (PLAN_SCHEMA),
//                with the template as a safety-net fallback if it fails or is malformed.

import { getDb, now, nextSeq, logEvent, transaction } from './db.mjs';
import { jobId } from '../shared/ids.mjs';
import { run } from '../shared/proc.mjs';
import { extractJson } from '../shared/jsonout.mjs';
import { PLAN_SCHEMA, validateAgainst } from '../shared/schema.mjs';

// Capabilities the grid can currently schedule, and which adapter serves each.
const CAPABILITIES = {
  'code.implementation': 'codex',
  'tests.unit': 'codex',
  'code.review': 'claude',
  'docs.technical': 'claude',
  'product.specification': 'claude',
};

export async function planObjective(objective) {
  const mode = objective.contract?.planner || 'template';
  let planned;
  if (mode === 'llm') {
    planned = await planWithClaude(objective);
    if (!planned || !planned.length) {
      logEvent('objective', objective.id, 'planner_fallback', { reason: 'llm planner failed; using template' });
      planned = templatePlan(objective);
    }
  } else {
    planned = templatePlan(objective);
  }
  return materialize(objective, planned);
}

// ---- Template planner --------------------------------------------------------

const TEMPLATES = {
  // A single prompt -> completion unit. No repo, no worktree, no merge — the general
  // compute path the self-evolving engine runs on. resolveAdapter picks a provider
  // (local Qwen / Bedrock) by capability unless the contract pins adapter_hint.
  inference: (obj, contract) => [
    {
      key: 'infer',
      type: 'inference',
      title: obj.title,
      capability: 'inference',
      adapter_hint: contract.adapter_hint || null,
      prompt: obj.prompt || obj.title,
      spec: {},
      depends_on: [],
    },
  ],
  'code.feature': (obj, contract) => [
    {
      key: 'impl',
      type: 'code.implementation',
      title: `Implement: ${obj.title}`,
      capability: 'code.implementation',
      adapter_hint: 'codex',
      prompt: implPrompt(obj, contract),
      spec: implSpec(contract),
      depends_on: [],
    },
    {
      key: 'review',
      type: 'code.review',
      title: `Review: ${obj.title}`,
      capability: 'code.review',
      adapter_hint: 'claude',
      prompt: reviewPrompt(obj, contract),
      spec: { rubric: true },
      depends_on: ['impl'],
    },
  ],
};

function templatePlan(objective) {
  const contract = objective.contract || {};
  const template = TEMPLATES[objectiveType(objective)] || TEMPLATES['code.feature'];
  return template(objective, contract);
}

function implSpec(contract) {
  return {
    acceptance_criteria: contract.hard_completion_gates || [],
    constraints: {
      max_files_changed: contract.constraints?.max_files_changed ?? 12,
      forbidden: contract.forbidden_without_approval || [],
      protected_paths: contract.protected_paths || [],
    },
    validation: contract.validation || {},
  };
}

function implPrompt(obj, contract) {
  const gates = (contract.hard_completion_gates || []).map((g) => `  - ${g}`).join('\n');
  const forbidden = (contract.forbidden_without_approval || []).map((f) => `  - ${f}`).join('\n');
  return [
    `You are implementing a bounded work unit for the objective: "${obj.title}".`,
    obj.prompt ? `\nObjective detail:\n${obj.prompt}` : '',
    gates ? `\nThis work is DONE only when ALL of these hold:\n${gates}` : '',
    forbidden ? `\nDo NOT do any of the following without approval:\n${forbidden}` : '',
    `\nWork only within this repository. Make the smallest correct change. Add or update tests.`,
    `When finished, ensure the project's tests pass. Do not commit; just leave the working tree changed.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function reviewPrompt(obj, contract) {
  return [
    `You are reviewing a code change implementing: "${obj.title}".`,
    `A git diff (patch) of the change is provided as context in the working directory.`,
    `Assess it against the objective and these gates:`,
    ...(contract.hard_completion_gates || []).map((g) => `  - ${g}`),
    `\nScore each rubric dimension 0-5 and give an overall recommendation.`,
    `Be strict about scope creep, security, and missing tests.`,
  ].join('\n');
}

// ---- LLM planner -------------------------------------------------------------

async function planWithClaude(objective) {
  const contract = objective.contract || {};
  const prompt = plannerPrompt(objective);
  const res = await run(
    'claude',
    ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--allowedTools', ''],
    { timeoutMs: 5 * 60 * 1000 }
  );
  if (res.code !== 0) return null;

  let envelope;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    return null;
  }
  const plan = extractJson(envelope.result);
  const check = validateAgainst(PLAN_SCHEMA, plan);
  if (!check.valid) {
    logEvent('objective', objective.id, 'planner_invalid', { errors: check.errors.slice(0, 5) });
    return null;
  }

  // Map planned jobs to internal form; drop jobs with capabilities we can't schedule.
  const planned = [];
  for (const j of plan.jobs.slice(0, 8)) {
    if (!CAPABILITIES[j.capability]) continue;
    const isImpl = j.capability === 'code.implementation' || j.capability === 'tests.unit';
    planned.push({
      key: j.key,
      type: j.type || (isImpl ? 'code.implementation' : 'code.review'),
      title: j.title,
      capability: j.capability,
      adapter_hint: CAPABILITIES[j.capability],
      prompt: j.prompt || j.title,
      spec: isImpl ? implSpec(contract) : { rubric: j.capability === 'code.review' },
      depends_on: (j.depends_on || []).filter((k) => plan.jobs.some((x) => x.key === k)),
    });
  }
  return planned.length ? planned : null;
}

function plannerPrompt(objective) {
  const caps = Object.entries(CAPABILITIES).map(([c, a]) => `  - ${c} (adapter: ${a})`).join('\n');
  return [
    `Decompose this objective into a SMALL dependency graph (2-5) of bounded work units.`,
    `\nObjective: "${objective.title}"`,
    objective.prompt ? `Detail: ${objective.prompt}` : '',
    `\nAvailable capabilities (use ONLY these):\n${caps}`,
    `\nRules:`,
    `  - Implementation work uses capability "code.implementation".`,
    `  - Every implementation job should be followed by a "code.review" job that depends on it.`,
    `  - Keep each unit small and independently checkable. Use depends_on to serialize where needed.`,
    `\nRespond with ONLY a JSON object (no prose, no fences):`,
    `{"jobs":[{"key":"impl","type":"code.implementation","title":"...","capability":"code.implementation","prompt":"detailed instructions","depends_on":[]},`,
    ` {"key":"review","type":"code.review","title":"...","capability":"code.review","prompt":"what to check","depends_on":["impl"]}]}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- Materialize plan -> jobs + dependencies ---------------------------------

function materialize(objective, planned) {
  const d = getDb();
  const keyToId = {};
  const created = [];

  const insert = d.prepare(`
    INSERT INTO jobs(id, objective_id, job_key, type, title, prompt, capability_required,
                     trust_required, adapter_hint, spec_json, status, priority,
                     estimated_minutes, attempts, created_at, updated_at)
    VALUES(@id,@objective_id,@job_key,@type,@title,@prompt,@capability_required,
           @trust_required,@adapter_hint,@spec_json,@status,@priority,
           @estimated_minutes,0,@ts,@ts)
  `);
  const insertDep = d.prepare('INSERT INTO job_dependencies(job_id, depends_on_job_id) VALUES(?, ?)');

  transaction(() => {
    for (const p of planned) {
      const id = jobId(nextSeq('job'));
      keyToId[p.key] = id;
      const status = (p.depends_on || []).length === 0 ? 'pending' : 'blocked';
      insert.run({
        id,
        objective_id: objective.id,
        job_key: p.key,
        type: p.type,
        title: p.title,
        prompt: p.prompt,
        capability_required: p.capability,
        trust_required: p.trust_required ?? 0,
        adapter_hint: p.adapter_hint,
        spec_json: JSON.stringify(p.spec || {}),
        status,
        priority: p.priority ?? 100,
        estimated_minutes: p.estimated_minutes ?? 20,
        ts: now(),
      });
      created.push({ id, key: p.key, status });
    }
    for (const p of planned) {
      for (const depKey of p.depends_on || []) {
        if (keyToId[depKey]) insertDep.run(keyToId[p.key], keyToId[depKey]);
      }
    }
  });

  logEvent('objective', objective.id, 'planned', { jobs: created });
  return created;
}

function objectiveType(objective) {
  return objective.contract?.objective_type || 'code.feature';
}
