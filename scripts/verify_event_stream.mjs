// Live event stream (SSE) verification. Proves `GET /events/stream` opens a Server-Sent-Events
// connection, sends a hello frame, and pushes events AS THEY HAPPEN (the `molt logs` tail) — so the
// operator can watch the grid live instead of polling.
//
//   MOLT_DATA_DIR=$(mktemp -d) MOLT_PORT=7103 node scripts/verify_event_stream.mjs

import './_env.mjs'; // must be first: sets MOLT_DATA_DIR/MOLT_PORT before config is read
import assert from 'node:assert/strict';
import { startBroker } from '../src/broker/server.mjs';
import { BROKER } from '../src/shared/config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (l) => { n++; console.log('ok  ' + l); };

try {
  startBroker();
  let up = false;
  for (let i = 0; i < 30; i++) { try { if ((await fetch(`${BROKER.url}/health`)).ok) { up = true; break; } } catch { /* not yet */ } await sleep(100); }
  if (!up) throw new Error('broker did not come up');

  // 1. open the SSE stream
  const res = await fetch(`${BROKER.url}/events/stream`, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 200, 'stream returns 200');
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/, 'content-type is text/event-stream');
  assert.ok(res.body, 'stream has a readable body');
  ok('GET /events/stream opens an SSE connection');

  // read frames in the background
  const received = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try { received.push(JSON.parse(line.slice(5).trim())); } catch { /* comment/keepalive */ }
      }
    }
  })().catch(() => {});

  // 2. hello frame on connect
  let hello = false;
  for (let i = 0; i < 20; i++) { if (received.some((e) => e.ok === true)) { hello = true; break; } await sleep(50); }
  assert.ok(hello, 'hello frame received on connect');
  ok('stream sends a hello frame on connect');

  // 3. an event fired AFTER connecting arrives live on the stream
  const before = received.length;
  await fetch(`${BROKER.url}/objectives`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'stream test', prompt: 'hi', contract: { objective_type: 'inference' } }),
  });
  let live = false;
  for (let i = 0; i < 40; i++) {
    if (received.slice(before).some((e) => e.event_type && (e.entity_type === 'objective' || e.entity_type === 'job'))) { live = true; break; }
    await sleep(100);
  }
  assert.ok(live, 'creating an objective streamed its events live (created/planned)');
  ok('events stream AS THEY HAPPEN (not just on poll)');

  reader.cancel().catch(() => {});
  console.log(`\nEvent stream verification passed (${n} checks).`);
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
}
