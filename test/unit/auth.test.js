/**
 * Unit tests for lib/auth.js — client-side auth header building.
 *
 * Tests: AUTH-CLIENT-001..012
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostHeaders,
  buildGetHeaders
} from '../../lib/auth.js';
import { generateEd25519KeyPair, signMessage, verifySignature } from '../../lib/crypto.js';

describe('buildPostHeaders', () => {
  let keyPair;
  before(async () => {
    keyPair = await generateEd25519KeyPair();
  });

  // AUTH-CLIENT-001
  it('returns required headers', async () => {
    const headers = await buildPostHeaders('myhandle', '{"test":true}', keyPair.privateKey);
    assert.ok(headers['X-Agent-Handle']);
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
    assert.ok(headers['Content-Type']);
  });

  // AUTH-CLIENT-002
  it('handle matches input', async () => {
    const headers = await buildPostHeaders('alice', '{}', keyPair.privateKey);
    assert.equal(headers['X-Agent-Handle'], 'alice');
  });

  // AUTH-CLIENT-003
  it('timestamp is current (within 5s)', async () => {
    const headers = await buildPostHeaders('alice', '{}', keyPair.privateKey);
    const ts = parseInt(headers['X-Agent-Timestamp']);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(ts - now) < 5);
  });

  // AUTH-CLIENT-004
  it('signature format: "{ts}:{body}"', async () => {
    const body = '{"hello":"world"}';
    const headers = await buildPostHeaders('alice', body, keyPair.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    const payload = `${ts}:${body}`;
    const ok = await verifySignature(payload, sig, keyPair.publicKey);
    assert.equal(ok, true, 'signature verifies with payload format ts:body');
  });

  // AUTH-CLIENT-005
  it('empty body → signature of "{ts}:"', async () => {
    const headers = await buildPostHeaders('alice', '', keyPair.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    const ok = await verifySignature(`${ts}:`, sig, keyPair.publicKey);
    assert.equal(ok, true);
  });

  // AUTH-CLIENT-006
  it('Content-Type is application/json', async () => {
    const headers = await buildPostHeaders('alice', '{}', keyPair.privateKey);
    assert.equal(headers['Content-Type'], 'application/json');
  });
});

describe('buildGetHeaders', () => {
  let keyPair;
  before(async () => {
    keyPair = await generateEd25519KeyPair();
  });

  // AUTH-CLIENT-007
  it('returns required headers (no Content-Type)', async () => {
    const headers = await buildGetHeaders('alice', '/inbox/alice', keyPair.privateKey);
    assert.ok(headers['X-Agent-Handle']);
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
    assert.equal(headers['Content-Type'], undefined);
  });

  // AUTH-CLIENT-008
  it('signature format: "GET:{path}:{ts}"', async () => {
    const path = '/inbox/alice';
    const headers = await buildGetHeaders('alice', path, keyPair.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    const ok = await verifySignature(`GET:${path}:${ts}`, sig, keyPair.publicKey);
    assert.equal(ok, true);
  });

  // AUTH-CLIENT-009
  it('different paths produce different signatures', async () => {
    const h1 = await buildGetHeaders('alice', '/inbox/alice', keyPair.privateKey);
    const h2 = await buildGetHeaders('alice', '/inbox/bob', keyPair.privateKey);
    assert.notEqual(h1['X-Agent-Signature'], h2['X-Agent-Signature']);
  });
});
