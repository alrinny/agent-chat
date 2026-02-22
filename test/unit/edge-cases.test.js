/**
 * Edge case tests — crypto, auth, CLI error handling.
 * Covers gaps found in deep audit #2.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  generateEd25519KeyPair, generateX25519KeyPair,
  signMessage, verifySignature,
  encryptForRecipient, decryptFromSender,
  bufferToBase64, base64ToBuffer
} from '../../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../../lib/auth.js';
import { getKeyPaths } from '../../lib/config.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', '.test-edge-' + process.pid);

before(() => mkdirSync(TEST_DIR, { recursive: true }));
after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('Crypto edge cases', () => {
  it('decrypt with wrong nonce fails', async () => {
    const senderEd = await generateEd25519KeyPair();
    const senderX = await generateX25519KeyPair();
    const recipientX = await generateX25519KeyPair();

    const encrypted = await encryptForRecipient('secret', recipientX.publicKey, senderEd.privateKey);
    // Tamper nonce
    const wrongNonce = bufferToBase64(new Uint8Array(12));
    await assert.rejects(
      () => decryptFromSender(encrypted.ciphertext, encrypted.ephemeralKey, wrongNonce, recipientX.privateKey),
      /.*/ // Any error = correct behavior
    );
  });

  it('decrypt with wrong ephemeral key fails', async () => {
    const senderEd = await generateEd25519KeyPair();
    const senderX = await generateX25519KeyPair();
    const recipientX = await generateX25519KeyPair();
    const wrongX = await generateX25519KeyPair();

    const encrypted = await encryptForRecipient('secret', recipientX.publicKey, senderEd.privateKey);
    await assert.rejects(
      () => decryptFromSender(encrypted.ciphertext, wrongX.publicKey, encrypted.nonce, recipientX.privateKey)
    );
  });

  it('verifySignature with empty string message', async () => {
    const kp = await generateEd25519KeyPair();
    const sig = await signMessage('', kp.privateKey);
    const valid = await verifySignature('', sig, kp.publicKey);
    assert.equal(valid, true);
  });

  it('verifySignature with invalid base64 returns false', async () => {
    const kp = await generateEd25519KeyPair();
    const valid = await verifySignature('test', 'not-valid-base64!!!', kp.publicKey);
    assert.equal(valid, false);
  });

  it('verifySignature with empty pubkey returns false', async () => {
    const valid = await verifySignature('test', 'AAAA', '');
    assert.equal(valid, false);
  });

  it('unicode message encrypts and decrypts', async () => {
    const senderEd = await generateEd25519KeyPair();
    const senderX = await generateX25519KeyPair();
    const recipientX = await generateX25519KeyPair();

    const msg = '🔐 Привет мир! こんにちは 🌍';
    const enc = await encryptForRecipient(msg, recipientX.publicKey, senderEd.privateKey);
    const dec = await decryptFromSender(enc.ciphertext, enc.ephemeralKey, enc.nonce, recipientX.privateKey);
    assert.equal(dec, msg);
  });

  it('senderSig format: ciphertext:ephemeralKey:nonce:plaintextHash (4-part)', async () => {
    const senderEd = await generateEd25519KeyPair();
    const senderX = await generateX25519KeyPair();
    const recipientX = await generateX25519KeyPair();

    const enc = await encryptForRecipient('test', recipientX.publicKey, senderEd.privateKey);
    // Guardrail v2: 4-part payload includes plaintextHash
    const payload = `${enc.ciphertext}:${enc.ephemeralKey}:${enc.nonce}:${enc.plaintextHash}`;
    const valid = await verifySignature(payload, enc.senderSig, senderEd.publicKey);
    assert.equal(valid, true);
  });
});

describe('Auth edge cases', () => {
  it('POST headers with large body', async () => {
    const kp = await generateEd25519KeyPair();
    const body = JSON.stringify({ data: 'x'.repeat(50000) });
    const headers = await buildPostHeaders('test', body, kp.privateKey);
    assert.ok(headers['X-Agent-Signature']);
    // Verify signature
    const sig = await signMessage(`${headers['X-Agent-Timestamp']}:${body}`, kp.privateKey);
    assert.equal(headers['X-Agent-Signature'], sig);
  });

  it('GET headers with special chars in path', async () => {
    const kp = await generateEd25519KeyPair();
    const path = '/handle/info/test-handle_123';
    const headers = await buildGetHeaders('test', path, kp.privateKey);
    const sig = await signMessage(`GET:${path}:${headers['X-Agent-Timestamp']}`, kp.privateKey);
    assert.equal(headers['X-Agent-Signature'], sig);
  });
});

describe('send.js CLI edge cases', () => {
  let configDir;

  before(async () => {
    // Create test keys
    configDir = join(TEST_DIR, 'agent-chat-edgetest');
    mkdirSync(configDir, { recursive: true });
    const ed = await generateEd25519KeyPair();
    const x = await generateX25519KeyPair();
    const paths = getKeyPaths(configDir);
    writeFileSync(paths.ed25519PublicKey, Buffer.from(ed.publicKey, 'base64'));
    writeFileSync(paths.ed25519PrivateKey, Buffer.from(ed.privateKey, 'base64'));
    writeFileSync(paths.x25519PublicKey, Buffer.from(x.publicKey, 'base64'));
    writeFileSync(paths.x25519PrivateKey, Buffer.from(x.privateKey, 'base64'));
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ handle: 'edgetest' }));
  });

  it('handle-join without handle → exit 1', () => {
    try {
      execSync('node scripts/send.js handle-join', {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: 'edgetest' },
        stdio: 'pipe'
      });
      assert.fail('Should exit');
    } catch (err) { assert.equal(err.status, 1); }
  });

  it('handle-leave without handle → exit 1', () => {
    try {
      execSync('node scripts/send.js handle-leave', {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: 'edgetest' },
        stdio: 'pipe'
      });
      assert.fail('Should exit');
    } catch (err) { assert.equal(err.status, 1); }
  });

  it('handle-permission without agent → exit 1', () => {
    try {
      execSync('node scripts/send.js handle-permission myhandle', {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: 'edgetest' },
        stdio: 'pipe'
      });
      assert.fail('Should exit');
    } catch (err) { assert.equal(err.status, 1); }
  });

  it('send with only recipient (no message) → exit 1', () => {
    try {
      execSync('node scripts/send.js send bob', {
        env: { ...process.env, AGENT_SECRETS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: 'edgetest' },
        stdio: 'pipe'
      });
      assert.fail('Should exit');
    } catch (err) { assert.equal(err.status, 1); }
  });
});
