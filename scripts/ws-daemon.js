#!/usr/bin/env node
/**
 * Agent Chat v2 — WebSocket daemon
 * Maintains a persistent connection to the relay, decrypts messages,
 * runs guardrail scans, and delivers to the AI (or human for blind messages).
 *
 * Usage: ws-daemon.js <handle>
 * Env: AGENT_CHAT_RELAY, AGENT_CHAT_DIR, AGENT_CHAT_KEYS_DIR, AGENT_DELIVER_CMD, LAKERA_GUARD_KEY
 */

import {
  signMessage, verifySignature, decryptFromSender
} from '../lib/crypto.js';
import { buildPostHeaders, buildGetHeaders } from '../lib/auth.js';
import { loadConfig, getKeyPaths, DEFAULT_RELAY_URL, resolveKeysDir, resolveHandleDir, resolveDataDir } from '../lib/config.js';
import { loadContacts } from '../lib/contacts.js';
import { formatHandle, inferHandleType } from '../lib/format.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const handle = process.argv[2] || process.env.AGENT_CHAT_HANDLE;

const RELAY = process.env.AGENT_CHAT_RELAY || DEFAULT_RELAY_URL;
const RELAY_WS = RELAY.replace('https://', 'wss://').replace('http://', 'ws://');
const DATA_DIR = resolveDataDir();
const KEYS_DIR = resolveKeysDir();
const DELIVER_CMD = process.env.AGENT_DELIVER_CMD;
const LAKERA_KEY = process.env.LAKERA_GUARD_KEY;
const VERBOSE = process.env.AGENT_CHAT_VERBOSE === '1' || process.env.AGENT_CHAT_VERBOSE === 'true';

function verbose(...args) { if (VERBOSE) console.log('[VERBOSE]', ...args); }

// Resolve absolute path to send.js (always relative to this file, not cwd)
const __script_dirname = dirname(fileURLToPath(import.meta.url));
const SEND_JS_PATH = join(__script_dirname, 'send.js');

const CONFIG_DIR = handle ? resolveHandleDir(handle) : null;

// Load handle config for optional features
function loadHandleConfig() {
  if (!CONFIG_DIR) return {};
  try { return JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8')); } catch { return {}; }
}
const handleCfg = loadHandleConfig();
const BLIND_RECEIPTS = handleCfg.blindReceipts === true;
const UNIFIED_CHANNEL = handleCfg.unifiedChannel === true;

// --- OpenClaw discovery ---
// Resolves the path to the openclaw binary. Checks (in order):
// 1. config.json openclawPath  2. OPENCLAW_PATH env  3. PATH (which)  4. standard locations
// Returns absolute path string or null. Result is cached for the process lifetime.
let _openclawPathCache;
let _openclawPathResolved = false;
let _unifiedFallbackWarningShown = false;

function resolveOpenClaw() {
  if (_openclawPathResolved) return _openclawPathCache;
  _openclawPathResolved = true;

  // 1. Explicit config
  if (handleCfg.openclawPath) {
    if (existsSync(handleCfg.openclawPath)) {
      verbose('OpenClaw resolved from config.json:', handleCfg.openclawPath);
      _openclawPathCache = handleCfg.openclawPath;
      return _openclawPathCache;
    }
    console.warn(`[WARN] openclawPath in config.json not found: ${handleCfg.openclawPath}`);
  }

  // 2. Environment variable
  if (process.env.OPENCLAW_PATH) {
    if (existsSync(process.env.OPENCLAW_PATH)) {
      verbose('OpenClaw resolved from OPENCLAW_PATH env:', process.env.OPENCLAW_PATH);
      _openclawPathCache = process.env.OPENCLAW_PATH;
      return _openclawPathCache;
    }
    console.warn(`[WARN] OPENCLAW_PATH env not found: ${process.env.OPENCLAW_PATH}`);
  }

  // 3. PATH lookup
  try {
    const which = execFileSync('which', ['openclaw'], { timeout: 5000 }).toString().trim();
    if (which && existsSync(which)) {
      verbose('OpenClaw resolved from PATH:', which);
      _openclawPathCache = which;
      return _openclawPathCache;
    }
  } catch { /* not on PATH */ }

  // 4. Standard locations
  const candidates = [
    join(process.env.HOME, 'openclaw', 'dist', 'index.js'),
    join(process.env.HOME, '.openclaw', 'openclaw'),
    '/usr/local/bin/openclaw',
    '/opt/homebrew/bin/openclaw',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      verbose('OpenClaw resolved from standard path:', candidate);
      // If it's index.js, we'll need to run it with node
      _openclawPathCache = candidate;
      return _openclawPathCache;
    }
  }

  console.warn('[WARN] OpenClaw not found. AI delivery will use unified fallback (reduced security).');
  _openclawPathCache = null;
  return null;
}

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
// Persisted to disk so daemon restarts don't re-deliver blind messages
const DEDUP_MAX_ENTRIES = 10000;
const DEDUP_PRUNE_TO = 5000;

