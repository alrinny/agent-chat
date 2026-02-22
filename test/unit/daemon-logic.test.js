/**
 * Unit tests for ws-daemon.js logic — message handling, dedup, escapeHtml, blind cache.
 * Does NOT test actual WS/HTTP connections (that's integration).
 *
 * Tests: DAEMON-DEDUP-001..003, DAEMON-ESCAPE-001..002, DAEMON-CACHE-001..003
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, blindMessageCache, processedMessageIds } from '../../scripts/ws-daemon.js';

before(() => {
  blindMessageCache.clear();
  processedMessageIds.clear();
});

describe('escapeHtml', () => {
  it('DAEMON-ESCAPE-001: escapes HTML entities', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('DAEMON-ESCAPE-002: escapes ampersands', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });
});

describe('Deduplication', () => {
  it('DAEMON-DEDUP-001: first message passes dedup', () => {
    const dedupKey = 'msg-001:trusted';
    assert.equal(processedMessageIds.has(dedupKey), false);
    processedMessageIds.add(dedupKey);
    assert.equal(processedMessageIds.has(dedupKey), true);
  });

  it('DAEMON-DEDUP-002: same id+effectiveRead is duplicate', () => {
    const dedupKey = 'msg-001:trusted';
    assert.equal(processedMessageIds.has(dedupKey), true);
  });

  it('DAEMON-DEDUP-003: same id with different effectiveRead passes (redeliver)', () => {
    const dedupKey = 'msg-001:blind';
    assert.equal(processedMessageIds.has(dedupKey), false);
  });
});

describe('Blind message cache', () => {
  it('DAEMON-CACHE-001: stores and retrieves message', () => {
    const id = 'show_msg-100';
    blindMessageCache.set(id, { text: 'hello', from: 'alice', ts: Date.now() });
    const cached = blindMessageCache.get(id);
    assert.equal(cached.text, 'hello');
    assert.equal(cached.from, 'alice');
  });

  it('DAEMON-CACHE-002: returns undefined for expired/missing', () => {
    assert.equal(blindMessageCache.get('show_nonexistent'), undefined);
  });

  it('DAEMON-CACHE-003: delete removes entry', () => {
    blindMessageCache.set('show_temp', { text: 'temp', from: 'bob', ts: Date.now() });
    blindMessageCache.delete('show_temp');
    assert.equal(blindMessageCache.get('show_temp'), undefined);
  });
});
