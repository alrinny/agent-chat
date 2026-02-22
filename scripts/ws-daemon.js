#!/usr/bin/env node
/**
 * Agent Chat v2 — WebSocket daemon
 * Maintains a persistent connection to the relay, decrypts messages,
 * runs guardrail scans, and delivers to the AI (or human for blind messages).
 *
 * Usage: ws-daemon.js <handle>
 * Env: AGENT_CHAT_RELAY, AGENT_SECRETS_DIR, AGENT_DELIVER_CMD, LAKERA_GUARD_KEY
 */

import {
  signMessage, verifySignature, decryptFromSender
} from '../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../lib/auth.js';
import { loadConfig, getKeyPaths, DEFAULT_RELAY_URL } from '../lib/config.js';
import { loadContacts } from '../lib/contacts.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const handle = process.argv[2] || process.env.AGENT_CHAT_HANDLE;

const RELAY = process.env.AGENT_CHAT_RELAY || DEFAULT_RELAY_URL;
const RELAY_WS = RELAY.replace('https://', 'wss://').replace('http://', 'ws://');
const SECRETS_DIR = process.env.AGENT_SECRETS_DIR || join(process.env.HOME, '.openclaw', 'secrets');
const DELIVER_CMD = process.env.AGENT_DELIVER_CMD;
const LAKERA_KEY = process.env.LAKERA_GUARD_KEY;

const CONFIG_DIR = handle ? join(SECRETS_DIR, `agent-chat-${handle}`) : null;

// Load keys once at startup (deferred for testability)
function loadKeys() {
  if (!CONFIG_DIR) return null;
  const paths = getKeyPaths(CONFIG_DIR);
  return {
    ed25519PublicKey: readFileSync(paths.ed25519PublicKey).toString('base64'),
    ed25519PrivateKey: readFileSync(paths.ed25519PrivateKey).toString('base64'),
    x25519PublicKey: readFileSync(paths.x25519PublicKey).toString('base64'),
    x25519PrivateKey: readFileSync(paths.x25519PrivateKey).toString('base64')
  };
}

// Only load keys when running as daemon (not when imported for testing)
let keys = null;

// --- In-memory state ---

// Cache for "Show me" blind messages (daemon-local, not persisted)
const blindMessageCache = new Map();  // callbackId → { text, from, ts }

// Deduplication: track processed message IDs to avoid duplicate notifications
const processedMessageIds = new Set();  // "msgId:effectiveRead" → processed

// --- Telegram config ---

function loadTelegramConfig() {
  const cfgFile = join(SECRETS_DIR, 'agent-chat-telegram.json');
  if (!existsSync(cfgFile)) return null;
  try {
    return JSON.parse(readFileSync(cfgFile, 'utf8'));
  } catch { return null; }
}

// --- Relay communication ---

async function relayGet(path) {
  const headers = await buildGetHeaders(handle, path, keys.ed25519PrivateKey);
  const res = await fetch(`${RELAY}${path}`, { headers });
  return res.json();
}

async function relayPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const headers = await buildPostHeaders(handle, bodyStr, keys.ed25519PrivateKey);
  const res = await fetch(`${RELAY}${path}`, { method: 'POST', headers, body: bodyStr });
  return res.json();
}

// --- Guardrail ---

async function scanGuardrail(text) {
  if (LAKERA_KEY) {
    // Local scan — plaintext never leaves this machine
    try {
      const res = await fetch('https://api.lakera.ai/v2/guard', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${LAKERA_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
      });
      return await res.json();
    } catch (err) {
      console.error('Local guardrail error:', err);
      return { flagged: true, error: true };
    }
  }

  // Relay scan fallback
  try {
    return await relayPost('/guardrail/scan', { text });
  } catch (err) {
    console.error('Relay guardrail error:', err);
    return { flagged: true, error: true };  // fail-safe
  }
}

// --- Delivery ---

async function sendTelegram(text, buttons = null) {
  const tg = loadTelegramConfig();
  if (!tg) return deliverFallback(text);

  const payload = { chat_id: tg.chatId, text, parse_mode: 'HTML' };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };

  try {
    await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Telegram sendMessage error:', err);
    deliverFallback(text);
  }
}

function deliverFallback(text) {
  if (DELIVER_CMD) {
    // SECURITY: pass text via env var, NOT shell interpolation
    execFileSync(DELIVER_CMD, [], { stdio: 'inherit', env: { ...process.env, AGENT_MSG: text } });
  } else {
    console.log('[INBOX]', text);
  }
}

