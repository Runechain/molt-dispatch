// Decomp quality validator — checks a planned job list before materialization.
// Called between planObjective() and materialize(); acts as a guardrail against
// degenerate plans: empty prompts, cyclic dependencies, capability mismatches.
// Returns { valid: bool, errors: string[], warnings: string[] }. Errors block
// materialization; warnings are logged but do not block.

const KNOWN_CAPABILITIES = new Set([
  'code.implementation', 'tests.unit', 'code.review', 'docs.technical',
  'product.specification', 'inference',
  'inference.local', 'inference.mid', 'inference.frontier',
  's2.validate',
]);

const MIN_PROMPT_LEN  = 30;   // anything shorter is almost certainly a stub
const MAX_JOBS        = 12;   // safety cap (planner already caps at 8, but be explicit)
const MAX_TITLE_LEN   = 200;
const MAX_FANOUT      = 6;    // max outgoing depends_on edges per node

export function validateDecomp(planned, { objectiveId = '' } = {}) {
  const errors   = [];
  const warnings = [];

  if (!Array.isArray(planned) || planned.length === 0) {
    errors.push('planned is empty — no jobs to materialize');
    return { valid: false, errors, warnings };
  }

  if (planned.length > MAX_JOBS) {
    errors.push(`plan has ${planned.length} jobs but max is ${MAX_JOBS}; broker will truncate`);
  }

  const keys = new Set(planned.map(j => j.key).filter(Boolean));

  for (const j of planned) {
    const prefix = `job '${j.key || '(no key)'}':`;

    // Required fields
    if (!j.key)   errors.push(`${prefix} missing key`);
    if (!j.title) errors.push(`${prefix} missing title`);
    if (j.title  && j.title.length  > MAX_TITLE_LEN) warnings.push(`${prefix} title is very long (${j.title.length} chars)`);
    if (!j.prompt && !j.title) errors.push(`${prefix} neither prompt nor title — worker has nothing to do`);

    const effectivePrompt = j.prompt || j.title || '';
    if (effectivePrompt.length < MIN_PROMPT_LEN) {
      warnings.push(`${prefix} prompt is very short (${effectivePrompt.length} chars) — may produce low-quality output`);
    }

    // Capability
    if (!j.capability) {
      warnings.push(`${prefix} no capability specified — any worker can take it`);
    } else if (!KNOWN_CAPABILITIES.has(j.capability)) {
      warnings.push(`${prefix} unknown capability '${j.capability}' — worker may not be available`);
    }

    // Dependency consistency
    const deps = j.depends_on || [];
    if (deps.length > MAX_FANOUT) {
      warnings.push(`${prefix} depends on ${deps.length} jobs (fan-in > ${MAX_FANOUT})`);
    }
    for (const dep of deps) {
      if (!keys.has(dep)) {
        errors.push(`${prefix} depends_on '${dep}' which is not in this plan`);
      }
    }
  }

  // Cycle detection via DFS
  const depMap = Object.fromEntries(planned.map(j => [j.key, j.depends_on || []]));
  const cyclePath = findCycle(depMap);
  if (cyclePath) {
    errors.push(`dependency cycle detected: ${cyclePath.join(' → ')}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function findCycle(depMap) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  const parent = {};

  function dfs(node) {
    color[node] = GRAY;
    for (const dep of (depMap[node] || [])) {
      if (color[dep] === GRAY) {
        // Reconstruct cycle path
        const path = [dep];
        let cur = node;
        while (cur !== dep) { path.unshift(cur); cur = parent[cur]; if (!cur) break; }
        path.unshift(dep);
        return path;
      }
      if (color[dep] !== BLACK) {
        parent[dep] = node;
        const result = dfs(dep);
        if (result) return result;
      }
    }
    color[node] = BLACK;
    return null;
  }

  for (const node of Object.keys(depMap)) {
    if (!color[node]) {
      const result = dfs(node);
      if (result) return result;
    }
  }
  return null;
}
