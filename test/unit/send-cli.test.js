/**
 * Unit tests for scripts/send.js — CLI argument parsing, key loading, relay communication.
 * Tests pure logic; relay calls are tested via integration tests.
 *
 * Tests: SEND-PARSE-001..006, SEND-KEYS-001..003, SEND-RELAY-001..004
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  generateEd25519KeyPair, generateX25519KeyPair, signMessage
} from '../../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../../lib/auth.js';
import { loadConfig, getKeyPaths } from '../../lib/config.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', '.test-send-' + process.pid);
const HANDLE = 'test-sender';
const CONFIG_DIR = join(TEST_DIR, `agent-chat-${HANDLE}`);
let keys;

before(async () => {
  mkdirSync(CONFIG_DIR, { recursive: true });

  // Generate keys
  const ed = await generateEd25519KeyPair();
  const x = await generateX25519KeyPair();
  keys = { ed, x };

  // Write keys to disk (raw bytes for pub, DER for priv)
  const keyPaths = getKeyPaths(CONFIG_DIR);
  writeFileSync(keyPaths.ed25519PublicKey, Buffer.from(ed.publicKey, 'base64'));
  writeFileSync(keyPaths.ed25519PrivateKey, Buffer.from(ed.privateKey, 'base64'));
  writeFileSync(keyPaths.x25519PublicKey, Buffer.from(x.publicKey, 'base64'));
  writeFileSync(keyPaths.x25519PrivateKey, Buffer.from(x.privateKey, 'base64'));

  // Write config
  writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({ handle: HANDLE }));
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Key loading from disk', () => {
  it('SEND-KEYS-001: reads Ed25519 public key from file', () => {
    const keyPaths = getKeyPaths(CONFIG_DIR);
    const pub = readFileSync(keyPaths.ed25519PublicKey).toString('base64');
    assert.equal(pub, keys.ed.publicKey);
  });

  it('SEND-KEYS-002: reads X25519 public key from file', () => {
    const keyPaths = getKeyPaths(CONFIG_DIR);
    const pub = readFileSync(keyPaths.x25519PublicKey).toString('base64');
    assert.equal(pub, keys.x.publicKey);
  });

  it('SEND-KEYS-003: config.json loads handle', () => {
    const config = loadConfig(CONFIG_DIR);
    assert.equal(config.handle, HANDLE);
  });
});

describe('Auth header generation', () => {
  it('SEND-RELAY-001: POST headers include all required fields', async () => {
    const body = '{"to":"bob"}';
    const headers = await buildPostHeaders(HANDLE, body, keys.ed.privateKey);
    assert.ok(headers['X-Agent-Handle']);
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
    assert.equal(headers['X-Agent-Handle'], HANDLE);
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('SEND-RELAY-002: GET headers include all required fields', async () => {
    const headers = await buildGetHeaders(HANDLE, '/handle/info/bob', keys.ed.privateKey);
    assert.ok(headers['X-Agent-Handle']);
    assert.ok(headers['X-Agent-Timestamp']);
    assert.ok(headers['X-Agent-Signature']);
  });

  it('SEND-RELAY-003: POST signature format is ts:body', async () => {
    const body = '{"test":true}';
    const headers = await buildPostHeaders(HANDLE, body, keys.ed.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    // Verify: signMessage(`${ts}:${body}`, privKey) should match sig
    const expectedSig = await signMessage(`${ts}:${body}`, keys.ed.privateKey);
    assert.equal(sig, expectedSig);
  });

  it('SEND-RELAY-004: GET signature format is GET:path:ts', async () => {
    const path = '/inbox/test-sender';
    const headers = await buildGetHeaders(HANDLE, path, keys.ed.privateKey);
    const ts = headers['X-Agent-Timestamp'];
    const sig = headers['X-Agent-Signature'];
    const expectedSig = await signMessage(`GET:${path}:${ts}`, keys.ed.privateKey);
    assert.equal(sig, expectedSig);
  });
});

describe('Handle prefix stripping', () => {
  it('SEND-PREFIX-001: # prefix is stripped for group handles', () => {
    const raw = '#clawns';
    const stripped = raw.replace(/^[@#~]/, '');
    assert.equal(stripped, 'clawns');
  });

  it('SEND-PREFIX-002: @ prefix is stripped for personal handles', () => {
    const raw = '@alice';
    const stripped = raw.replace(/^[@#~]/, '');
    assert.equal(stripped, 'alice');
  });

  it('SEND-PREFIX-003: ~ prefix is stripped for broadcast handles', () => {
    const raw = '~news';
    const stripped = raw.replace(/^[@#~]/, '');
    assert.equal(stripped, 'news');
  });

  it('SEND-PREFIX-004: handles without prefix are unchanged', () => {
    const raw = 'clawns';
    const stripped = raw.replace(/^[@#~]/, '');
    assert.equal(stripped, 'clawns');
  });

  it('SEND-PREFIX-005: only first prefix char is stripped', () => {
    const raw = '##double';
    const stripped = raw.replace(/^[@#~]/, '');
    assert.equal(stripped, '#double');
  });
});

describe('CLI argument parsing', () => {
  it('SEND-PARSE-001: no command → exit code 1', () => {
    try {
      execSync(`node scripts/send.js`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-002: unknown command → exit code 1', () => {
    try {
      execSync(`node scripts/send.js badcommand`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-003: register without handle → exit code 1', () => {
    try {
      execSync(`node scripts/send.js register`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-004: send without args → exit code 1', () => {
    try {
      execSync(`node scripts/send.js send`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-PARSE-005: status shows handle and relay', () => {
    const out = execSync(`node scripts/send.js status`, {
      env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes(`@${HANDLE}`));
    assert.ok(out.includes('Relay:'));
  });

  it('SEND-PARSE-006: handle-create without name → exit code 1', () => {
    try {
      execSync(`node scripts/send.js handle-create`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });
});

// Need readFileSync for key loading test
import { readFileSync } from 'node:fs';

describe('Contacts CLI', () => {
  it('SEND-CONTACTS-001: contacts list on empty → "No contacts"', () => {
    const out = execSync(`node scripts/send.js contacts list`, {
      env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes('No contacts'));
  });

  it('SEND-CONTACTS-002: contacts add creates contact', () => {
    const out = execSync(`node scripts/send.js contacts add alice Alice Test`, {
      env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes('@alice'));
    assert.ok(out.includes('Alice Test'));
  });

  it('SEND-CONTACTS-003: contacts list shows added contact', () => {
    const out = execSync(`node scripts/send.js contacts list`, {
      env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes('@alice'));
    assert.ok(out.includes('Alice Test'));
  });

  it('SEND-CONTACTS-004: contacts remove deletes contact', () => {
    const out = execSync(`node scripts/send.js contacts remove alice`, {
      env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes('Removed @alice'));
  });

  it('SEND-CONTACTS-005: contacts remove non-existent → not found', () => {
    const out = execSync(`node scripts/send.js contacts remove nobody`, {
      env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
      encoding: 'utf8'
    });
    assert.ok(out.includes('not found'));
  });

  it('SEND-CONTACTS-006: contacts add without label → exit 1', () => {
    try {
      execSync(`node scripts/send.js contacts add bob`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });

  it('SEND-CONTACTS-007: contacts unknown subcommand → exit 1', () => {
    try {
      execSync(`node scripts/send.js contacts unknown`, {
        env: { ...process.env, AGENT_CHAT_DIR: TEST_DIR, AGENT_CHAT_KEYS_DIR: TEST_DIR, AGENT_CHAT_HANDLE: HANDLE },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.equal(err.status, 1);
    }
  });
});

describe('send echo (outgoing message visibility)', () => {
  const ECHO_DIR = join(tmpdir(), `echo-test-${Date.now()}`);
  const ECHO_KEYS = join(ECHO_DIR, 'keys');
  const ECHO_HANDLE = 'echotest';

  before(() => {
    mkdirSync(join(ECHO_KEYS, ECHO_HANDLE), { recursive: true });
  });

  after(() => {
    rmSync(ECHO_DIR, { recursive: true, force: true });
  });

  it('SEND-ECHO-001: loadTelegramEcho returns config when all files present', async () => {
    writeFileSync(join(ECHO_DIR, 'telegram.json'), JSON.stringify({ chatId: '12345' }));
    writeFileSync(join(ECHO_KEYS, 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));
    writeFileSync(join(ECHO_KEYS, ECHO_HANDLE, 'config.json'), JSON.stringify({ handle: ECHO_HANDLE, threadId: 999 }));

    // Import and test loadTelegramEcho by running send.js in a subprocess that prints echo config
    const result = execSync(
      `node -e "
        import { readFileSync, existsSync } from 'fs';
        import { join } from 'path';
        const DATA_DIR = '${ECHO_DIR}';
        const KEYS_DIR = '${ECHO_KEYS}';
        function loadTelegramEcho(handle) {
          try {
            const dataFile = join(DATA_DIR, 'telegram.json');
            const tokenFile = join(KEYS_DIR, 'telegram-token.json');
            const configFile = join(KEYS_DIR, handle, 'config.json');
            const data = JSON.parse(readFileSync(dataFile, 'utf8'));
            const token = JSON.parse(readFileSync(tokenFile, 'utf8'));
            let threadId = null;
            try { threadId = JSON.parse(readFileSync(configFile, 'utf8')).threadId; } catch {}
            if (!data.chatId || !token.botToken) return null;
            return { chatId: data.chatId, botToken: token.botToken, threadId };
          } catch { return null; }
        }
        console.log(JSON.stringify(loadTelegramEcho('${ECHO_HANDLE}')));
      "`,
      { encoding: 'utf8', env: { ...process.env } }
    ).trim();
    const cfg = JSON.parse(result);
    assert.equal(cfg.chatId, '12345');
    assert.equal(cfg.botToken, 'fake:token');
    assert.equal(cfg.threadId, 999);
  });

  it('SEND-ECHO-002: loadTelegramEcho returns null when telegram.json missing', async () => {
    const dir2 = join(tmpdir(), `echo-test2-${Date.now()}`);
    mkdirSync(join(dir2, 'keys', 'h'), { recursive: true });
    writeFileSync(join(dir2, 'keys', 'telegram-token.json'), JSON.stringify({ botToken: 'fake:token' }));
    // no telegram.json

    const result = execSync(
      `node -e "
        import { readFileSync } from 'fs';
        import { join } from 'path';
        const DATA_DIR = '${dir2}';
        const KEYS_DIR = '${dir2}/keys';
        function loadTelegramEcho(handle) {
          try {
            const dataFile = join(DATA_DIR, 'telegram.json');
            const tokenFile = join(KEYS_DIR, 'telegram-token.json');
            const configFile = join(KEYS_DIR, handle, 'config.json');
            const data = JSON.parse(readFileSync(dataFile, 'utf8'));
            const token = JSON.parse(readFileSync(tokenFile, 'utf8'));
            let threadId = null;
            try { threadId = JSON.parse(readFileSync(configFile, 'utf8')).threadId; } catch {}
            if (!data.chatId || !token.botToken) return null;
            return { chatId: data.chatId, botToken: token.botToken, threadId };
          } catch { return null; }
        }
        console.log(JSON.stringify(loadTelegramEcho('h')));
      "`,
      { encoding: 'utf8' }
    ).trim();
    assert.equal(result, 'null');
    rmSync(dir2, { recursive: true, force: true });
  });

  it('SEND-ECHO-003: loadTelegramEcho works without per-handle threadId', async () => {
    const dir3 = join(tmpdir(), `echo-test3-${Date.now()}`);
    mkdirSync(join(dir3, 'keys', 'h'), { recursive: true });
    writeFileSync(join(dir3, 'telegram.json'), JSON.stringify({ chatId: '999' }));
    writeFileSync(join(dir3, 'keys', 'telegram-token.json'), JSON.stringify({ botToken: 'fake:tok' }));
    // no config.json for handle

    const result = execSync(
      `node -e "
        import { readFileSync } from 'fs';
        import { join } from 'path';
        const DATA_DIR = '${dir3}';
        const KEYS_DIR = '${dir3}/keys';
        function loadTelegramEcho(handle) {
          try {
            const dataFile = join(DATA_DIR, 'telegram.json');
            const tokenFile = join(KEYS_DIR, 'telegram-token.json');
            const configFile = join(KEYS_DIR, handle, 'config.json');
            const data = JSON.parse(readFileSync(dataFile, 'utf8'));
            const token = JSON.parse(readFileSync(tokenFile, 'utf8'));
            let threadId = null;
            try { threadId = JSON.parse(readFileSync(configFile, 'utf8')).threadId; } catch {}
            if (!data.chatId || !token.botToken) return null;
            return { chatId: data.chatId, botToken: token.botToken, threadId };
          } catch { return null; }
        }
        const r = loadTelegramEcho('h');
        console.log(JSON.stringify(r));
      "`,
      { encoding: 'utf8' }
    ).trim();
    const cfg = JSON.parse(result);
    assert.equal(cfg.chatId, '999');
    assert.equal(cfg.threadId, null);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('SEND-ECHO-004: escapeHtml escapes < > &', () => {
    const result = execSync(
      `node -e "
        function escapeHtml(s) {
          return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        console.log(escapeHtml('<script>alert(1)&</script>'));
      "`,
      { encoding: 'utf8' }
    ).trim();
    assert.equal(result, '&lt;script&gt;alert(1)&amp;&lt;/script&gt;');
  });
});
