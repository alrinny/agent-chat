/**
 * Unit tests for lib/config.js — config loading and key paths.
 *
 * Tests: CONFIG-001..010
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, getKeyPaths, DEFAULT_RELAY_URL } from '../../lib/config.js';

const TEST_DIR = join(tmpdir(), 'agent-chat-test-' + Date.now());

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadConfig', () => {
  // CONFIG-001
  it('reads valid config.json', () => {
    const configDir = join(TEST_DIR, 'valid');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      handle: 'testbot',
      relay: 'https://relay.example.com'
    }));
    const config = loadConfig(configDir);
    assert.equal(config.handle, 'testbot');
    assert.equal(config.relay, 'https://relay.example.com');
  });

  // CONFIG-002
  it('missing config → throws', () => {
    assert.throws(() => loadConfig(join(TEST_DIR, 'nonexistent')));
  });

  // CONFIG-003
  it('invalid JSON → throws', () => {
    const configDir = join(TEST_DIR, 'badjson');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), 'not json');
    assert.throws(() => loadConfig(configDir));
  });

  // CONFIG-004
  it('missing handle → throws', () => {
    const configDir = join(TEST_DIR, 'nohandle');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ relay: 'https://x.com' }));
    assert.throws(() => loadConfig(configDir));
  });

  // CONFIG-005
  it('default relay URL when not specified', () => {
    const configDir = join(TEST_DIR, 'defaultrelay');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ handle: 'bot' }));
    const config = loadConfig(configDir);
    assert.equal(config.relay, DEFAULT_RELAY_URL);
  });

  // CONFIG-006
  it('all optional fields have defaults', () => {
    const configDir = join(TEST_DIR, 'defaults');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ handle: 'bot' }));
    const config = loadConfig(configDir);
    assert.ok(config.relay);
    assert.ok(typeof config.pollIntervalMs === 'number');
  });
});

describe('getKeyPaths', () => {
  // CONFIG-007
  it('returns ed25519 and x25519 paths', () => {
    const paths = getKeyPaths(TEST_DIR);
    assert.ok(paths.ed25519PublicKey.includes('ed25519'));
    assert.ok(paths.ed25519PrivateKey.includes('ed25519'));
    assert.ok(paths.x25519PublicKey.includes('x25519'));
    assert.ok(paths.x25519PrivateKey.includes('x25519'));
  });

  // CONFIG-008
  it('all paths are under config dir', () => {
    const paths = getKeyPaths(TEST_DIR);
    for (const p of Object.values(paths)) {
      assert.ok(p.startsWith(TEST_DIR), `${p} should start with ${TEST_DIR}`);
    }
  });

  // CONFIG-009
  it('public and private keys are separate files', () => {
    const paths = getKeyPaths(TEST_DIR);
    assert.notEqual(paths.ed25519PublicKey, paths.ed25519PrivateKey);
    assert.notEqual(paths.x25519PublicKey, paths.x25519PrivateKey);
  });
});

describe('DEFAULT_RELAY_URL', () => {
  // CONFIG-010
  it('is a valid HTTPS URL', () => {
    assert.ok(DEFAULT_RELAY_URL.startsWith('https://'));
  });
});

describe('loadConfig spread order', () => {
  // AUDIT-5: spread must not override defaults
  it('relay defaults to DEFAULT_RELAY_URL when not in config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-spread-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ handle: 'test' }));
    const config = loadConfig(dir);
    assert.strictEqual(config.relay, DEFAULT_RELAY_URL);
    rmSync(dir, { recursive: true });
  });

  it('relay=null in config still gets default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-null-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ handle: 'test', relay: null }));
    const config = loadConfig(dir);
    assert.strictEqual(config.relay, DEFAULT_RELAY_URL);
    rmSync(dir, { recursive: true });
  });

  it('custom relay is preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-custom-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ handle: 'test', relay: 'https://custom.relay' }));
    const config = loadConfig(dir);
    assert.strictEqual(config.relay, 'https://custom.relay');
    rmSync(dir, { recursive: true });
  });

  it('extra config fields are preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-extra-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ handle: 'test', myCustom: 'value' }));
    const config = loadConfig(dir);
    assert.strictEqual(config.myCustom, 'value');
    assert.strictEqual(config.relay, DEFAULT_RELAY_URL);
    rmSync(dir, { recursive: true });
  });
});