async function deliverToAI(text) {
  if (DELIVER_CMD) {
    // SECURITY: pass text via env var, NOT shell interpolation
    execFileSync(DELIVER_CMD, [], { stdio: 'inherit', env: { ...process.env, AGENT_MSG: text } });
  } else {
    try {
      execFileSync('openclaw', ['message', 'send', '--message', text], { stdio: 'inherit' });
    } catch {
      console.log('[DELIVER]', text);
    }
  }
}

// --- Message handling ---

async function handleMessage(msg) {
  const contacts = CONFIG_DIR ? loadContacts(CONFIG_DIR) : {};
  const contactLabel = contacts[msg.from]?.label || msg.from;

  if (msg.type === 'message') {
    // Dedup: skip if already processed at SAME trust level
    // Redeliver sends same ID with UPGRADED effectiveRead → must process again
    const dedupKey = `${msg.id}:${msg.effectiveRead}`;
    if (msg.id && processedMessageIds.has(dedupKey)) return;
    if (msg.id) {
      processedMessageIds.add(dedupKey);
      // Prevent unbounded growth — keep last 10000 entries
      if (processedMessageIds.size > 10000) {
        const iter = processedMessageIds.values();
        for (let i = 0; i < 5000; i++) {
          processedMessageIds.delete(iter.next().value);
        }
      }
    }

    try {
      // Verify sender signature (cryptographic — relay can't forge)
      if (msg.senderSig && msg.ciphertext && msg.ephemeralKey && msg.nonce) {
        try {
          const senderInfo = await (await fetch(`${RELAY}/handle/info/${msg.from}`)).json();
          if (senderInfo?.ed25519PublicKey) {
            const sigPayload = `${msg.ciphertext}:${msg.ephemeralKey}:${msg.nonce}`;
            const valid = await verifySignature(sigPayload, msg.senderSig, senderInfo.ed25519PublicKey);
            if (!valid) {
              console.error(`⚠️ SENDER SIGNATURE INVALID from @${msg.from}!`);
              await sendTelegram(`⚠️ Message from @${msg.from} has INVALID signature. Dropped.`);
              return;
            }
          }
        } catch (err) {
          console.error('Signature verification error:', err);
          // Continue — don't drop on verification error (pubkey fetch could fail)
        }
      }

      // Decrypt
      const plaintext = await decryptFromSender(
        msg.ciphertext, msg.ephemeralKey, msg.nonce,
        keys.x25519PrivateKey
      );

      if (msg.effectiveRead === 'blind') {
        // BLIND — notify human, cache for "Show me", AI excluded
        const trustTokenRes = await relayPost('/trust-token', { target: msg.from });
        const blockTokenRes = await relayPost('/trust-token', { target: msg.from, action: 'block' });

        const showCallbackId = `show_${msg.id}`;
        blindMessageCache.set(showCallbackId, { text: plaintext, from: msg.from, ts: Date.now() });
        setTimeout(() => blindMessageCache.delete(showCallbackId), 3600000);

        const buttons = [
          [{ text: '👁 Show', callback_data: showCallbackId }],
          [{ text: '✅ Trust', url: trustTokenRes.url }, { text: '🚫 Block', url: blockTokenRes.url }]
        ];
        await sendTelegram(`📨 New message from <b>@${msg.from}</b>`, buttons);
        return;
      }

      // TRUSTED — guardrail scan first
      const scan = await scanGuardrail(plaintext);
      if (scan.flagged) {
        const reason = scan.error ? 'guardrail unavailable' : 'prompt injection detected';
        await sendTelegram(
          `⚠️ Message from <b>@${msg.from}</b> (${contactLabel}) flagged: ${reason}\n\n` +
          `🔒 Direct delivery — AI excluded:\n<pre>${escapeHtml(plaintext)}</pre>`
        );
        return;
      }

      // Clean trusted message — deliver to AI
      const channel = msg.channel ? `#${msg.channel} — ` : '';
      await deliverToAI(`📨 ${channel}@${msg.from} (${contactLabel}): ${plaintext}`);

    } catch (err) {
      console.error('Decrypt error:', err);
      await sendTelegram(`⚠️ Failed to decrypt message from @${msg.from}: ${err.message}`);
    }
    return;
  }

  if (msg.type === 'system') {
    // System events are wrapped in msg.data by the DO
    const event = msg.data || msg;
    switch (event.event) {
      case 'trust_changed':
        await deliverToAI(`✅ @${event.target} is now ${event.level}`);
        // Re-fetch inbox to process messages with updated effectiveRead
        // (redeliver updated blind→trusted in DO, but WS didn't push them)
        if (event.level === 'trust') {
          try {
            const { messages } = await relayGet(`/inbox/${handle}`);
            if (messages) {
              for (const msg of messages) {
                await handleMessage({ type: 'message', ...msg });
              }
              const trustedIds = messages.filter(m => m.effectiveRead === 'trusted').map(m => m.id);
              if (trustedIds.length > 0) {
                await relayPost('/inbox/ack', { ids: trustedIds });
              }
            }
          } catch (err) {
            console.error('Inbox re-fetch after trust change failed:', err);
          }
        }
        break;
      case 'permission_changed':
        await deliverToAI(`📋 Permissions changed on ${event.handle}`);
        break;
      case 'added_to_handle':
        await deliverToAI(`📋 Added to ${event.handle} by @${event.by}`);
        break;
    }
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- WebSocket connection ---

let ws = null;
let reconnectDelay = 1000;

async function connect() {
  const wsUrl = `${RELAY_WS}/ws/${handle}`;
  console.log(`Connecting to ${wsUrl}...`);

  const ts = Math.floor(Date.now() / 1000);
  const payload = `GET:/ws/${handle}:${ts}`;
  const sig = await signMessage(payload, keys.ed25519PrivateKey);

  ws = new WebSocket(wsUrl, {
    headers: {
      'X-Agent-Handle': handle,
      'X-Agent-Timestamp': String(ts),
      'X-Agent-Signature': sig
    }
  });

  ws.onopen = () => {
    console.log('Connected + authenticated ✅');
    reconnectDelay = 1000;
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      await handleMessage(msg);

      // Ack only trusted messages via HTTP. Blind stay in inbox for redeliver after trust change
      // (WS ack is not implemented server-side; DO webSocketMessage is a no-op)
      if (msg.id && msg.effectiveRead === 'trusted') {
        relayPost('/inbox/ack', { ids: [msg.id] }).catch(err =>
          console.error('Ack error:', err)
        );
      }
    } catch (err) {
      console.error('Message handling error:', err);
    }
  };

  ws.onclose = (event) => {
    setTimeout(connect, reconnectDelay);
    console.log(`Disconnected (${event.code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

// --- HTTP polling fallback ---

async function pollFallback() {
  console.log('WebSocket unavailable, falling back to HTTP polling...');
  while (true) {
    try {
      const { messages } = await relayGet(`/inbox/${handle}`);
      if (messages) {
        for (const msg of messages) {
          await handleMessage({ type: 'message', ...msg });
        }

        // Ack only trusted
        const trustedIds = messages.filter(m => m.effectiveRead === 'trusted').map(m => m.id);
        if (trustedIds.length > 0) {
          await relayPost('/inbox/ack', { ids: trustedIds });
        }
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

// --- Telegram callback handler for "Show me" ---

async function startTelegramCallbackHandler() {
  const tg = loadTelegramConfig();
  if (!tg) return;

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${tg.botToken}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["callback_query"]`
      );
      const { result } = await res.json();

      for (const update of result) {
        offset = update.update_id + 1;
        const cb = update.callback_query;
        if (!cb || !cb.data?.startsWith('show_')) continue;

        const cached = blindMessageCache.get(cb.data);
        if (cached) {
          await fetch(`https://api.telegram.org/bot${tg.botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id })
          });
          await sendTelegram(
            `👁 Message from <b>@${cached.from}</b>:\n\n` +
            `<pre>${escapeHtml(cached.text)}</pre>\n\n` +
            `<i>Shown to you only. AI doesn't see this.</i>`
          );
          blindMessageCache.delete(cb.data);
        } else {
          await fetch(`https://api.telegram.org/bot${tg.botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id, text: 'Message expired', show_alert: true })
          });
        }
      }
    } catch (err) {
      console.error('Callback handler error:', err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// --- Start ---

// Export for testing
export { handleMessage, escapeHtml, blindMessageCache, processedMessageIds, scanGuardrail };

// Only auto-connect when running as main script
if (process.argv[1]?.endsWith('ws-daemon.js')) {
  if (!handle) { console.error('Usage: ws-daemon.js <handle>'); process.exit(1); }
  keys = loadKeys();

  startTelegramCallbackHandler().catch(err => console.error('Callback handler fatal:', err));

  if (typeof WebSocket !== 'undefined') {
    connect();
  } else {
    pollFallback();
  }
}