const processedMessageIds = new Set();  // "msgId:effectiveRead" → processed

// --- Exactly-once: lastAckedId cursor ---
// Tracks the last successfully processed message ID. On reconnect,
// sent as ?after= to relay so server only returns newer messages.
// This prevents duplicates even when dedup.json is lost (crash, fresh clone).

function getLastAckedIdPath() {
  return CONFIG_DIR ? join(CONFIG_DIR, 'lastAckedId') : null;
}

function loadLastAckedId() {
  const p = getLastAckedIdPath();
  if (!p) return null;
  try {
    if (existsSync(p)) {
      const id = readFileSync(p, 'utf8').trim();
      return id || null;
    }
  } catch { /* missing or corrupt — start fresh */ }
  return null;
}

function saveLastAckedId(id) {
  const p = getLastAckedIdPath();
  if (!p || !id) return;
  try { writeFileSync(p, id, 'utf8'); } catch (err) {
    console.error('lastAckedId save error:', err);
  }
}

let lastAckedId = null;

function getDedupPath() {
  return CONFIG_DIR ? join(CONFIG_DIR, 'dedup.json') : null;
}

function loadDedupState() {
  const p = getDedupPath();
  if (!p) return;
  try {
    if (existsSync(p)) {
      const arr = JSON.parse(readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) {
        // Load only the last DEDUP_MAX_ENTRIES to prevent growth
        const start = Math.max(0, arr.length - DEDUP_MAX_ENTRIES);
        for (let i = start; i < arr.length; i++) {
          processedMessageIds.add(arr[i]);
        }
      }
    }
  } catch { /* corrupt file — start fresh */ }
}

function saveDedupState() {
  const p = getDedupPath();
  if (!p) return;
  try {
    let arr = [...processedMessageIds];
    // Prune if over limit
    if (arr.length > DEDUP_MAX_ENTRIES) {
      arr = arr.slice(arr.length - DEDUP_PRUNE_TO);
      processedMessageIds.clear();
      arr.forEach(id => processedMessageIds.add(id));
    }
    writeFileSync(p, JSON.stringify(arr));
  } catch (err) {
    console.error('Dedup save error:', err);
  }
}

// --- Handle type cache ---
// Cache handle types to avoid repeated relay calls
const handleTypeCache = new Map();

async function getHandleType(name) {
  if (handleTypeCache.has(name)) return handleTypeCache.get(name);
  try {
    const res = await fetch(`${RELAY}/handle/info/${name}`, { headers: buildGetHeaders(name) });
    if (res.ok) {
      const info = await res.json();
      const type = inferHandleType(info);
      handleTypeCache.set(name, type);
      return type;
    }
  } catch {}
  handleTypeCache.set(name, 'personal');
  return 'personal';
}

// Format a handle with proper prefix, using cache when available
function fmtHandle(name, knownType) {
  const type = knownType || handleTypeCache.get(name) || 'personal';
  return formatHandle(name, type);
}

// --- Telegram config ---

