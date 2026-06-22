// $0 verification of the planner agent — logic-first, then agent decomposition. Injects a mock
// infer (no real models). Proves: the logic scaffold is fed to the agent, a valid plan becomes a
// materialized multi-job DAG with dependencies, invalid/absent agent falls back to the template.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'moltplan-'));

const { getDb, now } = await import('../src/broker/db.mjs');
const pa = await import('../src/broker/agents/planner-agent.mjs');
const { planObjective } = await import('../src/broker/planner.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };

const d = getDb();
let oseq = 0;
function objRow(contract) {
  const id = `O-${++oseq}`;
  d.prepare(`INSERT INTO objectives(id,title,prompt,contract_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, `Build the overworld engine`, 'movement, camera, minimap, transitions', JSON.stringify(contract), 'planning', now(), now());
  return { id, title: 'Build the overworld engine', prompt: 'movement, camera, minimap, transitions', contract };
}
const jobsFor = (oid) => d.prepare(`SELECT * FROM jobs WHERE objective_id=? ORDER BY created_at ASC`).all(oid);
const depsCount = (oid) => d.prepare(
  `SELECT COUNT(*) c FROM job_dependencies WHERE job_id IN (SELECT id FROM jobs WHERE objective_id=?)`
).get(oid).c;

const PLAN = {
  jobs: [
    { key: 'impl_move', type: 'code.implementation', title: 'movement', capability: 'code.implementation', prompt: 'add movement.js', depends_on: [] },
    { key: 'rev_move', type: 'code.review', title: 'review movement', capability: 'code.review', prompt: 'check', depends_on: ['impl_move'] },
    { key: 'impl_cam', type: 'code.implementation', title: 'camera', capability: 'code.implementation', prompt: 'add camera.js', depends_on: ['impl_move'] },
    { key: 'rev_cam', type: 'code.review', title: 'review camera', capability: 'code.review', prompt: 'check', depends_on: ['impl_cam'] },
  ],
};

console.log('planner agent — logic-first prompt + decomposition');
{
  let seenPrompt = '';
  pa.setPlannerInfer(async ({ tier, role, prompt }) => {
    seenPrompt = prompt;
    ok(tier === 'premium' && role === 'planner', 'decomposition runs on the premium tier');
    return { text: JSON.stringify(PLAN) };
  });
  const objective = { id: 'O-probe', title: 'X', prompt: 'detail here', contract: { planner: 'agent', hard_completion_gates: ['tests pass'], constraints: { max_files_changed: 9 } } };
  const plan = await pa.decomposeWithAgent(objective);
  ok(plan && plan.jobs.length === 4, 'agent returns a validated 4-unit plan');
  ok(/Logic-first scaffold/.test(seenPrompt), 'logic runs first: the scaffold is in the agent prompt');
  ok(/tests pass/.test(seenPrompt) && /max_files_changed/.test(seenPrompt), 'scaffold carries the contract gates + constraints');
  ok(/detail here/.test(seenPrompt), 'objective detail is included for decomposition');
}

console.log('planner agent — planObjective materializes the agent DAG');
{
  pa.setPlannerInfer(async () => ({ text: JSON.stringify(PLAN) }));
  const objective = objRow({ planner: 'agent' });
  const created = await planObjective(objective);
  ok(created.length === 4, 'objective materialized into 4 jobs (real decomposition, not impl→review wrap)');
  const jobs = jobsFor(objective.id);
  const pending = jobs.filter((j) => j.status === 'pending');
  ok(pending.length === 1 && pending[0].job_key === 'impl_move', 'only the dep-free root job is born pending');
  ok(depsCount(objective.id) === 3, 'job_dependencies materialized (rev_move, impl_cam, rev_cam)');
}

console.log('planner agent — invalid output and absent agent fall back to the template');
{
  pa.setPlannerInfer(async () => ({ text: 'not json at all' }));
  const o1 = objRow({ planner: 'agent' });
  const j1 = await planObjective(o1);
  ok(j1.length === 2 && j1.some((j) => j.key === 'impl') && j1.some((j) => j.key === 'review'), 'invalid agent output → template impl→review');

  pa.setPlannerInfer(null);
  ok(pa.plannerConfigured() === false, 'agent disabled');
  const o2 = objRow({ planner: 'agent' });
  const j2 = await planObjective(o2);
  ok(j2.length === 2, 'unconfigured agent → deterministic template fallback');
}

console.log(`\n✅ planner agent: ${passed} checks passed`);
