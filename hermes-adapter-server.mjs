// Hermes adapter HTTP server — holds connections open until the user responds.
// The molt-dispatch worker adapter POSTs to /run and blocks until we respond.
// We see the job in the terminal, process it, then POST the result to /respond/<job_id>.
//
// Port: MOLT_HERMES_PORT (default 18997)

import { createServer } from 'node:http';

const PORT = Number(process.env.MOLT_HERMES_PORT || 18997);

// Active job: the worker's HTTP request is pending, awaiting our response.
let pendingResponse = null; // { job_id, title, type, prompt, spec, repo, checkpoint, resolve, reject }
const TIMEOUT_MS = 600_000; // 10 min timeout

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : null;
      await handle(url, method, data, res);
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });
});

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handle(url, method, data, res) {
  const path = url.pathname;

  // Health check
  if (path === '/health') {
    json(res, 200, {
      ok: true,
      job_pending: pendingResponse?.job_id || null,
      job_title: pendingResponse?.title || null,
    });
    return;
  }

  // Status of current/queued jobs
  if (path === '/status') {
    json(res, 200, {
      pending: pendingResponse ? {
        job_id: pendingResponse.job_id,
        title: pendingResponse.title,
        type: pendingResponse.type,
        capability: pendingResponse.capability,
        repo: pendingResponse.repo,
        branch: pendingResponse.branch,
        prompt: pendingResponse.prompt?.slice(0, 500),
        spec: pendingResponse.spec,
        checkpoint: pendingResponse.checkpoint,
      } : null,
    });
    return;
  }

  // Worker adapter POSTs the job here and blocks until we respond
  if (path === '/run') {
    if (!data || !data.job_id) {
      json(res, 400, { error: 'missing job_id' });
      return;
    }
    if (pendingResponse) {
      // We can only handle one job at a time (single slot).
      // Worker should set max-slots 1 when using hermes adapter.
      json(res, 429, {
        error: 'busy with another job',
        current_job: pendingResponse.job_id,
      });
      return;
    }

    // Accept the job — hold the connection open
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   NEW JOB FROM MOLT WORKER              ║`);
    console.log(`╠══════════════════════════════════════════╣`);
    console.log(`║  Job:     ${(data.job_id || '').padEnd(32)}║`);
    console.log(`║  Title:   ${(data.title || '').padEnd(32)}║`);
    console.log(`║  Type:    ${((data.type || '') + '  cap: ' + (data.capability || '')).padEnd(32)}║`);
    console.log(`║  Repo:    ${(data.repo || 'none').padEnd(32)}║`);
    console.log(`║  Branch:  ${(data.branch || 'none').padEnd(32)}║`);
    console.log(`║  Trust:   ${(String(data.trust_required ?? '?')).padEnd(32)}║`);
    console.log(`╚══════════════════════════════════════════╝`);
    if (data.spec) console.log('\nSpec:', JSON.stringify(data.spec, null, 2).slice(0, 1500));
    if (data.prompt) console.log('\nPrompt:', data.prompt.slice(0, 3000));
    if (data.checkpoint) console.log('\nCheckpoint (resuming):', JSON.stringify(data.checkpoint).slice(0, 1000));
    console.log(`\n────────────────────────────────────────────`);
    console.log(`Process this job, then POST back:`);
    console.log(`  curl -X POST http://127.0.0.1:${PORT}/respond/${data.job_id} \\`);
    console.log(`    -H 'content-type: application/json' \\`);
    console.log(`    -d '{"status":"completed","summary":"did the thing","output":"..."}'`);
    console.log(`────────────────────────────────────────────\n`);

    // Hold the connection — resolve/reject will unblock it
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingResponse === jobInfo) {
          pendingResponse = null;
          reject(new Error('timeout'));
        }
      }, TIMEOUT_MS);

      const jobInfo = {
        ...data,
        resolve: (val) => {
          clearTimeout(timer);
          pendingResponse = null;
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          pendingResponse = null;
          reject(err);
        },
      };
      pendingResponse = jobInfo;
    });

    json(res, 200, result);
    return;
  }

  // User responds with the result — unblocks the worker's HTTP call
  const respondMatch = path.match(/^\/respond\/(.+)$/);
  if (respondMatch) {
    const jobId = respondMatch[1];
    if (!data) { json(res, 400, { error: 'missing response body' }); return; }

    if (!pendingResponse) {
      json(res, 404, { error: 'no pending job' });
      return;
    }
    if (pendingResponse.job_id !== jobId) {
      json(res, 409, {
        error: `job_id mismatch: pending=${pendingResponse.job_id}, got=${jobId}`,
      });
      return;
    }

    console.log(`\n=== RESPONSE RECEIVED for ${jobId} ===`);
    console.log(`Status: ${data.status}`);
    console.log(`Summary: ${data.summary || '(none)'}`);
    console.log(`===============================\n`);

    pendingResponse.resolve(data);
    json(res, 200, { ok: true, message: 'response accepted, worker will proceed' });
    return;
  }

  // Checkpoint update (adapter calls this to persist partial progress)
  const cpMatch = path.match(/^\/checkpoint\/(.+)$/);
  if (cpMatch) {
    const jobId = cpMatch[1];
    json(res, 200, { ok: true, checkpoint_saved: true });
    console.log(`[hermes-server] checkpoint saved for ${jobId}`);
    return;
  }

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║   Hermes Adapter Server (long-poll mode)        ║`);
  console.log(`║   Port: ${String(PORT).padEnd(41)}║`);
  console.log(`║   URL:  http://127.0.0.1:${String(PORT).padEnd(23)}║`);
  console.log(`║                                                ║`);
  console.log(`║   Flow:                                         ║`);
  console.log(`║   1. Worker POSTs job → server holds connection ║`);
  console.log(`║   2. Job appears in the Hermes session          ║`);
  console.log(`║   3. User processes it here                     ║`);
  console.log(`║   4. User POSTs result → worker unblocks        ║`);
  console.log(`╚══════════════════════════════════════════════════╝`);
  console.log(`\nReady. Start the worker with --adapters hermes\n`);
});
