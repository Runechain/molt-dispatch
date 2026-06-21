// Planner: objective -> job DAG. v1 is template-based and deterministic (no LLM, no cost).
// Pluggable: a claude-backed planner emitting PLAN_SCHEMA can drop in later behind plan().

import { getDb, now, nextSeq, logEvent, transaction } from './db.mjs';
import { jobId } from '../shared/ids.mjs';

// Built-in templates keyed by objective type. Each returns plan jobs with local `key`s
// and `depends_on` referencing other keys in the same plan.
const TEMPLATES = {
  // The whitepaper "hello world of the grid": implement, then review. Tests run inside
  // validation, so there's no separate test job — the impl branch is validated in place.
  'code.feature': (obj, contract) => [
    {
      key: 'impl',
      type: 'code.implementation',
      title: `Implement: ${obj.title}`,
      capability: 'code.implementation',
      adapter_hint: 'codex',
      prompt: implPrompt(obj, contract),
      spec: {
        acceptance_criteria: contract.hard_completion_gates || [],
        constraints: {
          max_files_changed: contract.constraints?.max_files_changed ?? 12,
          forbidden: contract.forbidden_without_approval || [],
        },
        validation: contract.validation || {},
      },
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

// Materialize the plan into jobs + dependencies. Jobs start 'blocked' unless they have
// no deps, in which case they go straight to 'pending' and can be claimed.
export function planObjective(objective) {
  const contract = objective.contract || {};
  const template = TEMPLATES[objectiveType(objective)] || TEMPLATES['code.feature'];
  const planned = template(objective, contract);

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
  const insertDep = d.prepare(
    'INSERT INTO job_dependencies(job_id, depends_on_job_id) VALUES(?, ?)'
  );

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
        insertDep.run(keyToId[p.key], keyToId[depKey]);
      }
    }
  });

  logEvent('objective', objective.id, 'planned', { jobs: created });
  return created;
}

function objectiveType(objective) {
  return objective.contract?.objective_type || 'code.feature';
}
