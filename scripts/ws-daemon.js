#!/usr/bin/env node
/**
 * Agent Chat v2 — WebSocket daemon
 * Maintains a persistent connection to the relay, decrypts messages,
 * runs guardrail scans, and delivers to the AI (or human for blind messages).
 *
 * Usage: ws-daemon.js <handle>
 * Env: AGENT_CHAT_RELAY, AGENT_SECRETS_DIR, AGENT_DELIVER_CMD, LAKERA_GUARD_KEY, AGENT_CHAT_THREAD_ID
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

// Deduplication: track processed message IDs to avoid duplicate notifications
const processedMessageIds = new Set();  // "msgId:effectiveRead" → processed

// --- Telegram config ---

function loadTelegramConfig() {
  const cfgFile = join(SECRETS_DIR, 'agent-chat-telegram.json');
  if (!existsSync(cfgFile)) return null;
  try {
    const config = JSON.parse(readFileSync(cfgFile, 'utf8'));
    // threadId can come from config file or env var
    if (!config.threadId && process.env.AGENT_CHAT_THREAD_ID) {
      config.threadId = parseInt(process.env.AGENT_CHAT_THREAD_ID, 10);
    }
    return config;
  } catch { return null; }
}

// --- Relay communication ---

const FETCH_TIMEOUT_MS = 15000; // 15s timeout for all external calls

async function relayGet(path) {
  const headers = await buildGetHeaders(handle, path, keys.ed25519PrivateKey);
  const res = await fetch(`${RELAY}${path}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return res.json();
}

async function relayPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const headers = await buildPostHeaders(handle, bodyStr, keys.ed25519PrivateKey);
  const res = await fetch(`${RELAY}${path}`, { method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return res.json();
}

// --- Guardrail (v2: 3-level fallback + health state) ---

let guardrailFailures = 0;
let guardrailAlertSent = false;

async function scanGuardrail(text, messageId = null) {
  let result;

  if (LAKERA_KEY) {
    // Level 1: Local scan — full E2E, plaintext never leaves this machine
    try {
      const res = await fetch('https://api.lakera.ai/v2/guard', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${LAKERA_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
        signal: AbortSignal.timeout(10000)
      });
      result = await res.json();
    } catch (err) {
      console.error('Local guardrail error:', err);
      result = { flagged: true, error: true };
    }
  } else if (messageId) {
    // Level 2: Relay scan — crypto-verified (relay checks hash + senderSig)
    try {
      const bodyStr = JSON.stringify({ message_id: messageId, text });
      const headers = await buildPostHeaders(handle, bodyStr, keys.ed25519PrivateKey);
      const res = await fetch(`${RELAY}/guardrail/scan`, {
        method: 'POST', headers, body: bodyStr,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });

      if (res.status === 429) {
        result = { flagged: false, error: true, unavailable: true, reason: 'Rate limited — max 60 scans/hour' };
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`Relay guardrail ${res.status}: ${err.error || 'unknown'}`);
        result = { flagged: true, error: true, reason: err.error };
      } else {
        result = await res.json();
      }
    } catch (err) {
      console.error('Relay guardrail error:', err);
      result = { flagged: true, error: true };
    }
  } else {
    // Level 3: No guardrail available
    result = { flagged: false, error: true, unavailable: true };
  }

  // Health state tracking
  if (result.error) {
    guardrailFailures++;
    if (guardrailFailures >= 3 && !guardrailAlertSent) {
      guardrailAlertSent = true;
      await sendTelegram(
        '⚠️ Guardrail unavailable — messages delivered without security scan.\n\n' +
        'For local scanning:\n<code>export LAKERA_GUARD_KEY=your-key</code>\n' +
        'Free: lakera.ai → API key in dashboard'
      );
    }
  } else {
    guardrailFailures = 0;
    guardrailAlertSent = false;
  }

  return result;
}

// --- Delivery ---

async function sendTelegram(text, buttons = null) {
  const tg = loadTelegramConfig();
  if (!tg) return deliverFallback(text);

  const payload = { chat_id: tg.chatId, text, parse_mode: 'HTML' };
  if (tg.threadId) payload.message_thread_id = tg.threadId;
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };

  try {
    await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
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
      // Guardrail v2: 4-part payload = ciphertext:ephemeralKey:nonce:plaintextHash
      if (msg.senderSig && msg.ciphertext && msg.ephemeralKey && msg.nonce) {
        try {
          const senderInfo = await (await fetch(`${RELAY}/handle/info/${msg.from}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
          })).json();
          if (senderInfo?.ed25519PublicKey) {
            const sigPayload = `${msg.ciphertext}:${msg.ephemeralKey}:${msg.nonce}:${msg.plaintextHash || ''}`;
            const valid = await verifySignature(sigPayload, msg.senderSig, senderInfo.ed25519PublicKey);
            if (!valid) {
              console.error(`⚠️ SENDER SIGNATURE INVALID from @${msg.from}!`);
              await sendTelegram(`⚠️ Message from @${escapeHtml(msg.from)} has INVALID signature. Dropped.`);
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

      if (msg.effectiveRead !== 'trusted') {
        // BLIND (or unknown) — show plaintext to human via Telegram, AI excluded
        // Security: unknown effectiveRead values default to blind (safe default)
        // Daemon sends directly via Bot API — OpenClaw/AI never sees this message
        const trustTokenRes = await relayPost('/trust-token', { target: msg.from });
        const blockTokenRes = await relayPost('/trust-token', { target: msg.from, action: 'block' });

        const buttons = [
          [{ text: '✅ Trust', url: trustTokenRes.url }, { text: '🚫 Block', url: blockTokenRes.url }]
        ];
        await sendTelegram(
          `🔒 <b>@${escapeHtml(msg.from)}</b> <i>(AI doesn't see this)</i>:\n\n` +
          `${escapeHtml(plaintext)}`,
          buttons
        );
        return;
      }

      // TRUSTED — guardrail scan (3-level fallback)
      const scan = await scanGuardrail(plaintext, msg.id);

      if (scan.flagged && !scan.unavailable) {
        // Flagged by Lakera — deliver to human only, AI excluded
        await sendTelegram(
          `⚠️ Message from <b>@${escapeHtml(msg.from)}</b> (${escapeHtml(contactLabel)}) flagged: prompt injection detected\n\n` +
          `🔒 Direct delivery — AI excluded:\n<pre>${escapeHtml(plaintext)}</pre>`
        );
        return;
      }

      if (scan.unavailable) {
        // Guardrail unavailable — still deliver to AI (trusted source), but notify user
        const reason = scan.reason || 'guardrail unavailable';
        await sendTelegram(`ℹ️ Message from @${escapeHtml(msg.from)} delivered without scan: ${escapeHtml(reason)}`);
      }

      // Clean or unavailable-but-trusted — deliver to AI
      const channel = msg.channel ? `#${msg.channel} — ` : '';
      const prefix = scan.unavailable ? '⚠️ [unscanned] ' : '📨 ';
      await deliverToAI(`${prefix}${channel}@${msg.from} (${contactLabel}): ${plaintext}`);

    } catch (err) {
      console.error('Decrypt error:', err);
      await sendTelegram(`⚠️ Failed to decrypt message from @${escapeHtml(msg.from)}: ${escapeHtml(err.message)}`);
    }
    return;
  }

  if (msg.type === 'system') {
    // System events are wrapped in msg.data by the DO
    const event = msg.data || msg;
    switch (event.event) {
      case 'trust_changed':
        const levelLabel = event.level === 'trust' ? 'trusted' : event.level === 'block' ? 'blocked' : event.level;
        await deliverToAI(`✅ @${event.target} is now ${levelLabel}`);
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
      await sendTelegram(`⚠️ Error processing message: ${escapeHtml(err.message)}`);
    }
  };

  ws.onclose = (event) => {
    console.log(`Disconnected (${event.code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    // Alert user only on persistent disconnection (30s+ = 4th retry)
    if (reconnectDelay >= 16000) {
      sendTelegram(`⚠️ Agent Chat connection lost. Retrying every ${reconnectDelay / 1000}s...`);
    }
    setTimeout(connect, reconnectDelay);
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

// Note: No Telegram callback handler needed.
// Daemon is write-only — sends messages via Bot API, never listens for callbacks.
// Trust/Block buttons are URL buttons that open relay trust page directly.
// This avoids conflicts with OpenClaw or any other bot token consumer.

// --- Start ---

// Export for testing
// Guardrail state getter for testing
function getGuardrailState() {
  return { failures: guardrailFailures, alertSent: guardrailAlertSent };
}
function resetGuardrailState() {
  guardrailFailures = 0;
  guardrailAlertSent = false;
}

export {
  handleMessage, escapeHtml, processedMessageIds,
  scanGuardrail, getGuardrailState, resetGuardrailState
};

// Only auto-connect when running as main script
if (process.argv[1]?.endsWith('ws-daemon.js')) {
  if (!handle) { console.error('Usage: ws-daemon.js <handle>'); process.exit(1); }
  keys = loadKeys();

  if (typeof WebSocket !== 'undefined') {
    connect();
  } else {
    pollFallback();
  }
}