function loadTelegramConfig() {
  // New layout: telegram.json (chatId/threadId) in DATA_DIR, telegram-token.json (botToken) in KEYS_DIR
  // Backward compat: old agent-chat-telegram.json in SECRETS_DIR has all fields
  let config = {};

  // Try new layout first
  const dataFile = join(DATA_DIR, 'telegram.json');
  const tokenFile = join(KEYS_DIR, 'telegram-token.json');
  if (existsSync(dataFile)) {
    try { config = JSON.parse(readFileSync(dataFile, 'utf8')); } catch { /* ignore */ }
  }
  if (existsSync(tokenFile)) {
    try { const t = JSON.parse(readFileSync(tokenFile, 'utf8')); config.botToken = t.botToken; } catch { /* ignore */ }
  }

  // Backward compat: old single-file layout
  if (!config.botToken) {
    const oldFile = join(process.env.HOME, '.openclaw', 'secrets', 'agent-chat-telegram.json');
    if (existsSync(oldFile)) {
      try { config = { ...config, ...JSON.parse(readFileSync(oldFile, 'utf8')) }; } catch { /* ignore */ }
    }
  }

  if (!config.botToken || !config.chatId) return null;

  // threadId priority: per-handle config.json > shared telegram.json > env var
  if (CONFIG_DIR) {
    try {
      const hcfg = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
      if (hcfg.threadId) config.threadId = hcfg.threadId;
    } catch { /* ignore */ }
  }
  if (!config.threadId && process.env.AGENT_CHAT_THREAD_ID) {
    config.threadId = parseInt(process.env.AGENT_CHAT_THREAD_ID, 10);
  }
  return config;
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
      result = { flagged: false, error: true, unavailable: true, reason: err.message };
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
        // Non-2xx = guardrail unavailable (not a real flag). Treat as scan failure
        result = { flagged: false, error: true, unavailable: true, reason: err.error || `HTTP ${res.status}` };
      } else {
        result = await res.json();
      }
    } catch (err) {
      console.error('Relay guardrail error:', err);
      result = { flagged: false, error: true, unavailable: true, reason: err.message };
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
        'Free: lakera.ai → API key in dashboard',
        null, { noMirror: true }
      );
    }
  } else {
    guardrailFailures = 0;
    guardrailAlertSent = false;
  }

  return result;
}

// --- Mirrors ---
// Send a copy of text to all configured mirror targets (best-effort, no buttons).
// Mirrors are read from telegram.json.
// mirrorFormat: "symmetric" → unified "💬 @from → @to:\n\ntext" format
//              "raw" or absent → forwards text as-is

function loadMirrorConfig() {
  try {
    const dataFile = join(DATA_DIR, 'telegram.json');
    return JSON.parse(readFileSync(dataFile, 'utf8'));
  } catch { return {}; }
}

function loadMirrors(direction, handle) {
  try {
    const data = loadMirrorConfig();
    const m = data.mirrors;
    if (!m) return [];
    // Legacy flat array → all handles, both directions
    if (Array.isArray(m)) return m.filter(t => t && t.chatId);
    // Detect format: old (direction-first) vs new (handle-first)
    // Old has top-level 'inbound'/'outbound' keys
    if (m.inbound || m.outbound) {
      const bucket = direction === 'outbound' ? m.outbound : m.inbound;
      if (!bucket) return [];
      if (Array.isArray(bucket)) return bucket.filter(t => t && t.chatId);
      // Old per-handle inside direction bucket
      const key = handle ? handle.replace(/^@/, '') : null;
      const targets = (key && bucket[key]) || (key && bucket[`@${key}`]) || bucket['*'];
      return Array.isArray(targets) ? targets.filter(t => t && t.chatId) : [];
    }
    // New format: handle-first → { "@claudia": [...] } or { "@claudia": { inbound: [...], outbound: [...] } }
    const key = handle ? handle.replace(/^@/, '') : null;
    const entry = (key && m[key]) || (key && m[`@${key}`]) || m['*'];
    if (!entry) return [];
    // Simple: array → both directions
    if (Array.isArray(entry)) return entry.filter(t => t && t.chatId);
    // Split: { inbound: [...], outbound: [...] }
    const targets = direction === 'outbound' ? entry.outbound : entry.inbound;
    return Array.isArray(targets) ? targets.filter(t => t && t.chatId) : [];
  } catch { return []; }
}

function formatMirrorText(text, mirror, opts) {
  if (mirror.format !== 'symmetric' || !opts) return text;
  const { from, to, plaintext } = opts;
  if (!from || !to || !plaintext) return text;
  return `💬 <b>${escapeHtml(fmtHandle(from))} → ${escapeHtml(fmtHandle(to))}</b>:\n\n${escapeHtml(plaintext)}`;
}

async function sendMirrors(text, direction = 'inbound', handle = null, symmetricOpts = null) {
  const tg = loadTelegramConfig();
  if (!tg) return;
  const mirrors = loadMirrors(direction, handle);
  if (!mirrors.length) return;
  for (const mirror of mirrors) {
    try {
      const finalText = formatMirrorText(text, mirror, symmetricOpts);
      const payload = { chat_id: mirror.chatId, text: finalText, parse_mode: 'HTML', disable_notification: true };
      if (mirror.threadId) payload.message_thread_id = mirror.threadId;
      await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });
    } catch (err) {
      console.error(`Mirror send error (${mirror.chatId}):`, err.message);
    }
  }
}

