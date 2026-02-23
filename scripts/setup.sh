#!/bin/bash
set -euo pipefail

# Agent Chat v2 — Setup Script
# Generates keys, registers a handle, configures Telegram, and starts the daemon.
# Works both interactively and non-interactively (env vars override prompts).
#
# Env vars (all optional):
#   AGENT_CHAT_RELAY       — relay URL (default: production relay)
#   AGENT_SECRETS_DIR      — secrets directory (default: ~/.openclaw/secrets)
#   AGENT_CHAT_BOT_TOKEN   — Telegram bot token (auto-detected from OpenClaw if not set)
#   AGENT_CHAT_CHAT_ID     — Telegram chat_id
#   AGENT_CHAT_THREAD_ID   — Telegram thread_id for forum topics

# Check Node.js version (requires ≥18 for Ed25519/X25519 + global fetch)
NODE_VER=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js ≥ 18 required (found: $(node -v 2>/dev/null || echo 'not installed'))" >&2
  exit 1
fi
if [ "$NODE_VER" -lt 22 ]; then
  echo "⚠️  Node.js ≥ 22 recommended for native WebSocket. Will use HTTP polling fallback."
fi

HANDLE="${1:-}"
if [ -z "$HANDLE" ]; then
  echo "Usage: setup.sh <handle>" >&2
  echo ""
  echo "Env vars (optional):"
  echo "  AGENT_CHAT_BOT_TOKEN  — Telegram bot token"
  echo "  AGENT_CHAT_CHAT_ID    — Telegram chat_id"
  echo "  AGENT_CHAT_THREAD_ID  — Telegram thread_id (forum topics)"
  echo "  AGENT_SECRETS_DIR     — secrets dir (default: ~/.openclaw/secrets)"
  exit 1
fi

RELAY="${AGENT_CHAT_RELAY:-https://agent-chat-relay.rynn-openclaw.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_DIR="${AGENT_SECRETS_DIR:-$HOME/.openclaw/secrets}"
CONFIG_DIR="$SECRETS_DIR/agent-chat-$HANDLE"

# --- Step 1: Generate keys (skip if already exist) ---
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [ -f "$CONFIG_DIR/ed25519.priv" ] && [ -f "$CONFIG_DIR/x25519.priv" ]; then
  echo "🔑 Existing keys found for @$HANDLE — reusing"
else
  echo "🔑 Generating keys for @$HANDLE..."
  node --input-type=module -e "
import { generateEd25519KeyPair, generateX25519KeyPair } from '${SCRIPT_DIR}/../lib/crypto.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const configDir = '${CONFIG_DIR}';

const ed = await generateEd25519KeyPair();
writeFileSync(join(configDir, 'ed25519.pub'), Buffer.from(ed.publicKey, 'base64'));
writeFileSync(join(configDir, 'ed25519.priv'), Buffer.from(ed.privateKey, 'base64'));

const x = await generateX25519KeyPair();
writeFileSync(join(configDir, 'x25519.pub'), Buffer.from(x.publicKey, 'base64'));
writeFileSync(join(configDir, 'x25519.priv'), Buffer.from(x.privateKey, 'base64'));

writeFileSync(join(configDir, 'config.json'), JSON.stringify({ handle: '${HANDLE}', relay: '${RELAY}' }, null, 2));

console.log('  Ed25519: ' + ed.publicKey.slice(0, 16) + '...');
console.log('  X25519:  ' + x.publicKey.slice(0, 16) + '...');
"
  chmod 600 "$CONFIG_DIR/ed25519.priv" "$CONFIG_DIR/x25519.priv"
fi

# Ensure config.json exists (even if keys were reused)
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  echo "{\"handle\":\"$HANDLE\",\"relay\":\"$RELAY\"}" > "$CONFIG_DIR/config.json"
fi

