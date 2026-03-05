/**
 * Agent Chat v2 — Config module
 * Resolve data/keys directories, load config, resolve key paths.
 *
 * Directory layout:
 *   AGENT_CHAT_DIR (default: <workspace>/agent-chat/)
 *   ├── contacts.json, preferences.md, conversation-log.md
 *   ├── telegram.json (chatId, threadId)
 *   └── threads.json
 *
 *   AGENT_CHAT_KEYS_DIR (default: <AGENT_CHAT_DIR>/keys/)
 *   ├── <handle>/ (config.json, ed25519.pub/.priv, x25519.pub/.priv)
 *   └── telegram-token.json (botToken)
 *
 * Resolution:
 *   AGENT_CHAT_DIR → env or <workspace>/agent-chat/
 *   AGENT_CHAT_KEYS_DIR → env or <AGENT_CHAT_DIR>/keys/
 *   Workspace: AGENT_CHAT_WORKSPACE → ~/.openclaw/workspace (OpenClaw default)
 *
 * Backward compat: AGENT_SECRETS_DIR falls back to old ~/.openclaw/secrets/ layout.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export const DEFAULT_RELAY_URL = 'https://agent-chat-relay.rynn-openclaw.workers.dev';

/**
 * Resolve the workspace directory.
 * AGENT_CHAT_WORKSPACE → or detect from OpenClaw config → or ~/.openclaw/workspace
 */
function resolveWorkspace() {
  if (process.env.AGENT_CHAT_WORKSPACE) return process.env.AGENT_CHAT_WORKSPACE;

  // Try to detect from OpenClaw config
  const openclawConfig = join(process.env.HOME, '.openclaw', 'openclaw.json');
  if (existsSync(openclawConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(openclawConfig, 'utf8'));
      if (cfg.workspace) return cfg.workspace;
    } catch { /* ignore */ }
  }

  return join(process.env.HOME, '.openclaw', 'workspace');
}

/**
 * Resolve the agent-chat data directory.
 * AGENT_CHAT_DIR → or <workspace>/agent-chat/
 */
export function resolveDataDir() {
  if (process.env.AGENT_CHAT_DIR) {
    return isAbsolute(process.env.AGENT_CHAT_DIR)
      ? process.env.AGENT_CHAT_DIR
      : join(resolveWorkspace(), process.env.AGENT_CHAT_DIR);
  }
  return join(resolveWorkspace(), 'agent-chat');
}

/**
 * Resolve the keys directory.
 * AGENT_CHAT_KEYS_DIR → or AGENT_SECRETS_DIR (backward compat) → or <dataDir>/keys/
 */
export function resolveKeysDir() {
  if (process.env.AGENT_CHAT_KEYS_DIR) {
    return isAbsolute(process.env.AGENT_CHAT_KEYS_DIR)
      ? process.env.AGENT_CHAT_KEYS_DIR
      : join(resolveDataDir(), process.env.AGENT_CHAT_KEYS_DIR);
  }

  // Backward compat: AGENT_SECRETS_DIR maps to old layout
  if (process.env.AGENT_SECRETS_DIR) {
    return process.env.AGENT_SECRETS_DIR;
  }

  // Check old default location for backward compat
  const oldDefault = join(process.env.HOME, '.openclaw', 'secrets');
  const newDefault = join(resolveDataDir(), 'keys');
  if (!existsSync(newDefault) && existsSync(oldDefault)) {
    return oldDefault;
  }

  return newDefault;
}

/**
 * Resolve the handle's key directory (keys/<handle>/).
 * Backward compat: old layout was <secrets>/agent-chat-<handle>/
 */
export function resolveHandleDir(handle) {
  const keysDir = resolveKeysDir();
  const newPath = join(keysDir, handle);
  const oldPath = join(keysDir, `agent-chat-${handle}`);

  if (existsSync(newPath)) return newPath;
  if (existsSync(oldPath)) return oldPath;

  // Default to new layout for fresh installs
  return newPath;
}

/**
 * Load config from a handle's key directory (reads config.json).
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
    ...config,
    handle: config.handle,
    relay: config.relay || DEFAULT_RELAY_URL,
    pollIntervalMs: config.pollIntervalMs || 30000,
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
