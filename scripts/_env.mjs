// Test bootstrap: isolate state in a temp data dir + a free-ish port BEFORE any module
// reads config. Imported first by the verify_* scripts so `npm test` needs no env setup.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.MOLT_DATA_DIR) process.env.MOLT_DATA_DIR = mkdtempSync(join(tmpdir(), 'molt-test-'));
if (!process.env.MOLT_PORT) process.env.MOLT_PORT = String(7100 + Math.floor(Math.random() * 800));
