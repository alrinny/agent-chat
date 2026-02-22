#!/usr/bin/env node
// Thin wrapper — delegates to scripts/setup.sh
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const script = join(dir, '..', 'scripts', 'setup.sh');

try {
  execFileSync('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
