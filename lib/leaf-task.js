// Portable schema for a leaf task: the smallest schedulable work unit handed to
// a worker. Kept zero-dependency so it can be imported by broker, worker, tests,
// and external tooling without pulling in the rest of the runtime.

export const LeafTask = Object.freeze({
  type: 'object',
  required: ['id', 'title', 'prompt', 'capability'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    objective_id: { type: 'string', minLength: 1 },
    key: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    prompt: { type: 'string', minLength: 1 },
    capability: { type: 'string', minLength: 1 },
    adapter_hint: { type: 'string', minLength: 1 },
    repo: { type: 'string', minLength: 1 },
    branch_base: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
    priority: { type: 'integer', minimum: 0 },
    estimated_minutes: { type: 'integer', minimum: 1 },
    depends_on: { type: 'array', items: { type: 'string', minLength: 1 } },
    acceptance_criteria: { type: 'array', items: { type: 'string', minLength: 1 } },
    hard_completion_gates: { type: 'array', items: { type: 'string', minLength: 1 } },
    constraints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_files_changed: { type: 'integer', minimum: 1 },
        forbidden: { type: 'array', items: { type: 'string', minLength: 1 } },
        forbidden_without_approval: { type: 'array', items: { type: 'string', minLength: 1 } },
        protected_paths: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        automated: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    inputs: { type: 'object', additionalProperties: true },
    metadata: { type: 'object', additionalProperties: true },
    contract: { type: 'object', additionalProperties: true },
  },
});

export const LeafTaskSchema = LeafTask;

export function validateLeafTask(value) {
  const errors = [];
  check(LeafTask, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

function check(schema, value, path, errors) {
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
    }
    return;
  }

  if (!schema.type) return;

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties || {})) {
      if (key in value) check(subSchema, value[key], `${path}.${key}`, errors);
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (schema.items) value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path}: expected string`);
      return;
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    return;
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    const isNumber = typeof value === 'number' && Number.isFinite(value);
    if (!isNumber || (schema.type === 'integer' && !Number.isInteger(value))) {
      errors.push(`${path}: expected ${schema.type}`);
      return;
    }
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: < ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: > ${schema.maximum}`);
    return;
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path}: expected boolean`);
  }
}
