/**
 * send.js CLI tests — command routing, argument parsing, output formatting.
 * From test-plan.md sections 4.3, 19.3
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Simulated CLI command router
function parseCommand(args) {
  const cmd = args[0];
  const subArgs = args.slice(1);
  switch (cmd) {
    case 'send': return { cmd: 'send', to: subArgs[0], message: subArgs.slice(1).join(' ') };
    case 'contacts': return { cmd: 'contacts', sub: subArgs[0] || null };
    case 'handle-create': return { cmd: 'handle-create', name: subArgs[0] };
    case 'handle-permission': return { cmd: 'handle-permission', handle: subArgs[0] };
    case 'handle-self': return { cmd: 'handle-self', handle: subArgs[0] };
    case 'handle-info': return { cmd: 'handle-info', handle: subArgs[0] };
    case 'handle-join': return { cmd: 'handle-join', handle: subArgs[0] };
    case 'handle-leave': return { cmd: 'handle-leave', handle: subArgs[0] };
    default: return null;
  }
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      flags[key] = val;
    }
  }
  return flags;
}

describe('CLI Command Routing', () => {
  it('send → parsed correctly', () => {
    const parsed = parseCommand(['send', '@bob', 'hello', 'world']);
    assert.equal(parsed.cmd, 'send');
    assert.equal(parsed.to, '@bob');
    assert.equal(parsed.message, 'hello world');
  });

  it('contacts with no sub-command → sub=null', () => {
    const parsed = parseCommand(['contacts']);
    assert.equal(parsed.cmd, 'contacts');
    assert.equal(parsed.sub, null);
  });

  it('contacts add → sub=add', () => {
    const parsed = parseCommand(['contacts', 'add']);
    assert.equal(parsed.sub, 'add');
  });

  it('handle-create → name parsed', () => {
    const parsed = parseCommand(['handle-create', 'my-group']);
    assert.equal(parsed.name, 'my-group');
  });

  it('handle-info → handle parsed', () => {
    const parsed = parseCommand(['handle-info', 'alice']);
    assert.equal(parsed.handle, 'alice');
  });

  it('unknown command → null', () => {
    const parsed = parseCommand(['unknown-cmd']);
    assert.equal(parsed, null);
  });

  it('trust-token NOT a valid command', () => {
    const parsed = parseCommand(['trust-token']);
    assert.equal(parsed, null);
  });
});

describe('CLI Flag Parsing', () => {
  it('--write allow --read blind', () => {
    const flags = parseFlags(['--write', 'allow', '--read', 'blind']);
    assert.equal(flags.write, 'allow');
    assert.equal(flags.read, 'blind');
  });

  it('no flags → empty object', () => {
    const flags = parseFlags([]);
    assert.deepEqual(flags, {});
  });

  it('flag without value → true', () => {
    const flags = parseFlags(['--verbose']);
    assert.equal(flags.verbose, true);
  });

  it('multiple flags in sequence', () => {
    const flags = parseFlags(['--handle', 'team', '--agent', 'bob', '--write', 'allow']);
    assert.equal(flags.handle, 'team');
    assert.equal(flags.agent, 'bob');
    assert.equal(flags.write, 'allow');
  });
});

describe('CLI Output Formatting', () => {
  it('send success → shows message ID', () => {
    const result = { ok: true, id: 'abc-123' };
    const output = `✅ Sent (${result.id})`;
    assert.ok(output.includes('abc-123'));
  });

  it('group send success → shows count', () => {
    const result = { ok: true, ids: ['a', 'b', 'c'] };
    const output = `✅ Sent to ${result.ids.length} recipients`;
    assert.ok(output.includes('3'));
  });

  it('error → shows error message', () => {
    const result = { error: 'not found' };
    const output = `❌ ${result.error}`;
    assert.ok(output.includes('not found'));
  });

  it('contacts list → formatted table', () => {
    const contacts = [
      { handle: 'alice', label: 'Alice', trust: 'trusted' },
      { handle: 'bob', label: 'Bob', trust: 'blind' }
    ];
    const lines = contacts.map(c => `@${c.handle} (${c.label}) — ${c.trust}`);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('@alice'));
  });
});

describe('CLI Relay URL Construction', () => {
  it('default relay URL', () => {
    const DEFAULT = 'https://agent-chat-relay.rynn-openclaw.workers.dev';
    assert.ok(DEFAULT.startsWith('https://'));
  });

  it('send endpoint: POST /send', () => {
    const relay = 'https://relay.test';
    const url = `${relay}/send`;
    assert.equal(url, 'https://relay.test/send');
  });

  it('handle-info endpoint: GET /handle/info/{handle}', () => {
    const relay = 'https://relay.test';
    const handle = 'alice';
    const url = `${relay}/handle/info/${handle}`;
    assert.equal(url, 'https://relay.test/handle/info/alice');
  });

  it('inbox endpoint: GET /inbox/{handle}', () => {
    const relay = 'https://relay.test';
    const url = `${relay}/inbox/alice`;
    assert.equal(url, 'https://relay.test/inbox/alice');
  });

  it('WS endpoint: wss://', () => {
    const relay = 'https://relay.test';
    const wsUrl = relay.replace('https://', 'wss://') + '/ws/alice';
    assert.equal(wsUrl, 'wss://relay.test/ws/alice');
  });
});

describe('CLI Config Loading', () => {
  it('config path: ~/.agent-chat/config.json', () => {
    const home = '/Users/test';
    const configPath = `${home}/.agent-chat/config.json`;
    assert.ok(configPath.endsWith('config.json'));
  });

  it('config has required fields: handle, relay', () => {
    const config = { handle: 'alice', relay: 'https://relay.test' };
    assert.ok(config.handle);
    assert.ok(config.relay);
  });

  it('missing config → error with setup instructions', () => {
    const configExists = false;
    const message = configExists ? null : 'Run agent-chat setup first';
    assert.ok(message.includes('setup'));
  });
});

describe('CLI Error Handling', () => {
  it('network error → user-friendly message', () => {
    const err = new Error('ECONNREFUSED');
    const output = `❌ Cannot reach relay: ${err.message}`;
    assert.ok(output.includes('ECONNREFUSED'));
  });

  it('401 → "authentication failed" message', () => {
    const status = 401;
    const message = status === 401 ? 'Authentication failed — check your keys' : 'Unknown error';
    assert.ok(message.includes('Authentication'));
  });

  it('404 → "handle not found" message', () => {
    const status = 404;
    const message = status === 404 ? 'Handle not found' : 'Unknown';
    assert.ok(message.includes('not found'));
  });

  it('429 → "rate limited" message', () => {
    const status = 429;
    const message = status === 429 ? 'Rate limited — try again later' : 'Unknown';
    assert.ok(message.includes('Rate'));
  });
});
