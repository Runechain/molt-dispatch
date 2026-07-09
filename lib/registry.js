import { capabilityMatches, createCapability, normalizeCapabilityName } from './capability.js';

export const DEFAULT_CAPABILITIES = Object.freeze([
  createCapability({
    name: 'code.implementation',
    adapter: 'codex',
    planner: true,
    description: 'Modify repository code to satisfy a bounded implementation unit.',
  }),
  createCapability({
    name: 'tests.unit',
    adapter: 'codex',
    planner: true,
    description: 'Add or update focused unit tests.',
  }),
  createCapability({
    name: 'code.review',
    adapter: 'claude',
    planner: true,
    description: 'Review a code change against the objective and completion contract.',
  }),
  createCapability({
    name: 'docs.technical',
    adapter: 'claude',
    planner: true,
    description: 'Produce or update technical documentation.',
  }),
  createCapability({
    name: 'product.specification',
    adapter: 'claude',
    planner: true,
    description: 'Produce product or requirements specifications.',
  }),
  createCapability({
    name: 'inference',
    adapter: null,
    planner: false,
    description: 'General text-in, text-out provider inference.',
  }),
  createCapability({
    name: 'inference.local',
    adapter: 'openai-compatible',
    planner: false,
    description: 'Local inference via Ollama or any OpenAI-compatible daemon (qwen, llama3, mistral, etc.).',
  }),
  createCapability({
    name: 'inference.mid',
    adapter: 'apikey',
    planner: false,
    description: 'API-key inference (OpenAI, Anthropic, Together, etc.) supplied by the player.',
  }),
  createCapability({
    name: 'inference.frontier',
    adapter: 'openrouter',
    planner: false,
    description: 'Frontier-tier inference (GPT-4o, Claude Opus, etc.) via OpenRouter.',
  }),
  createCapability({
    name: 's2.validate',
    adapter: 's2-validator',
    planner: false,
    description: 'S2 content schema validation and game-server ingest. Zero-dep; always available.',
  }),
]);

export class CapabilityRegistry {
  #byName = new Map();
  #aliasToName = new Map();

  constructor(capabilities = []) {
    this.registerMany(capabilities);
  }

  register(input) {
    const capability = createCapability(input);
    if (this.#byName.has(capability.name)) {
      throw new Error(`capability already registered: ${capability.name}`);
    }
    for (const alias of capability.aliases) {
      const existing = this.#aliasToName.get(alias) || this.#byName.get(alias)?.name;
      if (existing && existing !== capability.name) {
        throw new Error(`capability alias already registered: ${alias}`);
      }
    }

    this.#byName.set(capability.name, capability);
    for (const alias of capability.aliases) this.#aliasToName.set(alias, capability.name);
    return capability;
  }

  registerMany(capabilities) {
    if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
    for (const capability of capabilities) this.register(capability);
    return this;
  }

  has(name) {
    return this.resolve(name) !== null;
  }

  get(name) {
    const capability = this.resolve(name);
    if (!capability) throw new Error(`unknown capability: ${name}`);
    return capability;
  }

  resolve(name) {
    const key = normalizeCapabilityName(name);
    return this.#byName.get(key) || this.#byName.get(this.#aliasToName.get(key)) || null;
  }

  match(requested) {
    const key = normalizeCapabilityName(requested, 'requested');
    for (const capability of this.#byName.values()) {
      if (capabilityMatches(capability, key)) return capability;
    }
    return null;
  }

  list(options = {}) {
    const { planner } = options;
    const capabilities = [...this.#byName.values()];
    return planner == null ? capabilities : capabilities.filter((cap) => cap.planner === Boolean(planner));
  }

  names(options = {}) {
    return this.list(options).map((capability) => capability.name);
  }

  adapterFor(name) {
    return this.get(name).adapter;
  }

  adapterMap(options = {}) {
    return Object.freeze(Object.fromEntries(this.list(options).map((capability) => [capability.name, capability.adapter])));
  }

  capabilitiesForAdapter(adapter) {
    if (typeof adapter !== 'string' || !adapter.trim()) throw new TypeError('adapter must be a non-empty string');
    return this.list().filter((capability) => capability.adapter === adapter);
  }

  toJSON() {
    return this.list().map((capability) => ({ ...capability }));
  }
}

export const Registry = CapabilityRegistry;

export function createRegistry(capabilities = DEFAULT_CAPABILITIES) {
  return new CapabilityRegistry(capabilities);
}

export const defaultRegistry = createRegistry();
export const PLANNER_CAPABILITIES = Object.freeze(defaultRegistry.adapterMap({ planner: true }));
export const PLANNER_CAPABILITY_NAMES = Object.freeze(defaultRegistry.names({ planner: true }));

export default defaultRegistry;
