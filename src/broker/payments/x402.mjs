// x402 helpers: build 402 payment requirements, verify and settle via the Coinbase Solana
// facilitator (https://x402.org/facilitator). All outbound HTTP calls are gated behind
// MOLT_FUEL_REAL=1 — with it off, verify returns {isValid:true,simulated:true} and settle
// is a no-op. This preserves the zero-real-spend guarantee during local commissioning.
//
// x402 open protocol (Coinbase, 2025): client receives 402 + requirements JSON, pays USDC
// on-chain (Solana/Base/etc.), retries with X-PAYMENT header containing the proof, server
// verifies via facilitator, processes the request, then calls settle to finalize.

import https from 'node:https';
import { FUEL } from '../../shared/config.mjs';

const FACILITATOR_HOST = 'x402.org';

// Build the 402 payment requirement body. Returned in the response when payment is needed.
// amountUSDCMicro: amount in USDC micro-units (1 USDC = 1,000,000 micro; 1 cent = 10,000 micro).
export function buildPaymentRequirement({ amountUSDCMicro, payTo, resource, description, network = 'solana-mainnet' }) {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header required',
    accepts: [
      {
        scheme: 'exact',
        network,
        maxAmountRequired: String(amountUSDCMicro),
        resource,
        description,
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 300,
        asset: 'USDC',
        extra: { name: 'USD Coin', decimals: 6 },
      },
    ],
  };
}

// POST to the Coinbase x402 facilitator.
function facilitatorPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: FACILITATOR_HOST,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve({ error: 'invalid facilitator response' });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Verify that a payment header satisfies the requirements.
// Returns { isValid: bool, invalidReason?: string } — or simulated result when MOLT_FUEL_REAL=0.
export async function verifyPayment(paymentHeader, paymentRequirements) {
  if (!FUEL.real) return { isValid: true, simulated: true };
  return facilitatorPost('/facilitator/verify', { paymentHeader, paymentRequirements });
}

// Settle a verified payment (finalizes the on-chain transaction).
// Returns { success: bool, txid?: string } — or simulated when MOLT_FUEL_REAL=0.
export async function settlePayment(paymentHeader, paymentRequirements) {
  if (!FUEL.real) return { success: true, simulated: true };
  return facilitatorPost('/facilitator/settle', { paymentHeader, paymentRequirements });
}

// Extract the X-PAYMENT header from a Node.js IncomingMessage.
export function extractPaymentHeader(req) {
  return req.headers['x-payment'] || req.headers['x-payment-response'] || null;
}

// Convert cents to USDC micro-units (100 cents = 1 USDC = 1,000,000 micro).
export function centsToMicro(cents) {
  return cents * 10000;
}
