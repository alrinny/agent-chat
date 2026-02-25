#!/usr/bin/env node
/**
 * Agent Chat v2 — CLI
 * Commands: register, send, status, contacts, handle-create, handle-permission, handle-join, handle-leave
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateEd25519KeyPair, generateX25519KeyPair,
  signMessage, encryptForRecipient
} from '../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../lib/auth.js';
import { loadConfig, getKeyPaths, DEFAULT_RELAY_URL, resolveKeysDir, resolveHandleDir, resolveDataDir } from '../lib/config.js';
import { addContact, removeContact, listContacts } from '../lib/contacts.js';
import { formatHandle, inferHandleType } from '../lib/format.js';

const KEYS_DIR = resolveKeysDir();
const DATA_DIR = resolveDataDir();
const RELAY = process.env.AGENT_CHAT_RELAY || DEFAULT_RELAY_URL;

const [,, command, ...args] = process.argv;

// --- Telegram echo (show outgoing messages in sender's Inbox thread) ---

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

async function sendEcho(handle, to, message, toType = 'personal') {
  const tg = loadTelegramEcho(handle);
  if (!tg) return;
  const text = `📤 <b>${escapeHtml(formatHandle(handle))} → ${escapeHtml(formatHandle(to, toType))}</b>:\n\n${escapeHtml(message)}`;
  const body = {
    chat_id: tg.chatId,
    text,
    parse_mode: 'HTML',
    disable_notification: true,
  };
  if (tg.threadId) body.message_thread_id = tg.threadId;
  try {
    await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch { /* silent — echo is best-effort */ }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Key helpers ---

function findConfigDir(handleHint) {
  if (handleHint) {
    return resolveHandleDir(handleHint);
  }
  // Auto-detect from keys directory
  try {
    const dirs = readdirSync(KEYS_DIR).filter(d => {
      const full = join(KEYS_DIR, d);
      return statSync(full).isDirectory() && existsSync(join(full, 'config.json'));
    });
    if (dirs.length === 0) { console.error('No handle found. Run setup.sh first.'); process.exit(1); }
    if (dirs.length > 1) { console.error(`Multiple handles found: ${dirs.join(', ')}. Set AGENT_CHAT_HANDLE env var.`); process.exit(1); }
    return join(KEYS_DIR, dirs[0]);
  } catch {
    console.error('Cannot read keys directory. Run setup.sh first.');
    process.exit(1);
  }
}

function loadKeysFromDir(configDir) {
  const paths = getKeyPaths(configDir);
  return {
    ed25519PublicKey: readFileSync(paths.ed25519PublicKey).toString('base64'),
    ed25519PrivateKey: readFileSync(paths.ed25519PrivateKey).toString('base64'),
    x25519PublicKey: readFileSync(paths.x25519PublicKey).toString('base64'),
    x25519PrivateKey: readFileSync(paths.x25519PrivateKey).toString('base64')
  };
}

// --- Handle + keys for authenticated commands ---

function resolveHandleAndKeys() {
  const handle = process.env.AGENT_CHAT_HANDLE || (() => {
    const dir = findConfigDir();
    return loadConfig(dir).handle;
  })();
  const configDir = findConfigDir(handle);
  const keys = loadKeysFromDir(configDir);
  return { handle, keys };
}

// --- Relay communication ---

async function relayPost(path, body, handle, ed25519PrivateKey) {
  const bodyStr = JSON.stringify(body);
  const headers = await buildPostHeaders(handle, bodyStr, ed25519PrivateKey);
  const res = await fetch(`${RELAY}${path}`, {
    method: 'POST',
    headers,
    body: bodyStr
  });
  return res.json();
}

async function relayGet(path, handle, ed25519PrivateKey) {
  const headers = await buildGetHeaders(handle, path, ed25519PrivateKey);
  const res = await fetch(`${RELAY}${path}`, { headers });
  return res.json();
}

// --- Response helpers ---

function checkRelay(result, context) {
  if (result.error) {
    console.error(`Error (${context}): ${result.error}`);
    process.exit(1);
  }
  return result;
}

function printOk(result, context) {
  if (result.error) {
    console.error(`Error (${context}): ${result.error}`);
    process.exit(1);
  }
  const extra = result.handle ? ` (${formatHandle(result.handle)})` : result.id ? ` [${result.id}]` : result.ids ? ` [${result.ids.length} sent]` : '';
  console.log(`✅ ${context}${extra}`);
  return result;
}

