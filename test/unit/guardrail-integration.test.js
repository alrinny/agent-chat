/**
 * Cross-repo integration tests — Guardrail v2
 * Tests the full crypto chain: client encryptForRecipient → relay guardrail verification.
 * Simulates what happens when relay receives a guardrail scan request.
 *
 * Tests: GUARD-INTEG-001..005
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  encryptForRecipient,
  decryptFromSender,
  verifySignature
} from '../../lib/crypto.js';

describe('Guardrail v2 — cross-repo integration', () => {
  let alice, bob;

  before(async () => {
    alice = {
      ed: await generateEd25519KeyPair(),
      x: await generateX25519KeyPair()
    };
    bob = {
      ed: await generateEd25519KeyPair(),
      x: await generateX25519KeyPair()
    };
  });

  // GUARD-INTEG-001: full send → decrypt → verify hash → verify sig
  it('encrypt → decrypt → hash matches → sig verifies (full guardrail flow)', async () => {
    const plaintext = 'Hello Bob, this is a test message!';

    // 1. Alice encrypts for Bob (client-side)
    const encrypted = await encryptForRecipient(plaintext, bob.x.publicKey, alice.ed.privateKey);

    // 2. Bob decrypts (client-side)
    const decrypted = await decryptFromSender(
      encrypted.ciphertext, encrypted.ephemeralKey, encrypted.nonce,
      bob.x.privateKey
    );
    assert.equal(decrypted, plaintext);

    // 3. Bob computes hash of decrypted text (relay-side equivalent)
    const computedHash = createHash('sha256').update(decrypted, 'utf8').digest('base64');

    // 4. Hash matches what sender included
    assert.equal(computedHash, encrypted.plaintextHash);

    // 5. Verify senderSig with 4-part payload (relay-side equivalent)
    const sigPayload = `${encrypted.ciphertext}:${encrypted.ephemeralKey}:${encrypted.nonce}:${computedHash}`;
    const valid = await verifySignature(sigPayload, encrypted.senderSig, alice.ed.publicKey);
    assert.equal(valid, true, 'senderSig must verify with 4-part payload');
  });

  // GUARD-INTEG-002: wrong text → hash mismatch (relay rejects)
  it('wrong text → hash mismatch (relay would reject)', async () => {
    const plaintext = 'Real message';
    const encrypted = await encryptForRecipient(plaintext, bob.x.publicKey, alice.ed.privateKey);

    // Attacker submits different text
    const fakeHash = createHash('sha256').update('Fake message', 'utf8').digest('base64');
    assert.notEqual(fakeHash, encrypted.plaintextHash, 'different text → different hash');
  });

  // GUARD-INTEG-003: tampering with plaintextHash invalidates sig
  it('tampered plaintextHash → sig verification fails', async () => {
    const plaintext = 'Original text';
    const encrypted = await encryptForRecipient(plaintext, bob.x.publicKey, alice.ed.privateKey);

    // Try verifying with tampered hash
    const tamperedHash = createHash('sha256').update('tampered', 'utf8').digest('base64');
    const sigPayload = `${encrypted.ciphertext}:${encrypted.ephemeralKey}:${encrypted.nonce}:${tamperedHash}`;
    const valid = await verifySignature(sigPayload, encrypted.senderSig, alice.ed.publicKey);
    assert.equal(valid, false, 'tampered hash must fail sig verification');
  });

  // GUARD-INTEG-004: group fan-out — same plaintext, different ciphertexts, same hash
  it('group fan-out: same plaintext → same hash across recipients', async () => {
    const charlie = {
      ed: await generateEd25519KeyPair(),
      x: await generateX25519KeyPair()
    };

    const plaintext = 'Group announcement!';
    const forBob = await encryptForRecipient(plaintext, bob.x.publicKey, alice.ed.privateKey);
    const forCharlie = await encryptForRecipient(plaintext, charlie.x.publicKey, alice.ed.privateKey);

    // Same plaintext hash
    assert.equal(forBob.plaintextHash, forCharlie.plaintextHash);
    // Different ciphertexts (different ephemeral keys)
    assert.notEqual(forBob.ciphertext, forCharlie.ciphertext);

    // Both sigs verify independently
    const payloadBob = `${forBob.ciphertext}:${forBob.ephemeralKey}:${forBob.nonce}:${forBob.plaintextHash}`;
    const payloadCharlie = `${forCharlie.ciphertext}:${forCharlie.ephemeralKey}:${forCharlie.nonce}:${forCharlie.plaintextHash}`;

    assert.equal(await verifySignature(payloadBob, forBob.senderSig, alice.ed.publicKey), true);
    assert.equal(await verifySignature(payloadCharlie, forCharlie.senderSig, alice.ed.publicKey), true);
  });

  // GUARD-INTEG-005: empty message has valid hash and sig
  it('empty message → valid hash + sig', async () => {
    const plaintext = '';
    const encrypted = await encryptForRecipient(plaintext, bob.x.publicKey, alice.ed.privateKey);

    const decrypted = await decryptFromSender(
      encrypted.ciphertext, encrypted.ephemeralKey, encrypted.nonce,
      bob.x.privateKey
    );
    assert.equal(decrypted, '');

    const computedHash = createHash('sha256').update(decrypted, 'utf8').digest('base64');
    assert.equal(computedHash, encrypted.plaintextHash);

    const sigPayload = `${encrypted.ciphertext}:${encrypted.ephemeralKey}:${encrypted.nonce}:${computedHash}`;
    assert.equal(await verifySignature(sigPayload, encrypted.senderSig, alice.ed.publicKey), true);
  });
});
