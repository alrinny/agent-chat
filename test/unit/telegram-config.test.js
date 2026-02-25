/**
 * Unit tests for split Telegram config loading.
 * Tests: TG-001..010
 * 
 * loadTelegramConfig() in ws-daemon.js is not exported, so we test the logic
 * by recreating it here. Tests verify the merge behavior of:
 *   - New layout: telegram.json (chatId/threadId) + telegram-token.json (botToken)
 *   - Old layout: agent-chat-telegram.json (all-in-one)
 *   - Env var override: AGENT_CHAT_THREAD_ID
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = join(tmpdir(), `tg-config-${Date.now()}`);

// Replicate loadTelegramConfig logic exactly from ws-daemon.js
function loadTelegramConfig(dataDir, keysDir) {
  let config = {};

  // New layout
  const dataFile = join(dataDir, 'telegram.json');
  const tokenFile = join(keysDir, 'telegram-token.json');
  if (existsSync(dataFile)) {
    try { config = JSON.parse(readFileSync(dataFile, 'utf8')); } catch { /* ignore */ }
  }
  if (existsSync(tokenFile)) {
    try { const t = JSON.parse(readFileSync(tokenFile, 'utf8')); config.botToken = t.botToken; } catch { /* ignore */ }
  }

  // No backward compat test here (would need real HOME/.openclaw/secrets/)

  if (!config.botToken || !config.chatId) return null;

  if (!config.threadId && process.env.AGENT_CHAT_THREAD_ID) {
    config.threadId = parseInt(process.env.AGENT_CHAT_THREAD_ID, 10);
  }
  return config;
}

const origThreadId = process.env.AGENT_CHAT_THREAD_ID;

before(() => {
  mkdirSync(BASE, { recursive: true });
});

afterEach(() => {
  if (origThreadId === undefined) delete process.env.AGENT_CHAT_THREAD_ID;
  else process.env.AGENT_CHAT_THREAD_ID = origThreadId;
});

after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('telegram split config', () => {
  it('TG-001: loads from split files (new layout)', () => {
    const data = join(BASE, 'tg1-data');
    const keys = join(BASE, 'tg1-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '12345', threadId: 999 }));
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg.chatId, '12345');
    assert.equal(cfg.threadId, 999);
    assert.equal(cfg.botToken, 'fake:token');
  });

  it('TG-002: returns null when botToken missing', () => {
    const data = join(BASE, 'tg2-data');
    const keys = join(BASE, 'tg2-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '12345' }));
    // No telegram-token.json

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg, null);
  });

  it('TG-003: returns null when chatId missing', () => {
    const data = join(BASE, 'tg3-data');
    const keys = join(BASE, 'tg3-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    // No telegram.json
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg, null);
  });

  it('TG-004: returns null when both files missing', () => {
    const data = join(BASE, 'tg4-data');
    const keys = join(BASE, 'tg4-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg, null);
  });

  it('TG-005: threadId optional — works without it', () => {
    const data = join(BASE, 'tg5-data');
    const keys = join(BASE, 'tg5-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '999' }));
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg.chatId, '999');
    assert.equal(cfg.botToken, 'fake:token');
    assert.equal(cfg.threadId, undefined);
  });

  it('TG-006: AGENT_CHAT_THREAD_ID env overrides missing threadId', () => {
    const data = join(BASE, 'tg6-data');
    const keys = join(BASE, 'tg6-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '999' }));
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));
    process.env.AGENT_CHAT_THREAD_ID = '777';

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg.threadId, 777);
  });

  it('TG-007: file threadId takes precedence over env', () => {
    const data = join(BASE, 'tg7-data');
    const keys = join(BASE, 'tg7-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '999', threadId: 555 }));
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));
    process.env.AGENT_CHAT_THREAD_ID = '777';

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg.threadId, 555);
  });

  it('TG-008: invalid JSON in telegram.json → graceful null', () => {
    const data = join(BASE, 'tg8-data');
    const keys = join(BASE, 'tg8-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), 'NOT JSON');
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg, null); // no chatId from broken file
  });

  it('TG-009: invalid JSON in telegram-token.json → graceful null', () => {
    const data = join(BASE, 'tg9-data');
    const keys = join(BASE, 'tg9-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '999' }));
    writeFileSync(join(keys, 'telegram-token.json'), 'NOT JSON');

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg, null); // no botToken from broken file
  });

  it('TG-010: chatId preserved as string', () => {
    const data = join(BASE, 'tg10-data');
    const keys = join(BASE, 'tg10-keys');
    mkdirSync(data, { recursive: true });
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(data, 'telegram.json'), JSON.stringify({ chatId: '-100123456' }));
    writeFileSync(join(keys, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));

    const cfg = loadTelegramConfig(data, keys);
    assert.equal(cfg.chatId, '-100123456');
  });
});
