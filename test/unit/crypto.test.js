/**
 * Unit tests for lib/crypto.js
 * Zero-dep: uses Node.js built-in crypto + node:test
 *
 * Tests: CRYPTO-KEYGEN-001..004, CRYPTO-SIGN-001..005, CRYPTO-ENCRYPT-001..008,
 *        CRYPTO-B64-001..003
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  signMessage,
  verifySignature,
  encryptForRecipient,
  decryptFromSender,
  bufferToBase64,
  base64ToBuffer
} from '../../lib/crypto.js';

describe('Key Generation', () => {
  // CRYPTO-KEYGEN-001
  it('generateEd25519KeyPair → { publicKey, privateKey }', async () => {
    const kp = await generateEd25519KeyPair();
    assert.ok(kp.publicKey, 'has publicKey');
    assert.ok(kp.privateKey, 'has privateKey');
    assert.ok(typeof kp.publicKey === 'string', 'publicKey is string (base64)');
    assert.ok(typeof kp.privateKey === 'string', 'privateKey is string (base64)');
  });

  // CRYPTO-KEYGEN-002
  it('Ed25519 public key is 32 bytes raw', async () => {
    const kp = await generateEd25519KeyPair();
    const raw = base64ToBuffer(kp.publicKey);
    assert.equal(raw.byteLength, 32);
  });

  // CRYPTO-KEYGEN-003
  it('generateX25519KeyPair → { publicKey, privateKey }', async () => {
    const kp = await generateX25519KeyPair();
    assert.ok(kp.publicKey);
    assert.ok(kp.privateKey);
  });

  // CRYPTO-KEYGEN-004
  it('X25519 public key is 32 bytes raw', async () => {
    const kp = await generateX25519KeyPair();
    const raw = base64ToBuffer(kp.publicKey);
    assert.equal(raw.byteLength, 32);
  });
});

describe('Ed25519 Signing', () => {
  let keyPair;
  before(async () => {
    keyPair = await generateEd25519KeyPair();
  });

  // CRYPTO-SIGN-001
  it('sign + verify → true', async () => {
    const sig = await signMessage('hello world', keyPair.privateKey);
    const ok = await verifySignature('hello world', sig, keyPair.publicKey);
    assert.equal(ok, true);
  });

  // CRYPTO-SIGN-002
  it('tampered message → false', async () => {
    const sig = await signMessage('hello world', keyPair.privateKey);
    const ok = await verifySignature('tampered', sig, keyPair.publicKey);
    assert.equal(ok, false);
  });

  // CRYPTO-SIGN-003
  it('wrong public key → false', async () => {
    const kp2 = await generateEd25519KeyPair();
    const sig = await signMessage('hello', keyPair.privateKey);
    const ok = await verifySignature('hello', sig, kp2.publicKey);
    assert.equal(ok, false);
  });

  // CRYPTO-SIGN-004
  it('signature is base64 string', async () => {
    const sig = await signMessage('hello', keyPair.privateKey);
    assert.ok(typeof sig === 'string');
    // Should decode without error
    const buf = base64ToBuffer(sig);
    assert.ok(buf.byteLength > 0);
  });

  // CRYPTO-SIGN-005
  it('Ed25519 signature is 64 bytes', async () => {
    const sig = await signMessage('test', keyPair.privateKey);
    const buf = base64ToBuffer(sig);
    assert.equal(buf.byteLength, 64);
  });
});

describe('X25519 + ChaCha20-Poly1305 Encryption', () => {
  let aliceEd, aliceX, bobEd, bobX;
  before(async () => {
    aliceEd = await generateEd25519KeyPair();
    aliceX = await generateX25519KeyPair();
    bobEd = await generateEd25519KeyPair();
    bobX = await generateX25519KeyPair();
  });

  // CRYPTO-ENCRYPT-001
  it('encrypt → { ciphertext, ephemeralKey, nonce, senderSig }', async () => {
    const result = await encryptForRecipient(
      'hello bob',
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    assert.ok(result.ciphertext, 'has ciphertext');
    assert.ok(result.ephemeralKey, 'has ephemeralKey');
    assert.ok(result.nonce, 'has nonce');
    assert.ok(result.senderSig, 'has senderSig');
  });

  // CRYPTO-ENCRYPT-002
  it('encrypt + decrypt → original text', async () => {
    const plaintext = 'secret message for bob';
    const encrypted = await encryptForRecipient(
      plaintext,
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    const decrypted = await decryptFromSender(
      encrypted.ciphertext,
      encrypted.ephemeralKey,
      encrypted.nonce,
      bobX.privateKey
    );
    assert.equal(decrypted, plaintext);
  });

  // CRYPTO-ENCRYPT-003
  it('wrong recipient key → decrypt fails', async () => {
    const encrypted = await encryptForRecipient(
      'secret',
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    await assert.rejects(async () => {
      await decryptFromSender(
        encrypted.ciphertext,
        encrypted.ephemeralKey,
        encrypted.nonce,
        aliceX.privateKey // wrong key
      );
    });
  });

  // CRYPTO-ENCRYPT-004
  it('tampered ciphertext → decrypt fails', async () => {
    const encrypted = await encryptForRecipient(
      'secret',
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    // Tamper
    const tampered = bufferToBase64(new Uint8Array(base64ToBuffer(encrypted.ciphertext)).map(b => b ^ 0xff).buffer);
    await assert.rejects(async () => {
      await decryptFromSender(tampered, encrypted.ephemeralKey, encrypted.nonce, bobX.privateKey);
    });
  });

  // CRYPTO-ENCRYPT-005
  it('empty string encrypts and decrypts', async () => {
    const encrypted = await encryptForRecipient(
      '',
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    const decrypted = await decryptFromSender(
      encrypted.ciphertext,
      encrypted.ephemeralKey,
      encrypted.nonce,
      bobX.privateKey
    );
    assert.equal(decrypted, '');
  });

  // CRYPTO-ENCRYPT-006
  it('large message (10KB) works', async () => {
    const big = 'x'.repeat(10240);
    const encrypted = await encryptForRecipient(
      big,
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    const decrypted = await decryptFromSender(
      encrypted.ciphertext,
      encrypted.ephemeralKey,
      encrypted.nonce,
      bobX.privateKey
    );
    assert.equal(decrypted, big);
  });

  // CRYPTO-ENCRYPT-007
  it('senderSig verifies with sender Ed25519 pubkey', async () => {
    const encrypted = await encryptForRecipient(
      'verify me',
      bobX.publicKey,
      aliceX.privateKey,
      aliceEd.privateKey
    );
    // senderSig signs: ciphertext:ephemeralKey:nonce
    const payload = `${encrypted.ciphertext}:${encrypted.ephemeralKey}:${encrypted.nonce}`;
    const ok = await verifySignature(payload, encrypted.senderSig, aliceEd.publicKey);
    assert.equal(ok, true);
  });

  // CRYPTO-ENCRYPT-008
  it('each encrypt produces unique nonce', async () => {
    const e1 = await encryptForRecipient('msg', bobX.publicKey, aliceX.privateKey, aliceEd.privateKey);
    const e2 = await encryptForRecipient('msg', bobX.publicKey, aliceX.privateKey, aliceEd.privateKey);
    assert.notEqual(e1.nonce, e2.nonce);
  });
});

describe('Base64 helpers', () => {
  // CRYPTO-B64-001
  it('bufferToBase64 → base64ToBuffer roundtrip', () => {
    const original = new TextEncoder().encode('hello');
    const b64 = bufferToBase64(original.buffer);
    const back = new Uint8Array(base64ToBuffer(b64));
    assert.deepEqual(back, original);
  });

  // CRYPTO-B64-002
  it('empty buffer roundtrip', () => {
    const empty = new Uint8Array(0);
    const b64 = bufferToBase64(empty.buffer);
    const back = new Uint8Array(base64ToBuffer(b64));
    assert.equal(back.byteLength, 0);
  });

  // CRYPTO-B64-003
  it('binary data (all byte values) roundtrip', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const b64 = bufferToBase64(all.buffer);
    const back = new Uint8Array(base64ToBuffer(b64));
    assert.deepEqual(back, all);
  });
});
