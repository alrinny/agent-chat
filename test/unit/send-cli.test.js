/**
 * Unit tests for scripts/send.js — CLI argument parsing, key loading, relay communication.
 * Tests pure logic; relay calls are tested via integration tests.
 *
 * Tests: SEND-PARSE-001..006, SEND-KEYS-001..003, SEND-RELAY-001..004
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  generateEd25519KeyPair, generateX25519KeyPair, signMessage
} from '../../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../../lib/auth.js';
import { loadConfig, getKeyPaths } from '../../lib/config.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', '.test-send-' + process.pid);
const HANDLE = 'test-sender';
const CONFIG_DIR = join(TEST_DIR, `agent-chat-${HANDLE}`);
let keys;

before(async () => {
  mkdirSync(CONFIG_DIR, { recursive: true });

  // Generate keys
  const ed = await generateEd25519KeyPair();
  const x = await generateX25519KeyPair();
  keys = { ed, x };

  // Write keys to disk (raw bytes for pub, DER for priv)
  const keyPaths = getKeyPaths(CONFIG_DIR);
  writeFileSync(keyPaths.ed25519PublicKey, Buffer.from(ed.publicKey, 'base64'));
  writeFileSync(keyPaths.ed25519PrivateKey, Buffer.from(ed.privateKey, 'base64'));
  writeFileSync(keyPaths.x25519PublicKey, Buffer.from(x.publicKey, 'base64'));
  writeFileSync(keyPaths.x25519PrivateKey, Buffer.from(x.privateKey, 'base64'));

  // Write config
  writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({ handle: HANDLE }));
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Key loading from disk', () => {
  it('SEND-KEYS-001: reads Ed25519 public key from file', () => {
    const keyPaths = getKeyPaths(CONFIG_DIR);
    const pub = readFileSync(keyPaths.ed25519PublicKey).toString('base64');
    assert.equal(pub, keys.ed.publicKey);
  });

  it('SEND-KEYS-002: reads X25519 public key from file', () => {
    const keyPaths = getKeyPaths(CONFIG_DIR);
    const pub = readFileSync(keyPaths.x25519PublicKey).toString('base64');
    assert.equal(pub, keys.x.publicKey);
  });

  it('SEND-KEYS-003: config.json loads handle', () => {
    const config = loadConfig(CONFIG_DIR);
    assert.equal(config.handle, HANDLE);
  });
});

describe('Auth header generation', () => {
  it('SEND-RELAY-001: POST headers include all required fields', async () => {
    const body = '{"to":"bob"}';
    const headers = await buildPostHeaders(HANDLE, body, keys.ed.privateKey);
    assert.ok(headers['X-Agent-Handle']);
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
    assert.equal(headers['X-Agent-Handle'], HANDLE);
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('SEND-RELAY-002: GET headers include all required fields', async () => {
    const headers = await buildGetHeaders(HANDLE, '/handle/info/bob', keys.ed.privateKey);
    assert.ok(headers['X-Agent-Handle']);
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
  });

  it('SEND-RELAY-003: POST signature format is ts:body', async () => {
    const body = '{"test":true}';
    const headers = await buildPostHeaders(HANDLE, body, keys.ed.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    // Verify: signMessage(`${ts}:${body}`, privKey) should match sig
    const expectedSig = await signMessage(`${ts}:${body}`, keys.ed.privateKey);
    assert.equal(sig, expectedSig);
  });

  it('SEND-RELAY-004: GET signature format is GET:path:ts', async () => {
    const path = '/inbox/test-sender';
    const headers = await buildGetHeaders(HANDLE, path, keys.ed.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    const expectedSig = await signMessage(`GET:${path}:${ts}`, keys.ed.privateKey);
    assert.equal(sig, expectedSig);
  });
});

describe('CLI argument parsing', () => {
  it('SEND-PARSE-001: no command → exit code 1', () => {
    try {
      execSync(`node scripts/send.js`, {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-002: unknown command → exit code 1', () => {
    try {
      execSync(`node scripts/send.js badcommand`, {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-003: register without handle → exit code 1', () => {
    try {
      execSync(`node scripts/send.js register`, {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-004: send without args → exit code 1', () => {
    try {
      execSync(`node scripts/send.js send`, {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-005: status shows handle and relay', () => {
    const out = execSync(`node scripts/send.js status`, {
      env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes(`@${HANDLE}`));
    assert.ok(out.includes('Relay:'));
  });

  it('SEND-PARSE-006: handle-create without name → exit code 1', () => {
    try {
      execSync(`node scripts/send.js handle-create`, {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });
});

// Need readFileSync for key loading test
import { readFileSync } from 'node:fs';
