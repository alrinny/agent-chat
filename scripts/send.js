#!/usr/bin/env node
/**
 * Agent Chat v2 — CLI
 * Commands: register, send, status, handle-create, handle-permission, handle-join, handle-leave
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateEd25519KeyPair, generateX25519KeyPair,
  signMessage, encryptForRecipient
} from '../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../lib/auth.js';
import { loadConfig, getKeyPaths, DEFAULT_RELAY_URL } from '../lib/config.js';

const SECRETS_DIR = process.env.AGENT_SECRETS_DIR || join(process.env.HOME, '.openclaw', 'secrets');
const RELAY = process.env.AGENT_CHAT_RELAY || DEFAULT_RELAY_URL;

const [,, command, ...args] = process.argv;

// --- Key helpers ---

function findConfigDir(handleHint) {
  if (handleHint) {
    const dir = join(SECRETS_DIR, `agent-chat-${handleHint}`);
    return dir;
  }
  // Auto-detect from secrets directory
  try {
    const dirs = readdirSync(SECRETS_DIR).filter(d =>
      d.startsWith('agent-chat-') && statSync(join(SECRETS_DIR, d)).isDirectory()
    );
    if (dirs.length === 0) { console.error('No handle found. Run setup.sh first.'); process.exit(1); }
    if (dirs.length > 1) { console.error(`Multiple handles found: ${dirs.map(d => d.replace('agent-chat-', '')).join(', ')}. Set AGENT_CHAT_HANDLE.`); process.exit(1); }
    return join(SECRETS_DIR, dirs[0]);
  } catch {
    console.error('Cannot read secrets directory. Run setup.sh first.');
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

// --- Commands ---

if (!command) {
  console.error('Commands: register, send, status, handle-create, handle-permission, handle-join, handle-leave');
  process.exit(1);
}

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
    console.log(JSON.stringify(await res.json()));
    break;
  }

  case 'send': {
    const [to, ...messageParts] = args;
    const message = messageParts.join(' ');
    if (!to || !message) { console.error('Usage: send.js send <handle> "message"'); process.exit(1); }

    const { handle, keys } = resolveHandleAndKeys();

    // Get handle info (authenticated)
    const handleInfo = await relayGet(`/handle/info/${to}`, handle, keys.ed25519PrivateKey);
    if (handleInfo.error) { console.error(handleInfo.error); process.exit(1); }

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
      console.log(JSON.stringify(result));
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
      console.log(JSON.stringify(result));
    }
    break;
  }

  case 'status': {
    const { handle, keys } = resolveHandleAndKeys();

    console.log(`Handle: @${handle}`);
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
    console.log(JSON.stringify(result));
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
    console.log(JSON.stringify(result));
    break;
  }

  case 'handle-join': {
    if (!args[0]) { console.error('Usage: send.js handle-join <handle>'); process.exit(1); }
    const { handle, keys } = resolveHandleAndKeys();
    const result = await relayPost('/handle/join', { handle: args[0] }, handle, keys.ed25519PrivateKey);
    console.log(JSON.stringify(result));
    break;
  }

  case 'handle-leave': {
    if (!args[0]) { console.error('Usage: send.js handle-leave <handle>'); process.exit(1); }
    const { handle, keys } = resolveHandleAndKeys();
    const result = await relayPost('/handle/leave', { handle: args[0] }, handle, keys.ed25519PrivateKey);
    console.log(JSON.stringify(result));
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Commands: register, send, status, handle-create, handle-permission, handle-join, handle-leave');
    process.exit(1);
}
