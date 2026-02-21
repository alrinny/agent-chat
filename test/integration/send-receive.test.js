/**
 * Integration tests for send-receive flow (mock relay).
 *
 * Tests: SR-001..012
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  encryptForRecipient,
  decryptFromSender,
  verifySignature
} from '../../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../../lib/auth.js';

describe('Send-Receive E2E (crypto + auth)', () => {
  let alice, bob;
  before(async () => {
    alice = {
      handle: 'alice',
      ed25519: await generateEd25519KeyPair(),
      x25519: await generateX25519KeyPair()
    };
    bob = {
      handle: 'bob',
      ed25519: await generateEd25519KeyPair(),
      x25519: await generateX25519KeyPair()
    };
  });

  // SR-001
  it('full DM flow: encrypt → headers → decrypt', async () => {
    const plaintext = 'Hello Bob, this is a secret message';

    // Alice encrypts for Bob
    const encrypted = await encryptForRecipient(
      plaintext,
      bob.x25519.publicKey,
      alice.x25519.privateKey,
      alice.ed25519.privateKey
    );

    // Alice builds send request headers
    const body = JSON.stringify({
      to: 'bob',
      ciphertext: encrypted.ciphertext,
      ephemeralKey: encrypted.ephemeralKey,
      nonce: encrypted.nonce,
      senderSig: encrypted.senderSig
    });
    const headers = await buildPostHeaders('alice', body, alice.ed25519.privateKey);

    // Verify headers are valid
    assert.equal(headers['X-Agent-Handle'], 'alice');
    assert.ok(headers['X-Agent-Signature']);

    // Bob decrypts
    const decrypted = await decryptFromSender(
      encrypted.ciphertext,
      encrypted.ephemeralKey,
      encrypted.nonce,
      bob.x25519.privateKey
    );
    assert.equal(decrypted, plaintext);
  });

  // SR-002
  it('sender signature verification by recipient', async () => {
    const encrypted = await encryptForRecipient(
      'signed message',
      bob.x25519.publicKey,
      alice.x25519.privateKey,
      alice.ed25519.privateKey
    );

    // Bob verifies sender signature
    const sigPayload = `${encrypted.ciphertext}:${encrypted.ephemeralKey}:${encrypted.nonce}`;
    const valid = await verifySignature(sigPayload, encrypted.senderSig, alice.ed25519.publicKey);
    assert.equal(valid, true, 'sender signature should be valid');
  });

  // SR-003
  it('forged sender signature → verification fails', async () => {
    const encrypted = await encryptForRecipient(
      'signed message',
      bob.x25519.publicKey,
      alice.x25519.privateKey,
      alice.ed25519.privateKey
    );

    // Check with wrong key
    const valid = await verifySignature(
      `${encrypted.ciphertext}:${encrypted.ephemeralKey}:${encrypted.nonce}`,
      encrypted.senderSig,
      bob.ed25519.publicKey // wrong key — should be alice's
    );
    assert.equal(valid, false);
  });

  // SR-004
  it('auth headers timestamp is fresh', async () => {
    const headers = await buildPostHeaders('alice', '{}', alice.ed25519.privateKey);
    const ts = parseInt(headers['X-Agent-Timestamp']);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(ts - now) <= 2, 'timestamp within 2 seconds');
  });

  // SR-005
  it('GET auth headers have correct format', async () => {
    const headers = await buildGetHeaders('alice', '/inbox/alice', alice.ed25519.privateKey);
    assert.equal(headers['X-Agent-Handle'], 'alice');
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
  });

  // SR-006
  it('multi-recipient encrypt (group)', async () => {
    const charlie = {
      handle: 'charlie',
      x25519: await generateX25519KeyPair()
    };

    const plaintext = 'Hello group!';

    // Alice encrypts separately for bob and charlie
    const forBob = await encryptForRecipient(
      plaintext,
      bob.x25519.publicKey,
      alice.x25519.privateKey,
      alice.ed25519.privateKey
    );
    const forCharlie = await encryptForRecipient(
      plaintext,
      charlie.x25519.publicKey,
      alice.x25519.privateKey,
      alice.ed25519.privateKey
    );

    // Different ciphertexts (different recipients)
    assert.notEqual(forBob.ciphertext, forCharlie.ciphertext);

    // Both decrypt to same plaintext
    const bobDecrypted = await decryptFromSender(
      forBob.ciphertext, forBob.ephemeralKey, forBob.nonce, bob.x25519.privateKey
    );
    const charlieDecrypted = await decryptFromSender(
      forCharlie.ciphertext, forCharlie.ephemeralKey, forCharlie.nonce, charlie.x25519.privateKey
    );
    assert.equal(bobDecrypted, plaintext);
    assert.equal(charlieDecrypted, plaintext);
  });

  // SR-007
  it('bob cannot decrypt charlie\'s envelope', async () => {
    const charlie = {
      x25519: await generateX25519KeyPair()
    };

    const forCharlie = await encryptForRecipient(
      'for charlie only',
      charlie.x25519.publicKey,
      alice.x25519.privateKey,
      alice.ed25519.privateKey
    );

    await assert.rejects(async () => {
      await decryptFromSender(
        forCharlie.ciphertext, forCharlie.ephemeralKey, forCharlie.nonce, bob.x25519.privateKey
      );
    });
  });

  // SR-008
  it('unicode message roundtrip', async () => {
    const plaintext = '🔐 Привет мир! こんにちは 🌍';
    const encrypted = await encryptForRecipient(
      plaintext, bob.x25519.publicKey, alice.x25519.privateKey, alice.ed25519.privateKey
    );
    const decrypted = await decryptFromSender(
      encrypted.ciphertext, encrypted.ephemeralKey, encrypted.nonce, bob.x25519.privateKey
    );
    assert.equal(decrypted, plaintext);
  });

  // SR-009
  it('register payload: sig of "register:{handle}"', async () => {
    const { signMessage } = await import('../../lib/crypto.js');
    const sig = await signMessage('register:alice', alice.ed25519.privateKey);
    const ok = await verifySignature('register:alice', sig, alice.ed25519.publicKey);
    assert.equal(ok, true);
  });
});
