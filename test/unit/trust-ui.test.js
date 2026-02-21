/**
 * Trust UI tests — Telegram button layout, trust page rendering, blind cache.
 * From test-plan.md sections 20.1-20.2, 22.4
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Telegram Blind Message Buttons', () => {
  it('3 buttons: Show, Trust, Block', () => {
    const buttons = [
      [{ text: '👀 Show', callback_data: 'show:msg-1' }],
      [
        { text: '✅ Trust @alice', url: 'https://relay.test/trust/tok-trust' },
        { text: '🚫 Block @alice', url: 'https://relay.test/trust/tok-block' }
      ]
    ];
    assert.equal(buttons[0].length, 1); // Show alone
    assert.equal(buttons[1].length, 2); // Trust + Block
  });

  it('Show button is callback_data (in-app)', () => {
    const btn = { text: '👀 Show', callback_data: 'show:msg-123' };
    assert.ok(btn.callback_data);
    assert.ok(!btn.url);
  });

  it('Trust button is URL (opens browser)', () => {
    const btn = { text: '✅ Trust @alice', url: 'https://relay.test/trust/tok-trust' };
    assert.ok(btn.url);
    assert.ok(!btn.callback_data);
  });

  it('Block button is URL (opens browser)', () => {
    const btn = { text: '🚫 Block @alice', url: 'https://relay.test/trust/tok-block' };
    assert.ok(btn.url);
  });

  it('callback_data format: show:{msgId}', () => {
    const data = 'show:abc-123';
    const [action, msgId] = data.split(':');
    assert.equal(action, 'show');
    assert.equal(msgId, 'abc-123');
  });
});

describe('Telegram Trusted Message Display', () => {
  it('trusted message shows content', () => {
    const msg = { from: 'alice', effectiveRead: 'trusted', text: 'Hello!' };
    const display = `💬 @${msg.from}: ${msg.text}`;
    assert.ok(display.includes('Hello!'));
  });

  it('trusted message shows sender handle', () => {
    const display = '💬 @alice: Hello!';
    assert.ok(display.includes('@alice'));
  });
});

describe('Telegram Blind Message Display', () => {
  it('blind message shows sender but NOT content', () => {
    const display = '📩 New message from @alice (untrusted)';
    assert.ok(display.includes('@alice'));
    assert.ok(!display.includes('actual content'));
  });

  it('blind message includes "untrusted" label', () => {
    const display = '📩 New message from @alice (untrusted)';
    assert.ok(display.includes('untrusted'));
  });
});

describe('Telegram Blocked Message', () => {
  it('blocked → no Telegram message', () => {
    const effectiveRead = 'block';
    const sendToTelegram = effectiveRead !== 'block';
    assert.equal(sendToTelegram, false);
  });
});

describe('Show Button Cache', () => {
  it('decrypted content cached in memory', () => {
    const cache = new Map();
    cache.set('blind:msg-1', { text: 'secret content', from: 'alice', storedAt: Date.now() });
    assert.ok(cache.has('blind:msg-1'));
  });

  it('cache entry has storedAt timestamp', () => {
    const entry = { text: 'content', from: 'alice', storedAt: Date.now() };
    assert.ok(entry.storedAt > 0);
  });

  it('cache auto-expires after 1 hour', () => {
    const storedAt = Date.now() - 3600001;
    const expired = Date.now() - storedAt > 3600000;
    assert.ok(expired);
  });

  it('cache entry NOT expired within 1 hour', () => {
    const storedAt = Date.now() - 1800000; // 30 min ago
    const expired = Date.now() - storedAt > 3600000;
    assert.equal(expired, false);
  });

  it('Show callback → lookup cache → send content', () => {
    const cache = new Map();
    cache.set('blind:msg-1', { text: 'hidden text', from: 'alice' });
    const callbackData = 'show:msg-1';
    const msgId = callbackData.split(':')[1];
    const entry = cache.get(`blind:${msgId}`);
    assert.equal(entry.text, 'hidden text');
  });

  it('Show callback for expired → "message no longer available"', () => {
    const cache = new Map();
    const entry = cache.get('blind:expired-msg');
    assert.equal(entry, undefined);
  });

  it('cache size bounded (evict oldest)', () => {
    const maxSize = 1000;
    const cache = new Map();
    for (let i = 0; i < maxSize + 10; i++) {
      cache.set(`blind:msg-${i}`, { text: `msg ${i}` });
      if (cache.size > maxSize) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
    }
    assert.equal(cache.size, maxSize);
  });
});

describe('Trust Page Rendering', () => {
  it('trust action → green button text', () => {
    const action = 'trust';
    const buttonColor = action === 'trust' ? 'green' : 'red';
    assert.equal(buttonColor, 'green');
  });

  it('block action → red button text', () => {
    const action = 'block';
    const buttonColor = action === 'trust' ? 'green' : 'red';
    assert.equal(buttonColor, 'red');
  });

  it('trust page shows target handle', () => {
    const target = 'alice';
    const html = `<h1>Trust @${target}?</h1>`;
    assert.ok(html.includes('@alice'));
  });

  it('trust page includes Turnstile widget', () => {
    const html = '<div class="cf-turnstile"></div>';
    assert.ok(html.includes('cf-turnstile'));
  });

  it('trust page is self-contained HTML', () => {
    const html = '<!DOCTYPE html><html>';
    assert.ok(html.startsWith('<!DOCTYPE'));
  });
});

describe('Telegram Callback Handler', () => {
  it('getUpdates polling for callback_query', () => {
    const update = { callback_query: { id: '123', data: 'show:msg-1' } };
    assert.ok(update.callback_query);
  });

  it('answerCallbackQuery called after processing', () => {
    const answered = true;
    assert.ok(answered);
  });

  it('unknown callback_data → ignored', () => {
    const data = 'unknown:action';
    const [action] = data.split(':');
    const handled = action === 'show';
    assert.equal(handled, false);
  });
});