// --- Delivery ---

async function sendTelegram(text, buttons = null, opts = {}) {
  verbose(`sendTelegram: ${text.length} chars${buttons ? ', with buttons' : ''}${opts.noMirror ? ', noMirror' : ''}`);
  const tg = loadTelegramConfig();
  if (!tg) return deliverFallback(text, buttons);

  const payload = { chat_id: tg.chatId, text, parse_mode: 'HTML' };
  if (tg.threadId) payload.message_thread_id = tg.threadId;
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };

  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`Telegram API error ${res.status}:`, err.description || 'unknown');
    }
  } catch (err) {
    console.error('Telegram sendMessage error:', err);
    deliverFallback(text, buttons);
  }

  // Mirror inbound text to configured targets (skip buttons, system messages, and flagged content)
  if (!buttons && !opts.noMirror) await sendMirrors(text, 'inbound', opts.handle, opts.symmetric);
}

function deliverFallback(text, buttons = null) {
  if (DELIVER_CMD) {
    // SECURITY: pass text via env var, NOT shell interpolation
    const env = { ...process.env, AGENT_MSG: text };
    if (buttons) env.AGENT_MSG_BUTTONS = JSON.stringify(buttons);
    execFileSync(DELIVER_CMD, [], { stdio: 'inherit', env });
  } else {
    console.log('[INBOX]', text);
  }
}

// Resolve session UUID from OpenClaw sessions.json.
// With threadId: returns the thread session UUID.
// Without threadId: returns the main DM session UUID.
function resolveSessionId(threadId) {
  try {
    const sessionsPath = join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
    const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    if (threadId) {
      return sessions[`agent:main:main:thread:${threadId}`]?.sessionId || null;
    }
    return sessions['agent:main:main']?.sessionId || null;
  } catch { return null; }
}

// Deliver a message to the AI agent via openclaw agent --local --deliver.
// Primary: uses the thread session UUID (same AI context as Telegram thread).
// Fallback: uses isolated "agent-chat-inbox" session with --reply-to for thread routing.
// Unified fallback: if OpenClaw is not found, delivers via Telegram (both human + AI see it).
// AI receives the message with full workspace/skills/memory context and responds in the thread.
async function deliverToAI(text) {
  verbose(`deliverToAI: ${text.length} chars`);
  if (DELIVER_CMD) {
    // SECURITY: pass text via env var, NOT shell interpolation
    execFileSync(DELIVER_CMD, [], { stdio: 'inherit', env: { ...process.env, AGENT_MSG: text } });
    return;
  }

  const tg = loadTelegramConfig();
  const openclawBin = resolveOpenClaw();

  if (!openclawBin) {
    // Unified fallback: OpenClaw not found — deliver via Telegram so AI can still see it
    // (in unified mode, the Telegram thread IS the AI session)
    if (!_unifiedFallbackWarningShown) {
      _unifiedFallbackWarningShown = true;
      console.warn('[UNIFIED-FALLBACK] OpenClaw not found. Delivering via Telegram (reduced security).');
      if (tg) {
        try {
          const warningPayload = { chat_id: tg.chatId, parse_mode: 'HTML',
            text: '⚠️ <b>OpenClaw not found</b> — using unified delivery. AI sees all messages without security filtering.\n\n<i>Set <code>openclawPath</code> in config.json or install OpenClaw to restore split mode.</i>' };
          if (tg.threadId) warningPayload.message_thread_id = tg.threadId;
          await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(warningPayload), signal: AbortSignal.timeout(10000)
          });
        } catch (e) { console.error('Warning delivery failed:', e.message); }
      }
    }
    // Deliver the actual AI message via Telegram (unified — human already saw their version via sendTelegram)
    if (tg) {
      try {
        const payload = { chat_id: tg.chatId, text, parse_mode: 'HTML' };
        if (tg.threadId) payload.message_thread_id = tg.threadId;
        const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          console.error(`Unified fallback Telegram error ${res.status}:`, e.description || 'unknown');
        } else {
          console.log('[DELIVER-UNIFIED]', text);
        }
      } catch (e2) {
        console.error('All delivery methods failed:', e2.message);
      }
    }
    return;
  }

  // Determine how to invoke openclaw: direct binary or node + index.js
  const isIndexJs = openclawBin.endsWith('.js');
  const execBin = isIndexJs ? process.execPath : openclawBin;
  const baseArgs = isIndexJs ? [openclawBin] : [];

  // --local runs embedded agent (required for --deliver to work; gateway path doesn't deliver).
  // --deliver sends AI's reply to the Telegram thread.

  // Primary: reuse the existing session (thread session if forum, main DM session otherwise).
  // AI sees full conversation history + incoming agent-chat message in one context.
  const sessionUUID = resolveSessionId(tg?.threadId);
  if (sessionUUID) {
    try {
      const args = [...baseArgs, 'agent', '--local', '--session-id', sessionUUID, '-m', text,
        '--deliver', '--channel', 'telegram'];
      execFileSync(execBin, args, { stdio: 'inherit', timeout: 120000 });
      console.log('[DELIVER-SESSION]', text);
      return;
    } catch (err) {
      console.error('Session delivery failed:', err.message);
      // Fall through to isolated session
    }
  }

  // Fallback: isolated session with explicit thread routing.
  // Works when thread session doesn't exist yet (shouldn't happen after setup bootstrap).
  try {
    const args = [...baseArgs, 'agent', '--local', '--session-id', 'agent-chat-inbox', '-m', text,
      '--deliver', '--channel', 'telegram'];
    if (tg?.chatId) {
      const target = tg.threadId ? `${tg.chatId}:topic:${tg.threadId}` : String(tg.chatId);
      args.push('--reply-to', target);
    }
    execFileSync(execBin, args, { stdio: 'inherit', timeout: 120000 });
    console.log('[DELIVER-FALLBACK]', text);
    return;
  } catch (err) {
    console.error('Isolated session delivery failed:', err.message);
  }

  // If OpenClaw was found but both session methods failed, log error (don't duplicate to Telegram)
  console.error('[DELIVER-FAILED] OpenClaw found but delivery failed. Check openclaw logs.');
}

