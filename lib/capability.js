const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function asString(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value.trim();
}

export function normalizeCapabilityName(value, field = 'capability') {
  const name = asString(value, field);
  if (!CAPABILITY_RE.test(name)) {
    throw new TypeError(`${field} must match ${CAPABILITY_RE}`);
  }
  return name;
}

export function isCapabilityName(value) {
  return typeof value === 'string' && CAPABILITY_RE.test(value.trim());
}

export function assertCapabilityName(value, field = 'capability') {
  return normalizeCapabilityName(value, field);
}

export function normalizeCapabilityList(values, field = 'capabilities') {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  return [...new Set(values.map((v, i) => normalizeCapabilityName(v, `${field}[${i}]`)))];
}

function capabilityRecord(input, defaults = {}) {
  const src = typeof input === 'string' ? { name: input } : input;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw new TypeError('capability must be a string or object');
  }

  const name = normalizeCapabilityName(src.name ?? src.capability ?? defaults.name, 'capability.name');
  const adapter = src.adapter ?? defaults.adapter ?? null;
  if (adapter != null && typeof adapter !== 'string') throw new TypeError('capability.adapter must be a string or null');

  const description = src.description ?? defaults.description ?? '';
  if (typeof description !== 'string') throw new TypeError('capability.description must be a string');

  const aliases = normalizeCapabilityList(src.aliases ?? defaults.aliases ?? [], 'capability.aliases');
  const tags = normalizeCapabilityList(src.tags ?? defaults.tags ?? [], 'capability.tags');
  const planner = Boolean(src.planner ?? defaults.planner ?? false);
  const metadata = Object.freeze({ ...(defaults.metadata || {}), ...(src.metadata || {}) });

  return Object.freeze({
    name,
    adapter,
    description,
    aliases: Object.freeze(aliases),
    tags: Object.freeze(tags),
    planner,
    metadata,
  });
}

export class Capability {
  constructor(input, defaults = {}) {
    Object.assign(this, capabilityRecord(input, defaults));
    Object.freeze(this);
  }

  matches(requested) {
    return capabilityMatches(this, requested);
  }
}

export function createCapability(input, defaults = {}) {
  return capabilityRecord(input, defaults);
}

export function capabilityMatches(capability, requested) {
  const cap = createCapability(capability);
  const name = normalizeCapabilityName(requested, 'requested');
  return cap.name === name || cap.aliases.includes(name);
}

export default Capability;
