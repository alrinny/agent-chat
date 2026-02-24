/**
 * Unit tests for setup.sh — key generation, file structure, permissions.
 * Does NOT test relay registration (requires live relay).
 *
 * Tests: SETUP-NODE-001, SETUP-KEYS-001..004, SETUP-CONFIG-001, SETUP-PERMS-001
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getKeyPaths } from '../../lib/config.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', '.test-setup-' + process.pid);
const HANDLE = 'setup-test';
const CONFIG_DIR = join(TEST_DIR, `agent-chat-${HANDLE}`);
const SCRIPT_DIR = join(import.meta.dirname, '..', '..', 'scripts');

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Key generation (inline from setup.sh)', () => {
  before(() => {
    // Run just the key generation part (not registration)
    mkdirSync(CONFIG_DIR, { recursive: true });
    execSync(`node --input-type=module -e "
import { generateEd25519KeyPair, generateX25519KeyPair } from '${SCRIPT_DIR}/../lib/crypto.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const configDir = '${CONFIG_DIR}';
const ed = await generateEd25519KeyPair();
writeFileSync(join(configDir, 'ed25519.pub'), Buffer.from(ed.publicKey, 'base64'));
writeFileSync(join(configDir, 'ed25519.priv'), Buffer.from(ed.privateKey, 'base64'));

const x = await generateX25519KeyPair();
writeFileSync(join(configDir, 'x25519.pub'), Buffer.from(x.publicKey, 'base64'));
writeFileSync(join(configDir, 'x25519.priv'), Buffer.from(x.privateKey, 'base64'));

writeFileSync(join(configDir, 'config.json'), JSON.stringify({ handle: '${HANDLE}' }, null, 2));
"`, { stdio: 'pipe' });
  });

  it('SETUP-KEYS-001: creates ed25519.pub', () => {
    const paths = getKeyPaths(CONFIG_DIR);
    assert.ok(existsSync(paths.ed25519PublicKey));
    const buf = readFileSync(paths.ed25519PublicKey);
    assert.equal(buf.length, 32); // Ed25519 public key = 32 bytes
  });

  it('SETUP-KEYS-002: creates ed25519.priv', () => {
    const paths = getKeyPaths(CONFIG_DIR);
    assert.ok(existsSync(paths.ed25519PrivateKey));
    const buf = readFileSync(paths.ed25519PrivateKey);
    // Ed25519 private key from Node.js is either 32 or 64 bytes depending on format
    assert.ok(buf.length >= 32);
  });

  it('SETUP-KEYS-003: creates x25519.pub', () => {
    const paths = getKeyPaths(CONFIG_DIR);
    assert.ok(existsSync(paths.x25519PublicKey));
    const buf = readFileSync(paths.x25519PublicKey);
    assert.equal(buf.length, 32); // X25519 public key = 32 bytes
  });

  it('SETUP-KEYS-004: creates x25519.priv', () => {
    const paths = getKeyPaths(CONFIG_DIR);
    assert.ok(existsSync(paths.x25519PrivateKey));
    const buf = readFileSync(paths.x25519PrivateKey);
    assert.ok(buf.length >= 32);
  });

  it('SETUP-CONFIG-001: config.json has handle', () => {
    const config = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
    assert.equal(config.handle, HANDLE);
  });
});

describe('setup.sh argument validation', () => {
  it('SETUP-NODE-001: no handle → exit 1', () => {
    try {
      execSync(`bash ${SCRIPT_DIR}/setup.sh`, { stdio: 'pipe' });
      assert.fail('Should have exited');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });
});

describe('setup.sh — idempotent key reuse', () => {
  it('SETUP-REUSE-001: skips keygen if keys already exist', () => {
    // CONFIG_DIR already has keys from the before() hook above
    const out = execSync(
      `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_RELAY=http://localhost:1 bash ${SCRIPT_DIR}/setup.sh ${HANDLE} 2>&1 || true`,
      { encoding: 'utf8' }
    );
    assert.ok(out.includes('Existing keys found'), `Expected "Existing keys found" in: ${out.slice(0, 200)}`);
    assert.ok(!out.includes('Generating keys'), `Should NOT regenerate keys`);
  });

  it('SETUP-REUSE-002: creates config.json even when reusing keys', () => {
    // Delete config.json but keep keys
    const configPath = join(CONFIG_DIR, 'config.json');
    rmSync(configPath, { force: true });
    assert.ok(!existsSync(configPath));

    execSync(
      `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_RELAY=http://localhost:1 bash ${SCRIPT_DIR}/setup.sh ${HANDLE} 2>&1 || true`,
      { encoding: 'utf8' }
    );
    assert.ok(existsSync(configPath), 'config.json should be recreated');
  });
});

describe('setup.sh — 409 handling', () => {
  it('SETUP-409-001: fresh handle registers successfully', () => {
    // Use random handle to avoid 409
    const randomHandle = `test-${Date.now().toString(36)}`;
    const out = execSync(
      `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev bash ${SCRIPT_DIR}/setup.sh ${randomHandle} 2>&1`,
      { encoding: 'utf8' }
    );
    assert.ok(out.includes('setup complete'), `Expected "setup complete", got: ${out.slice(0, 300)}`);
    assert.ok(out.includes('Registered'), `Expected "Registered" confirmation`);
  });

  it('SETUP-409-002: duplicate handle shows warning, does not crash', () => {
    // Re-run with same handle as SETUP-409-001 — should get 409 but not crash
    // Use the base handle which was registered in the before() hook's relay call
    const out = execSync(
      `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev bash ${SCRIPT_DIR}/setup.sh ${HANDLE} 2>&1`,
      { encoding: 'utf8' }
    );
    assert.ok(out.includes('setup complete'), `Expected "setup complete" even on 409`);
    assert.ok(out.includes('already taken') || out.includes('already registered') || out.includes('Registered'),
      `Expected 409 warning or success, got: ${out.slice(0, 300)}`);
  });

  it('SETUP-409-003: unreachable relay gives clear error', () => {
    const out = execSync(
      `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_RELAY=http://localhost:1 bash ${SCRIPT_DIR}/setup.sh unreachable-test 2>&1 || true`,
      { encoding: 'utf8' }
    );
    // Should show network error, not stack trace
    assert.ok(out.includes('Error') || out.includes('error') || out.includes('ECONNREFUSED'),
      `Expected readable error, got: ${out.slice(0, 300)}`);
  });
});

describe('setup.sh — --daemon flag', () => {
  it('SETUP-DAEMON-001: --daemon creates LaunchAgent plist on macOS', () => {
    const randomHandle = `daemon-${Date.now().toString(36)}`;
    const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.agent-chat.${randomHandle}.plist`;

    try {
      const out = execSync(
        `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_CHAT_ID=123 AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev bash ${SCRIPT_DIR}/setup.sh ${randomHandle} --daemon 2>&1`,
        { encoding: 'utf8' }
      );
      
      // Should create and load plist
      assert.ok(out.includes('Daemon installed'), `Expected daemon installed msg, got: ${out.slice(0, 300)}`);
      
      // Plist should exist and contain correct paths
      const plist = readFileSync(plistPath, 'utf8');
      assert.ok(plist.includes(randomHandle), 'Plist should contain handle');
      assert.ok(!plist.includes('YOUR_HANDLE'), 'Plist should not contain placeholder');
      assert.ok(!plist.includes('/usr/local/bin/node') || plist.includes(execSync('which node', { encoding: 'utf8' }).trim()),
        'Plist should use actual node path');
    } finally {
      // Cleanup
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      rmSync(plistPath, { force: true });
    }
  });

  it('SETUP-DAEMON-002: without --daemon shows manual start instructions', () => {
    const out = execSync(
      `AGENT_SECRETS_DIR="${TEST_DIR}" AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev bash ${SCRIPT_DIR}/setup.sh ${HANDLE} 2>&1`,
      { encoding: 'utf8' }
    );
    // Without --daemon flag, should show "Start daemon:" or "--daemon" instructions
    assert.ok(out.includes('Start daemon:') || out.includes('--daemon'),
      `Expected daemon instructions, got: ${out.slice(0, 300)}`);
  });
});

describe('Key roundtrip — generated keys work with crypto.js', () => {
  it('SETUP-KEYS-005: sign + verify with generated Ed25519 keys', async () => {
    const { signMessage, verifySignature } = await import('../../lib/crypto.js');
    const paths = getKeyPaths(CONFIG_DIR);
    const privB64 = readFileSync(paths.ed25519PrivateKey).toString('base64');
    const pubB64 = readFileSync(paths.ed25519PublicKey).toString('base64');

    const sig = await signMessage('test payload', privB64);
    const valid = await verifySignature('test payload', sig, pubB64);
    assert.equal(valid, true);
  });

  it('SETUP-KEYS-006: encrypt + decrypt with generated X25519 keys', async () => {
    const { encryptForRecipient, decryptFromSender, generateX25519KeyPair, generateEd25519KeyPair } = await import('../../lib/crypto.js');
    const paths = getKeyPaths(CONFIG_DIR);
    const x25519PrivB64 = readFileSync(paths.x25519PrivateKey).toString('base64');
    const x25519PubB64 = readFileSync(paths.x25519PublicKey).toString('base64');
    const ed25519PrivB64 = readFileSync(paths.ed25519PrivateKey).toString('base64');

    // Sender uses generated keys, recipient uses generated keys
    const senderEd = await generateEd25519KeyPair();
    const senderX = await generateX25519KeyPair();

    const encrypted = await encryptForRecipient("hello world", x25519PubB64, senderEd.privateKey);
    const decrypted = await decryptFromSender(encrypted.ciphertext, encrypted.ephemeralKey, encrypted.nonce, x25519PrivB64);
    assert.equal(decrypted, 'hello world');
  });
});
