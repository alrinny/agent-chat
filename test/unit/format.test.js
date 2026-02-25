import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatHandle, inferHandleType } from '../../lib/format.js';

describe('formatHandle', () => {
  it('FMT-001: defaults to @ prefix (personal)', () => {
    assert.equal(formatHandle('alice'), '@alice');
  });

  it('FMT-002: explicit personal type uses @', () => {
    assert.equal(formatHandle('bob', 'personal'), '@bob');
  });

  it('FMT-003: group type uses #', () => {
    assert.equal(formatHandle('clawns', 'group'), '#clawns');
  });

  it('FMT-004: broadcast type uses ~', () => {
    assert.equal(formatHandle('news', 'broadcast'), '~news');
  });

  it('FMT-005: unknown type defaults to @', () => {
    assert.equal(formatHandle('test', 'unknown'), '@test');
  });
});

describe('inferHandleType', () => {
  it('FMT-006: handle with keys is personal', () => {
    assert.equal(inferHandleType({
      name: 'alice',
      owner: 'alice',
      ed25519PublicKey: 'abc123',
      defaultWrite: 'allow'
    }), 'personal');
  });

  it('FMT-007: handle without keys + defaultWrite allow is group', () => {
    assert.equal(inferHandleType({
      name: 'clawns',
      owner: 'rinny',
      ed25519PublicKey: null,
      defaultWrite: 'allow'
    }), 'group');
  });

  it('FMT-008: handle without keys + defaultWrite deny is broadcast', () => {
    assert.equal(inferHandleType({
      name: 'news',
      owner: 'rinny',
      ed25519PublicKey: null,
      defaultWrite: 'deny'
    }), 'broadcast');
  });

  it('FMT-009: null info returns personal', () => {
    assert.equal(inferHandleType(null), 'personal');
  });

  it('FMT-010: undefined info returns personal', () => {
    assert.equal(inferHandleType(undefined), 'personal');
  });

  it('FMT-011: missing defaultWrite defaults to group (not broadcast)', () => {
    assert.equal(inferHandleType({
      name: 'chat',
      owner: 'alice',
      ed25519PublicKey: null
    }), 'group');
  });
});
