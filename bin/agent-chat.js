#!/usr/bin/env node
// Thin wrapper — delegates to scripts/send.js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const script = join(dir, '..', 'scripts', 'send.js');

try {
  execFileSync('node', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
