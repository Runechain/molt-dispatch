// Tiny zero-dep process helpers shared by adapters and workspace.

import { spawn } from 'node:child_process';

// Is a binary on PATH?
export function which(bin) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

// Run a command, capturing stdout/stderr. Never rejects on non-zero exit — returns
// { code, stdout, stderr, timedOut }. Pass { input } to write to stdin.
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = opts.maxBuffer ?? 50 * 1024 * 1024;

    let timer;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > limit) child.kill('SIGKILL');
      if (opts.onStdout) opts.onStdout(d.toString());
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > limit) child.kill('SIGKILL');
      if (opts.onStderr) opts.onStderr(d.toString());
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input != null) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}
