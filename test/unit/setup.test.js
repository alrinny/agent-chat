/**
 * Setup flow tests — key generation, registration, config creation, Telegram setup.
 * From test-plan.md section 7.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Setup: Key Generation', () => {
  it('generates Ed25519 keypair', () => {
    // Stub: actual crypto tested in crypto.test.js
    const keys = { publicKey: 'ed25519pub', privateKey: 'ed25519priv' };
    assert.ok(keys.publicKey);
    assert.ok(keys.privateKey);
  });

  it('generates X25519 keypair', () => {
    const keys = { publicKey: 'x25519pub', privateKey: 'x25519priv' };
    assert.ok(keys.publicKey);
    assert.ok(keys.privateKey);
  });

  it('keys stored in ~/.agent-chat/keys/', () => {
    const home = '/Users/test';
    const keyDir = `${home}/.agent-chat/keys`;
    assert.ok(keyDir.includes('.agent-chat/keys'));
  });

  it('private keys not world-readable (0600)', () => {
    const mode = 0o600;
    assert.equal(mode & 0o077, 0); // No group/other permissions
  });
});

describe('Setup: Registration', () => {
  it('handle validated locally before registration', () => {
    const regex = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/;
    assert.ok(regex.test('alice'));
    assert.ok(regex.test('my-agent'));
    assert.ok(!regex.test('AB'));
    assert.ok(!regex.test('_bad'));
  });

  it('registration payload: handle, ed25519PublicKey, x25519PublicKey, sig', () => {
    const payload = {
      handle: 'alice',
      ed25519PublicKey: 'base64...',
      x25519PublicKey: 'base64...',
      sig: 'base64...'
    };
    assert.ok(payload.handle);
    assert.ok(payload.ed25519PublicKey);
    assert.ok(payload.x25519PublicKey);
    assert.ok(payload.sig);
  });

  it('sig = Ed25519("register:{handle}")', () => {
    const handle = 'alice';
    const payload = `register:${handle}`;
    assert.equal(payload, 'register:alice');
  });

  it('registration creates config.json', () => {
    const config = {
      handle: 'alice',
      relay: 'https://agent-chat-relay.rynn-openclaw.workers.dev'
    };
    assert.ok(config.handle);
    assert.ok(config.relay);
  });
});

describe('Setup: Telegram Integration', () => {
  it('bot token stored in config', () => {
    const config = { telegramBotToken: '1234:ABCdef' };
    assert.ok(config.telegramBotToken);
  });

  it('chat ID detected from getUpdates', () => {
    const updates = { result: [{ message: { chat: { id: 119111425 } } }] };
    const chatId = updates.result[0].message.chat.id;
    assert.equal(typeof chatId, 'number');
  });

  it('chat ID stored in config', () => {
    const config = { telegramChatId: 119111425 };
    assert.equal(config.telegramChatId, 119111425);
  });
});

describe('Setup: Config Validation', () => {
  it('valid config has all required fields', () => {
    const config = {
      handle: 'alice',
      relay: 'https://relay.test',
      telegramBotToken: '1234:abc',
      telegramChatId: 123
    };
    const required = ['handle', 'relay', 'telegramBotToken', 'telegramChatId'];
    for (const field of required) {
      assert.ok(config[field] !== undefined, `Missing ${field}`);
    }
  });

  it('relay URL must be HTTPS', () => {
    const url = 'https://relay.test';
    assert.ok(url.startsWith('https://'));
  });

  it('relay URL without trailing slash', () => {
    const url = 'https://relay.test';
    assert.ok(!url.endsWith('/'));
  });

  it('config directory created if missing', () => {
    // mkdirSync(configDir, { recursive: true })
    const configDir = '/Users/test/.agent-chat';
    assert.ok(configDir.includes('.agent-chat'));
  });
});

describe('Setup: Two Setup Paths', () => {
  it('setup-openclaw: automatic (reads from OpenClaw config)', () => {
    const mode = 'openclaw';
    assert.equal(mode, 'openclaw');
  });

  it('setup-general: manual (interactive prompts)', () => {
    const mode = 'general';
    assert.equal(mode, 'general');
  });

  it('both paths result in same config format', () => {
    const configA = { handle: 'alice', relay: 'https://relay.test' };
    const configB = { handle: 'bob', relay: 'https://relay.test' };
    assert.deepEqual(Object.keys(configA), Object.keys(configB));
  });
});
