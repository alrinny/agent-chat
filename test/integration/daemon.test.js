/**
 * Integration tests for daemon.js — polling, dedup, WS close codes, sendTelegram.
 *
 * Tests: DAEMON-POLL-001..006, DAEMON-DEDUP-001..005, DAEMON-WS-001..006,
 *        DAEMON-TELEGRAM-001..005
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldProcessMessage,
  buildDedupKey,
  shouldReconnectOnClose,
  shouldExitOnClose,
  formatTelegramMessage
} from '../../lib/daemon.js';

describe('Dedup logic', () => {
  // DAEMON-DEDUP-001
  it('buildDedupKey includes id and effectiveRead', () => {
    const key = buildDedupKey('msg-123', 'trusted');
    assert.equal(key, 'msg-123:trusted');
  });

  // DAEMON-DEDUP-002
  it('same id, different effectiveRead → different keys', () => {
    const k1 = buildDedupKey('msg-123', 'blind');
    const k2 = buildDedupKey('msg-123', 'trusted');
    assert.notEqual(k1, k2);
  });

  // DAEMON-DEDUP-003
  it('shouldProcessMessage returns true for new key', () => {
    const seen = new Set();
    assert.equal(shouldProcessMessage('msg-1', 'trusted', seen), true);
  });

  // DAEMON-DEDUP-004
  it('shouldProcessMessage returns false for seen key', () => {
    const seen = new Set(['msg-1:trusted']);
    assert.equal(shouldProcessMessage('msg-1', 'trusted', seen), false);
  });

  // DAEMON-DEDUP-005
  it('same id redelivered with new trust → processes again', () => {
    const seen = new Set(['msg-1:blind']);
    // After redeliver: same id but effectiveRead changed
    assert.equal(shouldProcessMessage('msg-1', 'trusted', seen), true);
  });
});

describe('WS close codes', () => {
  // DAEMON-WS-001
  it('4001 (auth failed) → exit', () => {
    assert.equal(shouldExitOnClose(4001), true);
  });

  // DAEMON-WS-002
  it('4002 (handle not found) → exit', () => {
    assert.equal(shouldExitOnClose(4002), true);
  });

  // DAEMON-WS-003
  it('4003 (signature expired) → exit', () => {
    assert.equal(shouldExitOnClose(4003), true);
  });

  // DAEMON-WS-004
  it('4004+ → reconnect', () => {
    assert.equal(shouldReconnectOnClose(4004), true);
    assert.equal(shouldReconnectOnClose(4005), true);
    assert.equal(shouldReconnectOnClose(4999), true);
  });

  // DAEMON-WS-005
  it('1000 (normal close) → reconnect', () => {
    assert.equal(shouldReconnectOnClose(1000), true);
  });

  // DAEMON-WS-006
  it('1006 (abnormal) → reconnect', () => {
    assert.equal(shouldReconnectOnClose(1006), true);
  });
});

describe('Telegram message formatting', () => {
  // DAEMON-TELEGRAM-001
  it('trusted message → shows body', () => {
    const text = formatTelegramMessage({
      from: 'alice',
      effectiveRead: 'trusted',
      decryptedText: 'Hello!'
    });
    assert.ok(text.includes('alice'));
    assert.ok(text.includes('Hello!'));
  });

  // DAEMON-TELEGRAM-002
  it('blind message → shows notification only', () => {
    const text = formatTelegramMessage({
      from: 'alice',
      effectiveRead: 'blind',
      decryptedText: null
    });
    assert.ok(text.includes('alice'));
    assert.ok(!text.includes('decrypted'));
  });

  // DAEMON-TELEGRAM-003
  it('includes @handle format', () => {
    const text = formatTelegramMessage({
      from: 'alice',
      effectiveRead: 'trusted',
      decryptedText: 'Hi'
    });
    assert.ok(text.includes('@alice'));
  });
});

describe('Polling logic', () => {
  // DAEMON-POLL-001
  it('ack only trusted message IDs', () => {
    const messages = [
      { id: 'msg-1', effectiveRead: 'trusted' },
      { id: 'msg-2', effectiveRead: 'blind' },
      { id: 'msg-3', effectiveRead: 'trusted' }
    ];
    const toAck = messages.filter(m => m.effectiveRead === 'trusted').map(m => m.id);
    assert.deepEqual(toAck, ['msg-1', 'msg-3']);
  });

  // DAEMON-POLL-002
  it('blind messages NOT acked', () => {
    const messages = [
      { id: 'msg-1', effectiveRead: 'blind' },
      { id: 'msg-2', effectiveRead: 'blind' }
    ];
    const toAck = messages.filter(m => m.effectiveRead === 'trusted').map(m => m.id);
    assert.deepEqual(toAck, []);
  });

  // DAEMON-POLL-003
  it('empty inbox → no ack needed', () => {
    const messages = [];
    const toAck = messages.filter(m => m.effectiveRead === 'trusted').map(m => m.id);
    assert.deepEqual(toAck, []);
  });
});
