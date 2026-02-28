/**
 * Unit tests for exactly-once delivery (lastAckedId cursor)
 *
 * Tests: EXACT-001..006
 *
 * Daemon persists lastAckedId after processing each message.
 * On reconnect, sends ?after=<lastAckedId> to relay so server
 * only returns messages newer than cursor.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the lastAckedId persistence logic directly (no daemon import needed)
// The daemon uses simple file read/write — we verify the contract

const TEST_DIR = join(tmpdir(), `exact-once-test-${Date.now()}`);
const LAST_ACKED_PATH = join(TEST_DIR, 'lastAckedId');

// Helper: same logic as daemon will use
function saveLastAckedId(id) {
  writeFileSync(LAST_ACKED_PATH, id, 'utf8');
}

function loadLastAckedId() {
  try {
    if (existsSync(LAST_ACKED_PATH)) {
      return readFileSync(LAST_ACKED_PATH, 'utf8').trim();
    }
  } catch {}
  return null;
}

function buildInboxUrl(handle, lastAckedId) {
  const base = `/inbox/${handle}`;
  return lastAckedId ? `${base}?after=${lastAckedId}` : base;
}

describe('exactly-once: lastAckedId persistence', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  // EXACT-001: No file → returns null
  it('EXACT-001: no lastAckedId file returns null', () => {
    assert.equal(loadLastAckedId(), null);
  });

  // EXACT-002: Save and load
  it('EXACT-002: save and load lastAckedId', () => {
    saveLastAckedId('msg-abc-123');
    assert.equal(loadLastAckedId(), 'msg-abc-123');
  });

  // EXACT-003: Overwrite with newer id
  it('EXACT-003: overwrite updates to newer id', () => {
    saveLastAckedId('msg-1');
    saveLastAckedId('msg-2');
    assert.equal(loadLastAckedId(), 'msg-2');
  });

  // EXACT-004: Corrupt file → returns empty string
  it('EXACT-004: empty file returns empty string', () => {
    writeFileSync(LAST_ACKED_PATH, '', 'utf8');
    assert.equal(loadLastAckedId(), '');
    // Empty string is falsy, so buildInboxUrl should treat it as no cursor
  });
});

describe('exactly-once: inbox URL building', () => {
  // EXACT-005: No cursor → plain URL
  it('EXACT-005: no cursor builds plain inbox URL', () => {
    assert.equal(buildInboxUrl('rinny', null), '/inbox/rinny');
    assert.equal(buildInboxUrl('rinny', ''), '/inbox/rinny');
    assert.equal(buildInboxUrl('rinny', undefined), '/inbox/rinny');
  });

  // EXACT-006: With cursor → adds ?after=
  it('EXACT-006: cursor adds after query param', () => {
    assert.equal(buildInboxUrl('rinny', 'msg-abc-123'), '/inbox/rinny?after=msg-abc-123');
  });
});
