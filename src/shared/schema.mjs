// Contracts that govern what flows through the grid.
//
// Two of these are real JSON Schemas handed to `claude -p --json-schema ...`, so the
// model's output is validated at the source instead of being parsed out of prose.
//   - REVIEW_RUBRIC_SCHEMA  : a review job's scored verdict (claude)
//   - PLAN_SCHEMA           : an objective decomposed into a job DAG (claude planner, later)
//
// RESULT_ENVELOPE_SCHEMA is the shape a worker submits to POST /jobs/{id}/result. For codex
// implementation jobs the worker derives patch/changed_files/tests from git (ground truth)
// and the model only contributes summary/known_risks/confidence.

// ---- Job result envelope (worker -> broker) ----------------------------------
export const RESULT_ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['lease_token', 'status'],
  additionalProperties: true,
  properties: {
    lease_token: { type: 'string' },
    status: { enum: ['completed', 'failed'] },
    summary: { type: 'string' },
    changed_files: { type: 'array', items: { type: 'string' } },
    tests_run: { type: 'array', items: { type: 'string' } },
    known_risks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    // review jobs attach their rubric here
    review: { type: 'object' },
    error: { type: 'string' },
  },
};

// ---- Review rubric (claude review job, --json-schema enforced) ----------------
// WHITEPAPER §7 rubric, normalized to 0-5 scores + an overall recommendation.
export const REVIEW_RUBRIC_SCHEMA = {
  type: 'object',
  required: [
    'correctness',
    'scope_control',
    'maintainability',
    'security',
    'test_coverage',
    'confidence',
    'recommendation',
    'summary',
  ],
  additionalProperties: false,
  properties: {
    correctness: { type: 'integer', minimum: 0, maximum: 5 },
    scope_control: { type: 'integer', minimum: 0, maximum: 5 },
    maintainability: { type: 'integer', minimum: 0, maximum: 5 },
    security: { type: 'integer', minimum: 0, maximum: 5 },
    test_coverage: { type: 'integer', minimum: 0, maximum: 5 },
    confidence: { type: 'integer', minimum: 0, maximum: 5 },
    recommendation: { enum: ['approve', 'request_changes', 'reject'] },
    summary: { type: 'string' },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'detail'],
        additionalProperties: false,
        properties: {
          severity: { enum: ['low', 'medium', 'high'] },
          detail: { type: 'string' },
        },
      },
    },
  },
};

// ---- Planner output (objective -> job DAG; claude planner, later phase) -------
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['jobs'],
  additionalProperties: false,
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'type', 'title', 'capability'],
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          capability: { type: 'string' },
          prompt: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// ---- Minimal runtime validators (zero-dep) -----------------------------------
// Not a full JSON-Schema engine — just enough to reject malformed worker output
// at the broker boundary (validation Layer 1, WHITEPAPER §7).

export function validateAgainst(schema, value, path = '$') {
  const errors = [];
  check(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function check(schema, value, path, errors) {
  if (schema.enum) {
    if (!schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
    return;
  }
  const t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}.${req}: required`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) errors.push(`${path}.${k}: unexpected property`);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) check(sub, value[k], `${path}.${k}`, errors);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errors));
  } else if (t === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected string`);
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || (t === 'integer' && !Number.isInteger(value))) {
      errors.push(`${path}: expected ${t}`);
    } else {
      if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: < ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: > ${schema.maximum}`);
    }
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
  }
}