# --- Step 2: Register with relay ---
echo ""
echo "📡 Registering @$HANDLE with relay ($RELAY)..."
REG_RESULT=$(AGENT_SECRETS_DIR="$SECRETS_DIR" AGENT_CHAT_RELAY="$RELAY" AGENT_CHAT_HANDLE="$HANDLE" \
  node "$SCRIPT_DIR/send.js" register "$HANDLE" 2>&1) || true
echo "$REG_RESULT"

# Check if registration failed
if echo "$REG_RESULT" | grep -q '"error"\|Error'; then
  if echo "$REG_RESULT" | grep -q 'already taken'; then
    echo ""
    echo "⚠️  Handle @$HANDLE is already registered on the relay."
    echo "   If you own it, your local keys may not match. Options:"
    echo "   1. Choose a different handle: bash $0 <other-handle>"
    echo "   2. If this is a fresh relay, ask the admin to clear the handle"
    echo ""
    echo "   Continuing with Telegram setup (daemon may fail to authenticate)..."
  elif echo "$REG_RESULT" | grep -q 'Cannot connect\|timed out\|Cannot resolve'; then
    echo ""
    echo "❌ Cannot reach relay at $RELAY"
    echo "   Check your internet connection and relay URL."
    exit 1
  else
    echo "❌ Registration failed." >&2
    exit 1
  fi
fi

# --- Step 3: Telegram configuration ---
echo ""
BOT_TOKEN="${AGENT_CHAT_BOT_TOKEN:-}"
CHAT_ID="${AGENT_CHAT_CHAT_ID:-}"
THREAD_ID="${AGENT_CHAT_THREAD_ID:-}"

# Auto-detect bot token from OpenClaw config if not provided
if [ -z "$BOT_TOKEN" ]; then
  OPENCLAW_CFG="$HOME/.openclaw/openclaw.json"
  if [ -f "$OPENCLAW_CFG" ]; then
    BOT_TOKEN=$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_CFG','utf8'));
        const t = c?.channels?.telegram?.botToken || c?.plugins?.entries?.telegram?.config?.botToken || '';
        if (t) process.stdout.write(t);
      } catch {}
    " 2>/dev/null || true)
    if [ -n "$BOT_TOKEN" ]; then
      echo "🔍 Auto-detected Telegram bot token from OpenClaw config"
    fi
  fi
fi

# Interactive fallback: ask user if running in a terminal and no token found
if [ -z "$BOT_TOKEN" ] && [ -t 0 ]; then
  read -p "Telegram bot token (for message delivery, Enter to skip): " BOT_TOKEN
  if [ -n "$BOT_TOKEN" ]; then
    read -p "Telegram chat_id: " CHAT_ID
    read -p "Telegram thread_id (Enter to skip): " THREAD_ID
  fi
fi

if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  CONFIG_FILE="$SECRETS_DIR/agent-chat-telegram.json"
  TGCONFIG="{\"botToken\":\"$BOT_TOKEN\",\"chatId\":\"$CHAT_ID\""
  if [ -n "$THREAD_ID" ]; then
    TGCONFIG="$TGCONFIG,\"threadId\":$THREAD_ID"
  fi
  TGCONFIG="$TGCONFIG}"
  echo "$TGCONFIG" > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "✅ Telegram config saved"
elif [ -n "$BOT_TOKEN" ] && [ -z "$CHAT_ID" ]; then
  echo "⚠️  Bot token set but no chat_id — set AGENT_CHAT_CHAT_ID to enable Telegram delivery"
else
  echo "ℹ️  No Telegram config — messages will be delivered via openclaw CLI or stdout"
fi

# --- Step 4: Done ---
echo ""
echo "✅ @$HANDLE setup complete!"
echo ""
echo "Start daemon:  AGENT_CHAT_HANDLE=$HANDLE node $SCRIPT_DIR/ws-daemon.js $HANDLE"
echo "Send message:  AGENT_CHAT_HANDLE=$HANDLE node $SCRIPT_DIR/send.js send <recipient> \"message\""
echo "Check status:  AGENT_CHAT_HANDLE=$HANDLE node $SCRIPT_DIR/send.js status"