// --- Commands ---

if (!command) {
  console.error('Commands: register, send, status, contacts, handle-create, handle-permission, handle-join, handle-leave');
  process.exit(1);
}

try {

switch (command) {
  case 'register': {
    const handleName = args[0];
    if (!handleName) { console.error('Usage: send.js register <handle>'); process.exit(1); }

    const configDir = findConfigDir(handleName);
    const keys = loadKeysFromDir(configDir);

    // Self-sign registration
    const sig = await signMessage(`register:${handleName}`, keys.ed25519PrivateKey);
    const res = await fetch(`${RELAY}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: handleName,
        ed25519PublicKey: keys.ed25519PublicKey,
        x25519PublicKey: keys.x25519PublicKey,
        sig
      })
    });
    const regResult = await res.json();
    if (regResult.error) {
      // Don't exit — setup.sh handles 409 specially
      console.log(JSON.stringify(regResult));
    } else {
      printOk(regResult, 'Registered');
    }
    break;
  }

  case 'send': {
    const [to, ...messageParts] = args;
    const message = messageParts.join(' ');
    if (!to || !message) { console.error('Usage: send.js send <handle> "message"'); process.exit(1); }

    const { handle, keys } = resolveHandleAndKeys();

    // Get handle info (authenticated)
    const handleInfo = await relayGet(`/handle/info/${to}`, handle, keys.ed25519PrivateKey);
    const toType = inferHandleType(handleInfo);
    checkRelay(handleInfo, `lookup ${formatHandle(to, toType)}`);

    // DM = personal handle (owner === name)
    const isDM = handleInfo.owner === handleInfo.name;

    if (isDM) {
      const recipientPubKey = handleInfo.x25519PublicKey;
      if (!recipientPubKey) { console.error('Recipient has no X25519 public key'); process.exit(1); }

      const encrypted = await encryptForRecipient(message, recipientPubKey, keys.ed25519PrivateKey);
      const result = await relayPost('/send', {
        to,
        ciphertext: encrypted.ciphertext,
        ephemeralKey: encrypted.ephemeralKey,
        nonce: encrypted.nonce,
        senderSig: encrypted.senderSig,
        plaintextHash: encrypted.plaintextHash
      }, handle, keys.ed25519PrivateKey);
      printOk(result, `Sent to ${formatHandle(to)}`);
      await sendEcho(handle, to, message);
    } else {
      // Group: encrypt per reader
      if (!handleInfo.readers) { console.error('No readers — you may not have write access'); process.exit(1); }

      const ciphertexts = [];
      for (const reader of handleInfo.readers) {
        if (reader.handle === handle) continue; // skip self
        const encrypted = await encryptForRecipient(message, reader.x25519PublicKey, keys.ed25519PrivateKey);
        ciphertexts.push({
          recipient: reader.handle,
          ciphertext: encrypted.ciphertext,
          ephemeralKey: encrypted.ephemeralKey,
          nonce: encrypted.nonce,
          senderSig: encrypted.senderSig,
          plaintextHash: encrypted.plaintextHash
        });
      }
      if (ciphertexts.length === 0) { console.error('No readers to send to'); process.exit(1); }

      const result = await relayPost('/send', { to, ciphertexts }, handle, keys.ed25519PrivateKey);
      printOk(result, `Sent to ${formatHandle(to, toType)}`);
      await sendEcho(handle, to, message, toType);
    }
    break;
  }

  case 'status': {
    const { handle, keys } = resolveHandleAndKeys();

    console.log(`Handle: ${formatHandle(handle)}`);
    console.log(`Ed25519: ${keys.ed25519PublicKey.slice(0, 16)}...`);
    console.log(`X25519:  ${keys.x25519PublicKey.slice(0, 16)}...`);
    console.log(`Relay:   ${RELAY}`);
    break;
  }

  case 'handle-create': {
    const [name] = args;
    if (!name) { console.error('Usage: send.js handle-create <name> [--write allow|deny] [--read block|blind|trusted]'); process.exit(1); }
    const write = args.includes('--write') ? args[args.indexOf('--write') + 1] : 'deny';
    const read = args.includes('--read') ? args[args.indexOf('--read') + 1] : 'blind';

    const { handle, keys } = resolveHandleAndKeys();

    const result = await relayPost('/handle/create', { name, defaultWrite: write, defaultRead: read }, handle, keys.ed25519PrivateKey);
    printOk(result, `Created handle`);
    break;
  }

  case 'handle-permission': {
    const [hName, agent] = args;
    if (!hName || !agent) { console.error('Usage: send.js handle-permission <handle> <agent> [--write allow|deny] [--read block|blind|trusted]'); process.exit(1); }
    const write = args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined;
    const read = args.includes('--read') ? args[args.indexOf('--read') + 1] : undefined;

    const { handle, keys } = resolveHandleAndKeys();

    const body = { handle: hName, agent };
    if (write) body.ownerWrite = write;
    if (read) body.ownerRead = read;
    const result = await relayPost('/handle/permission', body, handle, keys.ed25519PrivateKey);
    printOk(result, `Permission updated`);
    break;
  }

  case 'handle-join': {
    if (!args[0]) { console.error('Usage: send.js handle-join <handle>'); process.exit(1); }
    const { handle, keys } = resolveHandleAndKeys();
    const result = await relayPost('/handle/join', { handle: args[0] }, handle, keys.ed25519PrivateKey);
    printOk(result, `Joined handle`);
    break;
  }

  case 'handle-leave': {
    if (!args[0]) { console.error('Usage: send.js handle-leave <handle>'); process.exit(1); }
    const { handle, keys } = resolveHandleAndKeys();
    const result = await relayPost('/handle/leave', { handle: args[0] }, handle, keys.ed25519PrivateKey);
    printOk(result, `Left handle`);
    break;
  }

  case 'contacts': {
    const [subCmd, ...subArgs] = args;

    switch (subCmd) {
      case 'add': {
        const [cHandle, ...labelParts] = subArgs;
        const label = labelParts.join(' ');
        if (!cHandle || !label) { console.error('Usage: send.js contacts add <handle> <label>'); process.exit(1); }
        addContact(null, cHandle, label);
        console.log(`Added ${formatHandle(cHandle)} → "${label}"`);
        break;
      }
      case 'remove': {
        if (!subArgs[0]) { console.error('Usage: send.js contacts remove <handle>'); process.exit(1); }
        const existed = removeContact(null, subArgs[0]);
        console.log(existed ? `Removed ${formatHandle(subArgs[0])}` : `${formatHandle(subArgs[0])} not found`);
        break;
      }
      case 'list': {
        const contacts = listContacts(null);
        if (contacts.length === 0) { console.log('No contacts'); break; }
        for (const c of contacts) {
          console.log(`${formatHandle(c.handle)} → "${c.label}"${c.notes ? ` (${c.notes})` : ''}`);
        }
        break;
      }
      default:
        console.error('Usage: send.js contacts <add|remove|list>');
        process.exit(1);
    }
    break;
  }

  case 'unregister': {
    const { handle: unreg, keys: unregKeys } = resolveHandleAndKeys();
    const pubKeyB64 = unregKeys.ed25519PublicKey;
    const message = `unregister:${unreg}`;
    const sig = await signMessage(message, unregKeys.ed25519PrivateKey);
    const res = await fetch(`${RELAY}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: unreg, ed25519PublicKey: pubKeyB64, sig }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`✅ Unregistered ${formatHandle(unreg)}`);
    } else {
      console.error(`❌ Unregister failed: ${data.error || res.statusText}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Commands: register, send, status, contacts, unregister, handle-create, handle-permission, handle-join, handle-leave');
    process.exit(1);
}

} catch (err) {
  // Network errors: provide human-readable messages instead of stack traces
  const cause = err.cause?.message || err.cause?.code || '';
  if (err.name === 'TimeoutError') {
    console.error(`Error: Connection to relay timed out (${RELAY})`);
  } else if (cause.includes('ECONNREFUSED') || cause.includes('connect')) {
    console.error(`Error: Cannot connect to relay at ${RELAY}`);
  } else if (cause.includes('ENOTFOUND') || cause.includes('getaddrinfo')) {
    console.error(`Error: Cannot resolve relay hostname (${RELAY})`);
  } else if (err.message === 'fetch failed') {
    console.error(`Error: Cannot reach relay at ${RELAY}${cause ? ' — ' + cause : ''}`);
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
}
