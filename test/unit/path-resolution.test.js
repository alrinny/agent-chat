/**
 * Unit tests for directory layout resolution (config.js + contacts.js).
 * Tests: PATH-001..020
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDataDir, resolveKeysDir, resolveHandleDir } from '../../lib/config.js';
import { loadContacts, saveContacts, addContact } from '../../lib/contacts.js';

const BASE = join(tmpdir(), `path-res-${Date.now()}`);

// Save original env
const origEnv = {};
const ENV_KEYS = ['AGENT_CHAT_DIR', 'AGENT_CHAT_KEYS_DIR', 'AGENT_CHAT_WORKSPACE',
                  'AGENT_SECRETS_DIR', 'AGENT_CHAT_CONTACTS'];

function saveEnv() {
  for (const k of ENV_KEYS) origEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
}
function setEnv(overrides) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
}

before(() => {
  saveEnv();
  mkdirSync(BASE, { recursive: true });
});

afterEach(() => {
  restoreEnv();
});

after(() => {
  restoreEnv();
  rmSync(BASE, { recursive: true, force: true });
});

describe('resolveDataDir', () => {
  it('PATH-001: uses AGENT_CHAT_DIR when set (absolute)', () => {
    const dir = join(BASE, 'custom-data');
    setEnv({ AGENT_CHAT_DIR: dir });
    assert.equal(resolveDataDir(), dir);
  });

  it('PATH-002: uses AGENT_CHAT_DIR relative to workspace', () => {
    const ws = join(BASE, 'ws-rel');
    mkdirSync(ws, { recursive: true });
    setEnv({ AGENT_CHAT_DIR: 'my-chat', AGENT_CHAT_WORKSPACE: ws });
    assert.equal(resolveDataDir(), join(ws, 'my-chat'));
  });

  it('PATH-003: defaults to <workspace>/agent-chat/', () => {
    const ws = join(BASE, 'ws-default');
    mkdirSync(ws, { recursive: true });
    setEnv({ AGENT_CHAT_WORKSPACE: ws });
    assert.equal(resolveDataDir(), join(ws, 'agent-chat'));
  });
});

describe('resolveKeysDir', () => {
  it('PATH-004: uses AGENT_CHAT_KEYS_DIR when set (absolute)', () => {
    const dir = join(BASE, 'custom-keys');
    setEnv({ AGENT_CHAT_KEYS_DIR: dir });
    assert.equal(resolveKeysDir(), dir);
  });

  it('PATH-005: uses AGENT_CHAT_KEYS_DIR relative to data dir', () => {
    const dataDir = join(BASE, 'data-for-rel-keys');
    mkdirSync(dataDir, { recursive: true });
    setEnv({ AGENT_CHAT_DIR: dataDir, AGENT_CHAT_KEYS_DIR: 'my-keys' });
    assert.equal(resolveKeysDir(), join(dataDir, 'my-keys'));
  });

  it('PATH-006: defaults to <dataDir>/keys/', () => {
    const dataDir = join(BASE, 'data-default-keys');
    const keysDir = join(dataDir, 'keys');
    mkdirSync(keysDir, { recursive: true });
    setEnv({ AGENT_CHAT_DIR: dataDir });
    assert.equal(resolveKeysDir(), keysDir);
  });

  it('PATH-007: backward compat — AGENT_SECRETS_DIR used as fallback', () => {
    const oldDir = join(BASE, 'old-secrets');
    mkdirSync(oldDir, { recursive: true });
    setEnv({ AGENT_SECRETS_DIR: oldDir, AGENT_CHAT_DIR: join(BASE, 'no-keys-here') });
    assert.equal(resolveKeysDir(), oldDir);
  });
});

describe('resolveHandleDir', () => {
  it('PATH-008: new layout — keys/<handle>/', () => {
    const keysDir = join(BASE, 'keys-new');
    const handleDir = join(keysDir, 'alice');
    mkdirSync(handleDir, { recursive: true });
    setEnv({ AGENT_CHAT_KEYS_DIR: keysDir });
    assert.equal(resolveHandleDir('alice'), handleDir);
  });

  it('PATH-009: old layout — keys/agent-chat-<handle>/', () => {
    const keysDir = join(BASE, 'keys-old');
    const oldDir = join(keysDir, 'agent-chat-bob');
    mkdirSync(oldDir, { recursive: true });
    setEnv({ AGENT_CHAT_KEYS_DIR: keysDir });
    assert.equal(resolveHandleDir('bob'), oldDir);
  });

  it('PATH-010: prefers new layout over old', () => {
    const keysDir = join(BASE, 'keys-both');
    mkdirSync(join(keysDir, 'charlie'), { recursive: true });
    mkdirSync(join(keysDir, 'agent-chat-charlie'), { recursive: true });
    setEnv({ AGENT_CHAT_KEYS_DIR: keysDir });
    assert.equal(resolveHandleDir('charlie'), join(keysDir, 'charlie'));
  });

  it('PATH-011: neither exists — returns new layout path', () => {
    const keysDir = join(BASE, 'keys-empty-hd');
    mkdirSync(keysDir, { recursive: true });
    setEnv({ AGENT_CHAT_KEYS_DIR: keysDir });
    assert.equal(resolveHandleDir('dave'), join(keysDir, 'dave'));
  });
});

describe('contacts from workspace', () => {
  it('PATH-012: loadContacts(null) reads from resolved data dir', () => {
    const dataDir = join(BASE, 'contacts-ws');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'contacts.json'), JSON.stringify({ eve: { label: 'Eve' } }));
    setEnv({ AGENT_CHAT_DIR: dataDir });
    const contacts = loadContacts(null);
    assert.equal(contacts.eve.label, 'Eve');
  });

  it('PATH-013: loadContacts(null) returns empty when no file', () => {
    const dataDir = join(BASE, 'contacts-empty');
    mkdirSync(dataDir, { recursive: true });
    setEnv({ AGENT_CHAT_DIR: dataDir });
    const contacts = loadContacts(null);
    assert.deepStrictEqual(contacts, {});
  });

  it('PATH-014: saveContacts(null) creates file in data dir', () => {
    const dataDir = join(BASE, 'contacts-save');
    mkdirSync(dataDir, { recursive: true });
    setEnv({ AGENT_CHAT_DIR: dataDir });
    saveContacts(null, { frank: { label: 'Frank', topics: ['AI'] } });
    assert.ok(existsSync(join(dataDir, 'contacts.json')));
    const loaded = loadContacts(null);
    assert.equal(loaded.frank.label, 'Frank');
  });

  it('PATH-015: loadContacts with explicit dir still works', () => {
    const dir = join(BASE, 'contacts-explicit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'contacts.json'), JSON.stringify({ grace: { label: 'Grace' } }));
    setEnv({ AGENT_CHAT_DIR: join(BASE, 'other') });
    const contacts = loadContacts(dir);
    assert.equal(contacts.grace.label, 'Grace');
  });

  it('PATH-016: loadContacts with .json path works', () => {
    const file = join(BASE, 'direct-contacts.json');
    writeFileSync(file, JSON.stringify({ hank: { label: 'Hank' } }));
    const contacts = loadContacts(file);
    assert.equal(contacts.hank.label, 'Hank');
  });

  it('PATH-017: addContact(null) writes to workspace', () => {
    const dataDir = join(BASE, 'contacts-add-ws');
    mkdirSync(dataDir, { recursive: true });
    setEnv({ AGENT_CHAT_DIR: dataDir });
    addContact(null, 'ivan', 'Ivan');
    const contacts = loadContacts(null);
    assert.equal(contacts.ivan.label, 'Ivan');
  });

  it('PATH-018: addContact preserves existing fields', () => {
    const dataDir = join(BASE, 'contacts-preserve');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'contacts.json'), JSON.stringify({
      judy: { label: 'Judy', topics: ['ML'], autoForward: ['news'] }
    }));
    setEnv({ AGENT_CHAT_DIR: dataDir });
    addContact(null, 'judy', 'Judy Updated', 'new notes');
    const loaded = loadContacts(null);
    assert.equal(loaded.judy.label, 'Judy Updated');
    assert.equal(loaded.judy.notes, 'new notes');
    assert.deepStrictEqual(loaded.judy.topics, ['ML']);
    assert.deepStrictEqual(loaded.judy.autoForward, ['news']);
  });

  it('PATH-019: AGENT_CHAT_CONTACTS env var overrides location', () => {
    const customPath = join(BASE, 'custom-contacts.json');
    writeFileSync(customPath, JSON.stringify({ karl: { label: 'Karl' } }));
    setEnv({ AGENT_CHAT_CONTACTS: customPath });
    const contacts = loadContacts(null);
    assert.equal(contacts.karl.label, 'Karl');
  });

  it('PATH-020: saveContacts creates parent dirs if missing', () => {
    const dataDir = join(BASE, 'deep', 'nested', 'contacts');
    setEnv({ AGENT_CHAT_DIR: dataDir });
    saveContacts(null, { leo: { label: 'Leo' } });
    assert.ok(existsSync(join(dataDir, 'contacts.json')));
  });
});
