// S2 content validation adapter. Validates inference output before it becomes game content.
// Advertises 's2.validate' capability. Receives the raw inference output as job.prompt,
// checks it against the expected schema for the content type, and optionally POSTs approved
// content to the game server's /api/s2/content endpoint.
//
// This is the quorum/quality layer for the player-compute generation pipeline.
// A broker hook (see server.mjs createS2ValidationJob) auto-creates a validation job after
// each s2-typed inference job completes. The validator is intentionally lightweight — it does
// structural and heuristic checks, not semantic quality scoring, which belongs in a judge panel.

const INGEST_KEY = process.env.MOLT_INGEST_KEY || '';

// ---- Per-type validators ----

function validateNpcDialogue(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'not valid JSON' }; }
  const nodes = Object.keys(parsed);
  if (nodes.length < 2) return { ok: false, reason: 'dialogue needs at least 2 nodes' };
  for (const key of nodes) {
    const n = parsed[key];
    if (!Array.isArray(n.text) || !n.text.length) return { ok: false, reason: `node '${key}' missing text array` };
    if (!n.choices && !n.goto && !n.end) return { ok: false, reason: `node '${key}' has no transition` };
  }
  return { ok: true };
}

function validateLoreFragment(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2 || lines.length > 5) return { ok: false, reason: `expected 2-5 lines, got ${lines.length}` };
  for (const l of lines) {
    if (l.length > 200) return { ok: false, reason: 'line too long (max 200 chars)' };
  }
  return { ok: true };
}

function validateBossScript(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'not valid JSON' }; }
  const required = ['intro', 'phase1_callout', 'phase2_callout', 'defeat'];
  for (const key of required) {
    if (!parsed[key] || typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      return { ok: false, reason: `missing or empty field '${key}'` };
    }
  }
  return { ok: true };
}

function validateAreaIntro(raw) {
  const text = raw.trim();
  if (!text.length) return { ok: false, reason: 'empty' };
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());
  if (sentences.length < 1 || sentences.length > 4) return { ok: false, reason: `expected 1-4 sentences, got ${sentences.length}` };
  if (text.length > 500) return { ok: false, reason: 'too long (max 500 chars)' };
  return { ok: true };
}

const VALIDATORS = {
  npc_dialogue:   validateNpcDialogue,
  lore_fragment:  validateLoreFragment,
  boss_script:    validateBossScript,
  quest_outline:  (raw) => raw.trim().length > 50 ? { ok: true } : { ok: false, reason: 'too short' },
  cosmetic_name:  (raw) => raw.trim().length > 2 && raw.trim().length < 60 ? { ok: true } : { ok: false, reason: 'bad length' },
  area_intro_text: validateAreaIntro,
};

async function postToGameServer(ingestUrl, ingestKey, chunk) {
  const headers = { 'content-type': 'application/json' };
  if (ingestKey) headers.authorization = `Bearer ${ingestKey}`;
  const res = await fetch(ingestUrl + '/api/s2/content', {
    method: 'POST',
    headers,
    body: JSON.stringify(chunk),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
  return res.json();
}

export const s2ValidatorAdapter = {
  kind: 'cli',
  capabilities: ['s2.validate'],

  async detect() {
    return true; // zero-dep; always available
  },

  async run(job, ctx) {
    const spec = typeof job.spec_json === 'string' ? JSON.parse(job.spec_json || '{}') : (job.spec_json || {});
    const s2Type    = spec.s2_type;
    const s2Area    = spec.s2_area;
    const seed      = spec.entropy_seed || '';
    const ingestUrl = (spec.ingest_url || '').replace(/\/$/, '');
    const raw       = (job.prompt || '').trim(); // inference output passed as prompt

    if (!raw) return { status: 'failed', error: 'empty inference output', confidence: 0 };
    if (!s2Type) return { status: 'failed', error: 'spec.s2_type missing', confidence: 0 };

    const validator = VALIDATORS[s2Type];
    if (!validator) return { status: 'failed', error: `unknown s2_type: ${s2Type}`, confidence: 0 };

    const result = validator(raw);
    ctx.log(`[s2-validate] type=${s2Type} area=${s2Area} ok=${result.ok}${result.reason ? ' reason=' + result.reason : ''}`);

    if (!result.ok) {
      return { status: 'completed', summary: `rejected: ${result.reason}`, output: JSON.stringify({ approved: false, reason: result.reason }), confidence: 0.9 };
    }

    const chunkId = `s2-${s2Type}-${s2Area}-${seed.slice(0, 8)}-${Date.now()}`;
    const chunk = { id: chunkId, type: s2Type, area: s2Area, payload_json: raw, entropy_seed: seed, status: 'approved' };

    if (ingestUrl) {
      try {
        await postToGameServer(ingestUrl, INGEST_KEY, chunk);
        ctx.log(`[s2-validate] ingested → ${ingestUrl}/api/s2/content`);
      } catch (err) {
        ctx.log(`[s2-validate] ingest failed: ${err.message}`);
        // Don't fail the job — log the chunk so it can be manually ingested
      }
    }

    return {
      status: 'completed',
      summary: `approved ${s2Type} for ${s2Area} (${raw.length} chars)`,
      output: JSON.stringify({ approved: true, chunk }),
      confidence: 0.9,
      artifacts: [{ kind: 'completion', inline: JSON.stringify(chunk, null, 2) }],
    };
  },
};