// --- Message handling ---

async function handleMessage(msg, opts = {}) {
  const contacts = loadContacts(null);
  const contactLabel = contacts[msg.from]?.label || msg.from;
  verbose(`handleMessage: type=${msg.type}, from=${msg.from}, id=${msg.id}, effectiveRead=${msg.effectiveRead}, queued=${!!opts.queued}`);

  if (msg.type === 'message') {
    // Dedup: skip if already processed at SAME trust level
    // Redeliver sends same ID with UPGRADED effectiveRead → must process again
    const dedupKey = `${msg.id}:${msg.effectiveRead}`;
    if (msg.id && processedMessageIds.has(dedupKey)) { verbose(`dedup skip: ${dedupKey}`); return; }
    if (msg.id) {
      processedMessageIds.add(dedupKey);
      saveDedupState();
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
              if (opts.queued) {
                // Silently skip old messages from previous key registration
                if (msg.id) { processedMessageIds.add(dedupKey); saveDedupState(); }
                return;
              }
              console.error(`⚠️ SENDER SIGNATURE INVALID from ${fmtHandle(msg.from)}!`);
              await sendTelegram(`❌ <b>${escapeHtml(fmtHandle(msg.from))}</b> <i>(bad signature)</i>:\n\n<i>Message dropped — invalid signature</i>`, null, { noMirror: true });
              if (msg.id) { processedMessageIds.add(dedupKey); saveDedupState(); }
              return;
            }
          }
        } catch (err) {
          console.error('Signature verification error:', err);
          // Continue — don't drop on verification error (pubkey fetch could fail)
        }
      }

      // Decrypt
      verbose(`Decrypting message from ${fmtHandle(msg.from)}...`);
      const plaintext = await decryptFromSender(
        msg.ciphertext, msg.ephemeralKey, msg.nonce,
        keys.x25519PrivateKey
      );
      verbose(`Decrypted: ${plaintext.length} chars from ${fmtHandle(msg.from)}`);

      // --- Determine delivery parameters ---
      const isTrusted = msg.effectiveRead === 'trusted';
      const scan = isTrusted ? await scanGuardrail(plaintext, msg.id) : { flagged: false, unavailable: false };
      const isFlagged = scan.flagged && !scan.unavailable;
      const isUnscanned = scan.unavailable;
      const aiExcluded = !isTrusted || isFlagged; // blind or injection → AI doesn't see
      verbose(`Trust: ${isTrusted ? 'trusted' : 'blind'}, guardrail: ${isFlagged ? 'FLAGGED' : isUnscanned ? 'unavailable' : 'clean'}, aiExcluded: ${aiExcluded}`);

      // Warning line (optional, directly above the header — no blank line between)
      let warningLine = '';
      if (isFlagged) warningLine = '⚠️ <b>potential harm detected</b>\n';
      else if (isUnscanned) warningLine = '❓ <i>not checked for harm</i>\n';

      // Message header — use proper prefix for handle type
      // In unified fallback mode (no OpenClaw), warn that AI sees everything
      const inUnifiedFallback = !DELIVER_CMD && !resolveOpenClaw() && !UNIFIED_CHANNEL;
      const icon = inUnifiedFallback ? '⚠️' : (aiExcluded ? '🔒' : '📨');
      const privacyNote = inUnifiedFallback
        ? ' <i>(AI sees this — fix setup)</i>'
        : (aiExcluded ? ' <i>(AI doesn\'t see this)</i>' : '');
      // Derive group channel from relay fields: group has to !== handle, DM has to === handle
      const channel = (msg.to && msg.to !== handle) ? msg.to : null;
      // Group: @sender → #channel. DM: @sender → @me
      const fromPart = channel
        ? `${escapeHtml(fmtHandle(msg.from))} → ${escapeHtml(fmtHandle(channel, handleTypeCache.get(channel) || 'group'))}`
        : `${escapeHtml(fmtHandle(msg.from))} → ${escapeHtml(fmtHandle(handle))}`;
      const header = `${icon} <b>${fromPart}</b>${privacyNote}:`;

      // Buttons (only when AI is excluded)
      let buttons = null;
      if (aiExcluded) {
        const forwardTokenRes = await relayPost('/trust-token', { target: msg.from, action: 'forward-one', messageId: msg.id });
        const blockTokenRes = await relayPost('/trust-token', { target: msg.from, action: 'block' });
        const preview = plaintext.length > 500 ? plaintext.slice(0, 500) + '…' : plaintext;
        const forwardUrl = `${forwardTokenRes.url}#${encodeURIComponent(preview)}`;

        const actionRow = [];
        if (!isTrusted) {
          // Blind sender → offer Trust
          const trustTokenRes = await relayPost('/trust-token', { target: msg.from });
          actionRow.push({ text: `✅ Trust ${fmtHandle(msg.from)}`, url: trustTokenRes.url });
        } else {
          // Trusted sender flagged → offer Untrust
          const untrustTokenRes = await relayPost('/trust-token', { target: msg.from, action: 'untrust' });
          actionRow.push({ text: `🔓 Untrust ${fmtHandle(msg.from)}`, url: untrustTokenRes.url });
        }
        actionRow.push({ text: `🚫 Block ${fmtHandle(msg.from)}`, url: blockTokenRes.url });

        buttons = [
          [{ text: `➡️ Forward to ${fmtHandle(handle)}`, url: forwardUrl }],
          actionRow
        ];
      }

      // Build hint for AI
      const firstDeliveryMarker = join(DATA_DIR, '.first-delivery-done');
      const isFirst = !existsSync(firstDeliveryMarker);
      const hint = isFirst
        ? 'To reply to other agents, see your agent-chat skill.\nConfirm you see this by saying anything — no send.js needed here.\nTip: check in on conversations 1-2x daily — reply, share interesting things, but don\'t spam.'
        : channel
          ? `Reply to ${fmtHandle(channel, 'group')}: node ${SEND_JS_PATH} send ${channel} "your reply"\nReply to ${fmtHandle(msg.from)} privately: node ${SEND_JS_PATH} send ${msg.from} "your reply"`
          : `Reply with: node ${SEND_JS_PATH} send ${msg.from} "your reply"`;

      const mirrorOpts = { handle: channel || msg.from, symmetric: { from: msg.from, to: channel || handle, plaintext } };

      if (UNIFIED_CHANNEL) {
        // Unified: single channel for human + AI. Always include hint so AI knows how to respond.
        const hintLine = `\n\n<i>${escapeHtml(hint)}</i>`;
        await sendTelegram(
          `${warningLine}${header}\n\n${escapeHtml(plaintext)}${hintLine}`,
          buttons,
          mirrorOpts
        );
        if (isFirst) {
          try { writeFileSync(firstDeliveryMarker, new Date().toISOString()); } catch {}
        }
      } else {
        // Standard: separate human + AI channels
        await sendTelegram(
          `${warningLine}${header}\n\n${escapeHtml(plaintext)}`,
          buttons,
          mirrorOpts
        );

        if (aiExcluded) {
          const reason = isFlagged ? 'flagged' : 'blind';
          const aiFromPart = channel
            ? `${fmtHandle(msg.from)} → ${fmtHandle(channel, handleTypeCache.get(channel) || 'group')}`
            : fmtHandle(msg.from);
          if (BLIND_RECEIPTS) {
            await deliverToAI(`🔒 ${aiFromPart}${channel ? '' : ` → ${fmtHandle(handle)}`} — new message (${reason})`);
          } else {
            console.log(`[SKIP-AI] ${aiFromPart} — ${reason} (blindReceipts off)`);
          }
        } else {
          const aiFromPart = channel
            ? `${fmtHandle(msg.from)} → ${fmtHandle(channel, handleTypeCache.get(channel) || 'group')}`
            : fmtHandle(msg.from);
          const warnPrefix = isUnscanned ? '⚠️ [unscanned] ' : '';
          if (isFirst) {
            try { writeFileSync(firstDeliveryMarker, new Date().toISOString()); } catch {}
          }
          const aiHeader = channel
            ? `[Agent Chat] ${warnPrefix}${aiFromPart}:`
            : `[Agent Chat] ${warnPrefix}Message from ${aiFromPart} → ${fmtHandle(handle)} (${contactLabel}):`;
          const aiMessage = [
            aiHeader,
            '',
            plaintext,
            '',
            '---',
            hint,
          ].join('\n');
          await deliverToAI(aiMessage);
        }
      }

    } catch (err) {
      if (opts.queued) {
        // Silently skip old messages that can't be decrypted (previous keys)
        if (msg.id) { processedMessageIds.add(dedupKey); saveDedupState(); }
        // Still update cursor — we've "processed" it (skip counts as processed)
        if (msg.id) { lastAckedId = msg.id; saveLastAckedId(msg.id); }
        return;
      }
      console.error('Decrypt error:', err);
      await sendTelegram(`❌ <b>${escapeHtml(fmtHandle(msg.from))}</b> <i>(decrypt error)</i>:\n\n<i>${escapeHtml(err.message)}</i>`, null, { noMirror: true });
    }
    // Update cursor after processing (success or handled error)
    if (msg.id) { lastAckedId = msg.id; saveLastAckedId(msg.id); }
    return;
  }

  if (msg.type === 'system') {
    // System events are wrapped in msg.data by the DO
    const event = msg.data || msg;
    switch (event.event) {
      case 'trust_changed':
        // Dedup trust_changed events (can fire multiple times from DO)
        const trustDedupKey = `trust:${event.target}:${event.level}`;
        if (processedMessageIds.has(trustDedupKey)) break;
        processedMessageIds.add(trustDedupKey);
        
        const levelLabel = event.level === 'trust' ? 'trusted' : event.level === 'block' ? 'blocked' : event.level;
        await deliverToAI(`✅ ${fmtHandle(event.target)} is now ${levelLabel}`);
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
        await deliverToAI(`📋 Added to ${fmtHandle(event.handle, 'group')} by ${fmtHandle(event.by)}`);
        // Auto-trust: if inviter is in contacts → auto-set selfRead=trusted for the group
        try {
          const contacts = loadContacts(null);
          if (contacts[event.by]) {
            await relayPost('/handle/self', { handle: event.handle, selfRead: 'trusted' });
            await deliverToAI(`🤝 Auto-trusted ${fmtHandle(event.handle, 'group')} (invited by contact ${fmtHandle(event.by)})`);
          }
        } catch (err) {
          console.error('Auto-trust check failed:', err);
        }
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

  ws.onopen = async () => {
    console.log('Connected + authenticated ✅');
    reconnectDelay = 1000;

    // Fetch messages accumulated while disconnected (one-time, not polling)
    // Use lastAckedId cursor to avoid re-processing already-seen messages
    try {
      const inboxPath = lastAckedId
        ? `/inbox/${handle}?after=${encodeURIComponent(lastAckedId)}`
        : `/inbox/${handle}`;
      verbose(`Fetching inbox: ${inboxPath}`);
      const { messages } = await relayGet(inboxPath);
      if (messages?.length) {
        for (const msg of messages) {
          await handleMessage({ type: msg.type || 'message', ...msg }, { queued: true });
        }
        // Ack only trusted (blind stays for redeliver)
        const trustedIds = messages.filter(m => m.effectiveRead === 'trusted' || m.type === 'system').map(m => m.id);
        if (trustedIds.length > 0) {
          await relayPost('/inbox/ack', { ids: trustedIds });
        }
        const skipped = messages.length - messages.filter(m => !processedMessageIds.has(`${m.id || ''}:${m.effectiveRead || 'unknown'}`)).length;
        if (skipped > 0) {
          console.log(`Processed ${messages.length} queued messages (${skipped} old/incompatible skipped)`);
        } else {
          console.log(`Processed ${messages.length} queued messages`);
        }
      }
    } catch (err) {
      console.error('Inbox fetch on connect error:', err);
    }
  };

  ws.onmessage = async (event) => {
    try {
      const raw = JSON.parse(event.data);
      // DO pushes InboxMessage without type for regular messages; normalize
      const msg = raw.type ? raw : { type: 'message', ...raw };
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
      await sendTelegram(`⚠️ Error processing message: ${escapeHtml(err.message)}`, null, { noMirror: true });
    }
  };

  ws.onclose = (event) => {
    console.log(`Disconnected (${event.code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    // Alert user only on persistent disconnection (30s+ = 4th retry)
    if (reconnectDelay >= 16000) {
      sendTelegram(`⚠️ Agent Chat connection lost. Retrying every ${reconnectDelay / 1000}s...`, null, { noMirror: true });
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
  console.log('⚠️ WebSocket unavailable, falling back to HTTP polling (30s interval). Install ws package for real-time: npm i ws');
  while (true) {
    try {
      verbose('Polling inbox...');
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
  scanGuardrail, getGuardrailState, resetGuardrailState,
  loadDedupState, saveDedupState, getDedupPath,
  loadLastAckedId, saveLastAckedId, getLastAckedIdPath
};

// --- PID lock ---

function getPidPath() {
  return CONFIG_DIR ? join(CONFIG_DIR, 'daemon.pid') : null;
}

function acquirePidLock() {
  const pidPath = getPidPath();
  if (!pidPath) return;
  
  // Check if another daemon is running
  if (existsSync(pidPath)) {
    try {
      const oldPid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // Check if process exists
          console.error(`❌ Another daemon is already running (PID ${oldPid}). Kill it first or remove ${pidPath}`);
          process.exit(1);
        } catch {
          // Process doesn't exist — stale PID file, safe to overwrite
          console.log(`Removing stale PID file (old PID ${oldPid})`);
        }
      }
    } catch {}
  }
  
  writeFileSync(pidPath, String(process.pid));
}

function releasePidLock() {
  const pidPath = getPidPath();
  if (!pidPath) return;
  try {
    if (existsSync(pidPath)) {
      const storedPid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (storedPid === process.pid) unlinkSync(pidPath);
    }
  } catch {}
}

// --- Graceful shutdown ---

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  if (ws) {
    try { ws.close(1000, 'daemon shutdown'); } catch {}
  }
  releasePidLock();
  saveDedupState();
  console.log('Goodbye.');
  process.exit(0);
}

// --- WebSocket resolution ---
// 1. Native WebSocket (Node ≥21)
// 2. 'ws' npm package (if installed)
// 3. HTTP polling fallback (never crash)

async function resolveWebSocket() {
  if (typeof WebSocket !== 'undefined') {
    return { WS: WebSocket, source: 'native' };
  }
  try {
    const ws = await import('ws');
    const WS = ws.default || ws.WebSocket || ws;
    if (typeof WS === 'function') return { WS, source: 'ws package' };
  } catch {}
  return { WS: null, source: 'none' };
}

// Only auto-connect when running as main script
if (process.argv[1]?.endsWith('ws-daemon.js')) {
  if (!handle) { console.error('Usage: ws-daemon.js <handle>'); process.exit(1); }
  keys = loadKeys();
  loadDedupState();
  lastAckedId = loadLastAckedId();
  if (processedMessageIds.size > 0) {
    console.log(`Loaded ${processedMessageIds.size} dedup entries`);
  }
  if (lastAckedId) {
    console.log(`Loaded lastAckedId cursor: ${lastAckedId}`);
  }

  // PID lock
  acquirePidLock();
  
  // Graceful shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Resolve WebSocket and connect
  const { WS, source } = await resolveWebSocket();
  if (WS) {
    if (source !== 'native') console.log(`Using WebSocket from ${source}`);
    // Make WS available globally for connect()
    if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WS;
    connect();
  } else {
    console.log('⚠️ No WebSocket available (Node <21, no ws package). Install ws: npm i ws');
    pollFallback();
  }
}
