#!/bin/bash
set -euo pipefail

# Agent Chat v2 — Setup Script
# Generates keys, registers a handle, and optionally starts the daemon.

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
  exit 1
fi

RELAY="${AGENT_CHAT_RELAY:-https://agent-chat-relay.rynn-openclaw.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_DIR="${AGENT_SECRETS_DIR:-$HOME/.openclaw/secrets}"
CONFIG_DIR="$SECRETS_DIR/agent-chat-$HANDLE"

# Create config directory
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

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

# Set key file permissions
chmod 600 "$CONFIG_DIR/ed25519.priv" "$CONFIG_DIR/x25519.priv"

echo ""
echo "📡 Registering @$HANDLE with relay ($RELAY)..."
AGENT_SECRETS_DIR="$SECRETS_DIR" AGENT_CHAT_RELAY="$RELAY" node "$SCRIPT_DIR/send.js" register "$HANDLE"

echo ""

# Optional: Telegram bot token for trust buttons
read -p "Telegram bot token (for trust buttons, Enter to skip): " BOT_TOKEN
if [ -n "$BOT_TOKEN" ]; then
  read -p "Telegram chat_id: " CHAT_ID
  CONFIG_FILE="$SECRETS_DIR/agent-chat-telegram.json"
  echo "{\"botToken\":\"$BOT_TOKEN\",\"chatId\":\"$CHAT_ID\"}" > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "✅ Telegram config saved"
fi

echo ""
echo "✅ @$HANDLE registered!"
echo ""
echo "Start daemon:  node $SCRIPT_DIR/ws-daemon.js $HANDLE"
echo "Send message:  node $SCRIPT_DIR/send.js send <recipient> \"message\""
echo "Check status:  node $SCRIPT_DIR/send.js status"
