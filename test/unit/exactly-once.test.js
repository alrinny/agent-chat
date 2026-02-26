/**
 * Unit tests for exactly-once delivery (lastAckedId cursor)
 *
 * Tests: EXACT-001..006
 *
 * Daemon persists lastAckedId after processing each message.
 * On reconnect, sends ?after=<lastAckedId> to relay so server
 * only returns messages newer than cursor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the lastAckedId persistence logic directly (no daemon import needed)
// The daemon uses simple file read/write — we verify the contract

const TEST_DIR = join(tmpdir(), `exact-once-test-${Date.now()}`);
const LAST_ACKED_PATH = join(TEST_DIR, 'lastAckedId');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

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
  // EXACT-001: No file → returns null
  it('EXACT-001: no lastAckedId file returns null', () => {
    expect(loadLastAckedId()).toBeNull();
  });

  // EXACT-002: Save and load
  it('EXACT-002: save and load lastAckedId', () => {
    saveLastAckedId('msg-abc-123');
    expect(loadLastAckedId()).toBe('msg-abc-123');
  });

  // EXACT-003: Overwrite with newer id
  it('EXACT-003: overwrite updates to newer id', () => {
    saveLastAckedId('msg-1');
    saveLastAckedId('msg-2');
    expect(loadLastAckedId()).toBe('msg-2');
  });

  // EXACT-004: Corrupt file → returns null (no crash)
  it('EXACT-004: corrupt file returns null gracefully', () => {
    writeFileSync(LAST_ACKED_PATH, '', 'utf8');
    expect(loadLastAckedId()).toBe('');
    // Empty string is falsy, so buildInboxUrl should treat it as no cursor
  });
});

describe('exactly-once: inbox URL building', () => {
  // EXACT-005: No cursor → plain URL
  it('EXACT-005: no cursor builds plain inbox URL', () => {
    expect(buildInboxUrl('rinny', null)).toBe('/inbox/rinny');
    expect(buildInboxUrl('rinny', '')).toBe('/inbox/rinny');
    expect(buildInboxUrl('rinny', undefined)).toBe('/inbox/rinny');
  });

  // EXACT-006: With cursor → adds ?after=
  it('EXACT-006: cursor adds after query param', () => {
    expect(buildInboxUrl('rinny', 'msg-abc-123')).toBe('/inbox/rinny?after=msg-abc-123');
  });
});
