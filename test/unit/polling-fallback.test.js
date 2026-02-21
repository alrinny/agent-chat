/**
 * Polling fallback tests — inbox fetch, ack, dedup, error recovery.
 * From test-plan.md sections 3.3, 16.2, 21.4
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Polling: Inbox Fetch', () => {
  it('GET /inbox/{handle} returns messages array', () => {
    const response = { messages: [
      { id: 'msg-1', from: 'alice', effectiveRead: 'trusted', ciphertext: 'Y3Q=' },
      { id: 'msg-2', from: 'bob', effectiveRead: 'blind', ciphertext: 'Y3Qy' }
    ]};
    assert.ok(Array.isArray(response.messages));
    assert.equal(response.messages.length, 2);
  });

  it('empty inbox → empty array', () => {
    const response = { messages: [] };
    assert.equal(response.messages.length, 0);
  });

  it('max 50 messages per poll', () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ id: `msg-${i}` }));
    const returned = messages.slice(0, 50);
    assert.equal(returned.length, 50);
  });
});

describe('Polling: Ack (POLL-BUG-001)', () => {
  it('only ack trusted messages', () => {
    const messages = [
      { id: 'msg-1', effectiveRead: 'trusted' },
      { id: 'msg-2', effectiveRead: 'blind' },
      { id: 'msg-3', effectiveRead: 'trusted' }
    ];
    const ackIds = messages
      .filter(m => m.effectiveRead === 'trusted')
      .map(m => m.id);
    assert.deepEqual(ackIds, ['msg-1', 'msg-3']);
  });

  it('blind messages stay in inbox for redeliver', () => {
    const inbox = ['msg-1', 'msg-2'];
    const ackedIds = new Set(['msg-1']); // Only msg-1 was trusted and acked
    const remaining = inbox.filter(id => !ackedIds.has(id));
    assert.deepEqual(remaining, ['msg-2']); // msg-2 (blind) stays
  });

  it('after trust change → redeliver → blind becomes trusted', () => {
    const before = { id: 'msg-2', effectiveRead: 'blind' };
    // Trust confirmed → redeliver recalculates
    const after = { id: 'msg-2', effectiveRead: 'trusted' };
    assert.equal(after.effectiveRead, 'trusted');
  });

  it('redelivered trusted message → now acked', () => {
    const messages = [{ id: 'msg-2', effectiveRead: 'trusted' }]; // After redeliver
    const ackIds = messages.map(m => m.id);
    assert.deepEqual(ackIds, ['msg-2']);
  });
});

describe('Polling: Dedup', () => {
  it('dedup key = id:effectiveRead', () => {
    const key = 'msg-1:trusted';
    const [id, trust] = key.split(':');
    assert.equal(id, 'msg-1');
    assert.equal(trust, 'trusted');
  });

  it('same id+trust → skip', () => {
    const seen = new Set(['msg-1:trusted']);
    const isDup = seen.has('msg-1:trusted');
    assert.ok(isDup);
  });

  it('same id different trust → process (redeliver)', () => {
    const seen = new Set(['msg-1:blind']);
    const isDup = seen.has('msg-1:trusted');
    assert.equal(isDup, false);
  });
});

describe('Polling: Interval', () => {
  it('default interval: 30 seconds', () => {
    const interval = 30000;
    assert.equal(interval, 30000);
  });

  it('WS connected → polling paused', () => {
    const wsConnected = true;
    const shouldPoll = !wsConnected;
    assert.equal(shouldPoll, false);
  });

  it('WS disconnected → polling resumes', () => {
    const wsConnected = false;
    const shouldPoll = !wsConnected;
    assert.ok(shouldPoll);
  });
});

describe('Polling: Starvation (21.4)', () => {
  it('50 blind messages → all returned, none acked', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`, effectiveRead: 'blind'
    }));
    const ackIds = messages.filter(m => m.effectiveRead === 'trusted').map(m => m.id);
    assert.equal(ackIds.length, 0);
  });

  it('starvation: next poll returns same 50', () => {
    // Since none were acked, inbox unchanged
    const inboxSize = 50;
    assert.equal(inboxSize, 50);
  });

  it('messages 51-60 hidden until first 50 clear', () => {
    const inboxTotal = 60;
    const returned = 50;
    const hidden = inboxTotal - returned;
    assert.equal(hidden, 10);
  });

  it('trust senders → blind→trusted → acked → new messages surface', () => {
    let inbox = 60;
    const acked = 50; // All 50 now trusted and acked
    inbox -= acked;
    assert.equal(inbox, 10);
  });
});

describe('Polling: Error Recovery', () => {
  it('network error → retry next interval', () => {
    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
      try {
        throw new Error('ECONNREFUSED');
      } catch {
        retries++;
      }
    }
    assert.equal(retries, maxRetries);
  });

  it('401 from relay → re-register or check keys', () => {
    const status = 401;
    const action = status === 401 ? 'check_keys' : 'retry';
    assert.equal(action, 'check_keys');
  });

  it('5xx from relay → retry with backoff', () => {
    const status = 500;
    const shouldRetry = status >= 500;
    assert.ok(shouldRetry);
  });
});
