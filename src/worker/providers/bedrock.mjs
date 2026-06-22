// AWS Bedrock inference provider — the funded continuation/backstop (PLAN: paid, picks up
// where cheaper agents dropped off). Uses Bedrock's unified Converse API so one code path
// serves any model. Zero-dep: SigV4 is hand-rolled over global fetch (isolated to this file).
//
// Bedrock is NOT in ca-west-1; default region is us-east-1 (override MOLT_BEDROCK_REGION).
// Credentials come from the standard AWS env vars; the broker never sees them.

import { createHash, createHmac } from 'node:crypto';

const REGION = process.env.MOLT_BEDROCK_REGION || 'us-east-1';
const MODEL = process.env.MOLT_BEDROCK_MODEL || 'anthropic.claude-3-haiku-20240307-v1:0';
const MAX_TOKENS = Number(process.env.MOLT_BEDROCK_MAX_TOKENS || 2048);
const SERVICE = 'bedrock';
const HOST = `bedrock-runtime.${REGION}.amazonaws.com`;

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();

function creds() {
  return {
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN || null,
  };
}

// Minimal AWS Signature V4 for a POST with a JSON body and empty query string.
function signedHeaders(path, body, c) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const headers = {
    'content-type': 'application/json',
    host: HOST,
    'x-amz-date': amzDate,
  };
  if (c.sessionToken) headers['x-amz-security-token'] = c.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signed = names.join(';');

  const canonicalRequest = ['POST', path, '', canonicalHeaders, signed, payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${c.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    accept: 'application/json',
    authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

export const bedrockAdapter = {
  kind: 'provider',
  provider: 'bedrock',
  model: MODEL,
  trust: 'operator', // max-trust by construction: the funded backstop, exempt from redundant verify
  capabilities: ['inference'],

  async detect() {
    const c = creds();
    return !!(c.accessKey && c.secretKey);
  },

  async run(job, ctx) {
    const c = creds();
    if (!c.accessKey || !c.secretKey) return { status: 'failed', error: 'no AWS credentials', confidence: 0, provider: 'bedrock', model: MODEL };

    const prior = ctx.checkpoint?.partial || '';
    if (prior) ctx.log(`[bedrock:${MODEL}] resuming from ${prior.length} chars (continuation)`);
    else ctx.log(`[bedrock:${MODEL}] generating...`);

    const messages = [{ role: 'user', content: [{ text: job.prompt || job.title || '' }] }];
    if (prior) {
      messages.push({ role: 'assistant', content: [{ text: prior }] });
      messages.push({ role: 'user', content: [{ text: 'Continue exactly where you left off. Do not repeat anything.' }] });
    }
    const body = JSON.stringify({ messages, inferenceConfig: { maxTokens: MAX_TOKENS } });
    const path = `/model/${encodeURIComponent(MODEL)}/converse`;

    let res;
    try {
      res = await fetch(`https://${HOST}${path}`, {
        method: 'POST',
        headers: signedHeaders(path, body, c),
        body,
        signal: ctx.signal,
      });
    } catch (err) {
      return { status: 'failed', error: String(err?.message || err), confidence: 0, provider: 'bedrock', model: MODEL, partial: prior };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { status: 'failed', error: `bedrock HTTP ${res.status}: ${errText.slice(0, 300)}`, confidence: 0, provider: 'bedrock', model: MODEL, partial: prior };
    }

    const data = await res.json();
    const delta = data.output?.message?.content?.map((b) => b.text || '').join('') || '';
    const text = prior + delta;
    return {
      status: 'completed',
      summary: `[bedrock:${MODEL}] ${text.length} chars (in ${data.usage?.inputTokens ?? '?'} / out ${data.usage?.outputTokens ?? '?'} tok)`,
      output: text,
      confidence: 0.85,
      provider: 'bedrock',
      model: MODEL,
      usage: data.usage || null,
      artifacts: [{ kind: 'completion', inline: text }],
    };
  },
};
