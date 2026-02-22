/**
 * Agent Chat v2 — Config module
 * Load config, resolve key paths, default relay URL.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_RELAY_URL = 'https://agent-chat-relay.rynn-openclaw.workers.dev';

/**
 * Load config from a directory (reads config.json).
 * Throws on missing file, invalid JSON, or missing handle.
 */
export function loadConfig(configDir) {
  const configPath = join(configDir, 'config.json');
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  if (!config.handle) {
    throw new Error('Config missing required field: handle');
  }

  return {
    handle: config.handle,
    relay: config.relay || DEFAULT_RELAY_URL,
    pollIntervalMs: config.pollIntervalMs || 30000,
    ...config
  };
}

/**
 * Get file paths for Ed25519 and X25519 key pairs.
 */
export function getKeyPaths(configDir) {
  return {
    ed25519PublicKey: join(configDir, 'ed25519.pub'),
    ed25519PrivateKey: join(configDir, 'ed25519.priv'),
    x25519PublicKey: join(configDir, 'x25519.pub'),
    x25519PrivateKey: join(configDir, 'x25519.priv')
  };
}
