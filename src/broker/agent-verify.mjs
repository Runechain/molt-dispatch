// Broker relying-party check for the agent claim flow. The broker does NOT hold identity — it asks
// the RUNECHAIN game (the identity authority) whether a signed worker request comes from an agent
// keypair that a human has claimed against their account. Returns the bound game accountId, which the
// broker uses as the worker's owner so reputation/stake accrue at the ACCOUNT level, not the keypair.

import { GAME } from '../shared/config.mjs';

// agent = { agentPubkey, message, signature } produced by the worker's buildAuth().
export async function verifyAgentClaim(agent, opts = {}) {
  if (!agent || !agent.agentPubkey || !agent.message || !agent.signature) {
    return { ok: false, error: 'agent_credential_missing' };
  }
  const now = opts.now || Date.now();
  const maxAgeMs = opts.maxAgeMs || 5 * 60 * 1000;
  // Freshness: the broker bounds replay by checking the signed `issued` timestamp itself (the game
  // only attests sig + binding; it has no clock context for this request).
  const m = /\nissued=(\d+)/.exec(String(agent.message));
  const issued = m ? Number(m[1]) : 0;
  if (!issued || Math.abs(now - issued) > maxAgeMs) return { ok: false, error: 'agent_auth_stale' };

  const gameUrl = (opts.gameUrl || GAME.url).replace(/\/$/, '');
  const f = opts.fetch || fetch;
  let body = {};
  try {
    const res = await f(`${gameUrl}/claim/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPubkey: agent.agentPubkey, message: agent.message, signature: agent.signature }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.code || 'agent_not_verified' };
  } catch (err) {
    return { ok: false, error: 'identity_authority_unreachable', detail: String(err && err.message || err) };
  }
  if (body && body.ok && body.accountId) return { ok: true, accountId: body.accountId, agentAddress: body.agentAddress };
  return { ok: false, error: (body && body.code) || 'agent_not_verified' };
}
