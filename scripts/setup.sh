#!/bin/bash
set -euo pipefail

# Agent Chat v2 — Setup Script
# Generates keys, registers a handle, configures Telegram, and starts the daemon.
# Works both interactively and non-interactively (env vars override prompts).
#
# Env vars (all optional):
#   AGENT_CHAT_RELAY       — relay URL (default: production relay)
#   AGENT_CHAT_DIR         — data directory (default: <workspace>/agent-chat/)
#   AGENT_CHAT_KEYS_DIR    — keys directory (default: <AGENT_CHAT_DIR>/keys/)
#   AGENT_CHAT_BOT_TOKEN   — Telegram bot token (auto-detected from OpenClaw if not set)
#   AGENT_CHAT_CHAT_ID     — Telegram chat_id
#   AGENT_CHAT_THREAD_ID   — Telegram thread_id for forum topics

# Check Node.js version (requires ≥18 for Ed25519/X25519 + global fetch)
NODE_VER=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js ≥ 18 required (found: $(node -v 2>/dev/null || echo 'not installed'))" >&2
  exit 1
fi
if [ "$NODE_VER" -lt 22 ]; then
  echo "⚠️  Node.js ≥ 22 recommended for native WebSocket. Will use HTTP polling fallback."
fi

HANDLE="${1:-}"
if [ -z "$HANDLE" ]; then
  if [ -t 0 ]; then
    # Interactive — ask user
    echo "🔧 Agent Chat Setup"
    echo ""
    printf "Choose a handle (lowercase, 3-32 chars, e.g. alice): "
    read -r HANDLE
    if [ -z "$HANDLE" ]; then
      echo "❌ Handle required" >&2
      exit 1
    fi
  else
    # Non-interactive — show usage
    echo "Usage: setup.sh <handle>" >&2
    echo ""
    echo "Env vars (optional):"
    echo "  AGENT_CHAT_BOT_TOKEN  — Telegram bot token"
    echo "  AGENT_CHAT_CHAT_ID    — Telegram chat_id"
    echo "  AGENT_CHAT_THREAD_ID  — Telegram thread_id (forum topics)"
    echo "  AGENT_CHAT_DIR        — data dir (default: <workspace>/agent-chat/)"
    echo "  AGENT_CHAT_KEYS_DIR   — keys dir (default: <data-dir>/keys/)"
    exit 1
  fi
fi

RELAY="${AGENT_CHAT_RELAY:-https://agent-chat-relay.rynn-openclaw.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve workspace
if [ -n "${AGENT_CHAT_WORKSPACE:-}" ]; then
  WORKSPACE="$AGENT_CHAT_WORKSPACE"
elif [ -f "$HOME/.openclaw/openclaw.json" ]; then
  WORKSPACE=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$HOME/.openclaw/openclaw.json','utf8'));console.log(c.workspace||'')}catch{}" 2>/dev/null || true)
  [ -z "$WORKSPACE" ] && WORKSPACE="$HOME/.openclaw/workspace"
else
  WORKSPACE="$HOME/.openclaw/workspace"
fi

# Resolve data dir and keys dir
DATA_DIR="${AGENT_CHAT_DIR:-$WORKSPACE/agent-chat}"
KEYS_DIR="${AGENT_CHAT_KEYS_DIR:-$DATA_DIR/keys}"
CONFIG_DIR="$KEYS_DIR/$HANDLE"

# Backward compat: check old layouts
# 1. Same dir but with agent-chat- prefix (old AGENT_SECRETS_DIR layout)
if [ ! -d "$CONFIG_DIR" ] && [ -d "$KEYS_DIR/agent-chat-$HANDLE" ]; then
  CONFIG_DIR="$KEYS_DIR/agent-chat-$HANDLE"
fi
# 2. Old default secrets dir
OLD_SECRETS_DIR="${AGENT_SECRETS_DIR:-$HOME/.openclaw/secrets}"
OLD_CONFIG_DIR="$OLD_SECRETS_DIR/agent-chat-$HANDLE"
if [ ! -d "$CONFIG_DIR" ] && [ -d "$OLD_CONFIG_DIR" ]; then
  echo "🔄 Found existing keys at old location ($OLD_CONFIG_DIR)"
  echo "   Migrating to $CONFIG_DIR..."
  mkdir -p "$KEYS_DIR"
  cp -r "$OLD_CONFIG_DIR" "$CONFIG_DIR"
  echo "   ✅ Migrated. Old files kept as backup."
fi

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
REG_RESULT=$(AGENT_CHAT_KEYS_DIR="$KEYS_DIR" AGENT_CHAT_DIR="$DATA_DIR" AGENT_CHAT_RELAY="$RELAY" AGENT_CHAT_HANDLE="$HANDLE" \
  node "$SCRIPT_DIR/send.js" register "$HANDLE" 2>&1) || true

# Check registration result
if echo "$REG_RESULT" | grep -q 'already taken'; then
  # Verify our local keys match the relay registration
  LOCAL_PUB=$(cat "$CONFIG_DIR/ed25519.pub" | base64 2>/dev/null || true)
  REMOTE_PUB=$(node -e "
    fetch('$RELAY/handle/info/$HANDLE')
      .then(r => r.json())
      .then(d => process.stdout.write(d.ed25519PublicKey || ''))
      .catch(() => {});
  " 2>/dev/null || true)
  if [ -n "$REMOTE_PUB" ] && [ "$LOCAL_PUB" != "$REMOTE_PUB" ]; then
    echo "⚠️  @$HANDLE is already taken (registered with different keys)."
    echo ""
    # Clean up the keys we just generated for the taken handle
    rm -rf "$CONFIG_DIR"
    if [ -t 0 ]; then
      read -p "Choose a different handle: " NEW_HANDLE
      if [ -n "$NEW_HANDLE" ]; then
        exec bash "$0" "$NEW_HANDLE" "${@:2}"
      fi
    fi
    echo "Re-run with a different handle: bash scripts/setup.sh <handle>"
    exit 1
  fi
  echo "✅ @$HANDLE already registered — keys match, reusing"
elif echo "$REG_RESULT" | grep -q 'Cannot connect\|Cannot reach\|timed out\|Cannot resolve'; then
  echo "❌ Cannot reach relay at $RELAY"
  exit 1
elif echo "$REG_RESULT" | grep -q '"error"\|Error'; then
  echo "$REG_RESULT"
  echo "❌ Registration failed." >&2
  exit 1
else
  echo "$REG_RESULT"
fi

# --- Step 3: Telegram configuration ---
echo ""
BOT_TOKEN="${AGENT_CHAT_BOT_TOKEN:-}"
CHAT_ID="${AGENT_CHAT_CHAT_ID:-}"
THREAD_ID="${AGENT_CHAT_THREAD_ID:-}"

# Auto-detect bot token and chat_id from OpenClaw config if not provided
# Skip auto-detect if AGENT_CHAT_DIR is explicitly set (custom/test setup)
OPENCLAW_HOME="$HOME/.openclaw"
OPENCLAW_CFG="$OPENCLAW_HOME/openclaw.json"
if [ -f "$OPENCLAW_CFG" ] && [ -z "${AGENT_CHAT_DIR:-}" ]; then
  if [ -z "$BOT_TOKEN" ]; then
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
  if [ -z "$CHAT_ID" ]; then
    CHAT_ID=$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_CFG','utf8'));
        const id = c?.channels?.telegram?.chatId || c?.plugins?.entries?.telegram?.config?.chatId || '';
        if (id) process.stdout.write(String(id));
      } catch {}
    " 2>/dev/null || true)
    if [ -n "$CHAT_ID" ]; then
      echo "🔍 Auto-detected Telegram chat_id from OpenClaw config"
    fi
  fi
fi

# Auto-detect chat_id from OpenClaw credentials (allowFrom list)
if [ -z "$CHAT_ID" ] && [ -f "$OPENCLAW_CFG" ] && [ -z "${AGENT_CHAT_DIR:-}" ]; then
  for AF in "$OPENCLAW_HOME/credentials/telegram-allowFrom.json" "$OPENCLAW_HOME/credentials/telegram-default-allowFrom.json"; do
    if [ -f "$AF" ]; then
      CHAT_ID=$(node -e "
        try {
          const d = JSON.parse(require('fs').readFileSync('$AF','utf8'));
          const ids = d?.allowFrom || [];
          const owner = ids.find(id => !/^[0-9]{10}$/.test(id)) || ids[0] || '';
          if (owner) process.stdout.write(String(owner));
        } catch {}
      " 2>/dev/null || true)
      if [ -n "$CHAT_ID" ]; then
        echo "🔍 Auto-detected Telegram chat_id from OpenClaw credentials"
        break
      fi
    fi
  done
fi

# Auto-detect chat_id from OpenClaw sessions
if [ -z "$CHAT_ID" ] && [ -f "$OPENCLAW_CFG" ] && [ -z "${AGENT_CHAT_DIR:-}" ]; then
  SESSIONS_FILE="$OPENCLAW_HOME/agents/main/sessions/sessions.json"
  if [ -f "$SESSIONS_FILE" ]; then
    CHAT_ID=$(node -e "
      try {
        const s = JSON.parse(require('fs').readFileSync('$SESSIONS_FILE','utf8'));
        for (const [k, v] of Object.entries(s)) {
          if (k.startsWith('telegram:') && v.provider === 'telegram') {
            const id = k.replace('telegram:', '');
            if (/^-?[0-9]+$/.test(id)) { process.stdout.write(id); break; }
          }
        }
      } catch {}
    " 2>/dev/null || true)
    if [ -n "$CHAT_ID" ]; then
      echo "🔍 Auto-detected Telegram chat_id from OpenClaw sessions"
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
  TG_DATA_FILE="$DATA_DIR/telegram.json"
  TG_TOKEN_FILE="$KEYS_DIR/telegram-token.json"

  # Reuse existing threadId from saved config, or create new
  if [ -z "$THREAD_ID" ] && [ -f "$TG_DATA_FILE" ]; then
    THREAD_ID=$(node -e "
      try { const c = JSON.parse(require('fs').readFileSync('$TG_DATA_FILE','utf8')); if (c.threadId) process.stdout.write(String(c.threadId)); } catch {}
    " 2>/dev/null || true)
    if [ -n "$THREAD_ID" ]; then
      echo "🔍 Reusing existing 📬 Agent Inbox (ID: $THREAD_ID)"
    fi
  fi

  if [ -z "$THREAD_ID" ]; then
    echo "Creating 📬 Agent Inbox thread..."
    TOPIC_RESULT=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic" \
      -d "chat_id=${CHAT_ID}" -d "name=📬 Agent Inbox" 2>/dev/null || true)
    TOPIC_ID=$(echo "$TOPIC_RESULT" | grep -o '"message_thread_id":[0-9]*' | head -1 | cut -d: -f2 || true)
    if [ -n "$TOPIC_ID" ]; then
      THREAD_ID="$TOPIC_ID"
      echo "✅ Created thread (ID: $THREAD_ID)"
    else
      echo "ℹ️ Could not create forum topic (chat may not be a forum). Delivering to main chat."
    fi
  fi

  if [ -n "$THREAD_ID" ]; then
    TG_DATA="{\"chatId\":\"$CHAT_ID\",\"threadId\":$THREAD_ID}"
  else
    TG_DATA="{\"chatId\":\"$CHAT_ID\"}"
  fi
  mkdir -p "$DATA_DIR"
  # Only write telegram.json if it doesn't exist or chatId changed
  if [ ! -f "$TG_DATA_FILE" ]; then
    echo "$TG_DATA" > "$TG_DATA_FILE"
    echo "✅ Telegram config saved"
  else
    EXISTING_CHAT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$TG_DATA_FILE','utf8')).chatId||'')}catch{}" 2>/dev/null || true)
    if [ "$EXISTING_CHAT" = "$CHAT_ID" ]; then
      echo "🔍 Telegram config already exists — reusing"
    else
      echo "$TG_DATA" > "$TG_DATA_FILE"
      echo "✅ Telegram config updated (chatId changed)"
    fi
  fi

  # Save bot token separately in keys dir (secret) — only if missing
  mkdir -p "$KEYS_DIR"
  if [ ! -f "$TG_TOKEN_FILE" ]; then
    echo "{\"botToken\":\"$BOT_TOKEN\"}" > "$TG_TOKEN_FILE"
    chmod 600 "$TG_TOKEN_FILE"
  fi
elif [ -n "$BOT_TOKEN" ] && [ -z "$CHAT_ID" ]; then
  echo "⚠️  Bot token found but no chat_id"
  echo "   Set AGENT_CHAT_CHAT_ID and re-run, or your AI agent can find it from inbound message metadata"
else
  echo "ℹ️  No Telegram config — messages will be delivered via AGENT_DELIVER_CMD, openclaw CLI, or stdout"
  echo "   To add Telegram later: set AGENT_CHAT_BOT_TOKEN + AGENT_CHAT_CHAT_ID and re-run setup"
  echo "   For other platforms: set AGENT_DELIVER_CMD to a script that receives \$AGENT_MSG"
fi

# --- Step 3b: Bootstrap session in OpenClaw sessions.json ---
# Creates a minimal session entry so the daemon can deliver to AI immediately.
# With thread: bootstraps thread session (agent:main:main:thread:ID).
# Without thread: uses existing main session (agent:main:main) — no bootstrap needed.
if [ -n "$CHAT_ID" ]; then
  SESSIONS_FILE="$HOME/.openclaw/agents/main/sessions/sessions.json"
  if [ -f "$SESSIONS_FILE" ]; then
    if [ -n "$THREAD_ID" ]; then
      SESSION_KEY="agent:main:main:thread:${THREAD_ID}"
      EXISTING=$(node -e "
        const s = JSON.parse(require('fs').readFileSync('$SESSIONS_FILE','utf8'));
        console.log(s['$SESSION_KEY']?.sessionId || '');
      " 2>/dev/null)
      if [ -z "$EXISTING" ]; then
        SESSION_UUID=$(node -e "console.log(require('crypto').randomUUID())")
        SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
        TRANSCRIPT="${SESSIONS_DIR}/${SESSION_UUID}-topic-${THREAD_ID}.jsonl"
        touch "$TRANSCRIPT"
        node -e "
          const fs = require('fs');
          const s = JSON.parse(fs.readFileSync('$SESSIONS_FILE','utf8'));
          s['$SESSION_KEY'] = {
            sessionId: '$SESSION_UUID',
            sessionFile: '$TRANSCRIPT',
            updatedAt: Date.now(),
            lastChannel: 'telegram',
            lastTo: 'telegram:$CHAT_ID',
            lastThreadId: $THREAD_ID,
            channel: 'telegram',
            chatType: 'direct',
            deliveryContext: {
              channel: 'telegram',
              to: 'telegram:$CHAT_ID',
              accountId: 'default',
              threadId: $THREAD_ID
            }
          };
          fs.writeFileSync('$SESSIONS_FILE', JSON.stringify(s, null, 2));
        " 2>/dev/null && echo "✅ Thread session bootstrapped" || echo "⚠️  Session bootstrap skipped (non-critical)"
      else
        echo "🔍 Thread session already exists (UUID: ${EXISTING:0:8}...)"
      fi
    else
      # No thread — check that main session exists (it should if user has chatted before)
      MAIN_UUID=$(node -e "
        const s = JSON.parse(require('fs').readFileSync('$SESSIONS_FILE','utf8'));
        console.log(s['agent:main:main']?.sessionId || '');
      " 2>/dev/null)
      if [ -n "$MAIN_UUID" ]; then
        echo "✅ Using main DM session for AI delivery"
      else
        echo "ℹ️  No main session yet — AI delivery will work after your first message to the bot"
      fi
    fi
  else
    echo "ℹ️  No sessions.json found — session will be created on first message"
  fi
fi

# --- Step 4: Persistent daemon (default on, skip with --no-daemon or AGENT_CHAT_DAEMON=0) ---
INSTALL_DAEMON="${AGENT_CHAT_DAEMON:-1}"
for arg in "$@"; do
  [ "$arg" = "--no-daemon" ] && INSTALL_DAEMON=0
  [ "$arg" = "--daemon" ] && INSTALL_DAEMON=1
done

if [ "$INSTALL_DAEMON" = "1" ]; then
  NODE_PATH="$(which node)"
  
  if [ "$(uname)" = "Darwin" ]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/com.agent-chat.$HANDLE.plist"
    mkdir -p "$PLIST_DIR"
    
    # Unload old version if exists
    launchctl unload "$PLIST" 2>/dev/null || true
    
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-chat.$HANDLE</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SCRIPT_DIR/ws-daemon.js</string>
        <string>$HANDLE</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_CHAT_HANDLE</key>
        <string>$HANDLE</string>
        <key>AGENT_CHAT_DIR</key>
        <string>$DATA_DIR</string>
        <key>AGENT_CHAT_KEYS_DIR</key>
        <string>$KEYS_DIR</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/agent-chat-$HANDLE.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/agent-chat-$HANDLE.log</string>
</dict>
</plist>
PLIST
    
    launchctl bootout "gui/$(id -u)/com.agent-chat.$HANDLE" 2>/dev/null || true
    launchctl load "$PLIST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    echo "🔄 Daemon installed + started (LaunchAgent)"
    echo "   Log: /tmp/agent-chat-$HANDLE.log"
    
  elif command -v systemctl >/dev/null 2>&1; then
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/agent-chat-$HANDLE.service"
    mkdir -p "$UNIT_DIR"
    
    cat > "$UNIT" <<UNIT
[Unit]
Description=Agent Chat Daemon (@$HANDLE)

[Service]
ExecStart=$NODE_PATH $SCRIPT_DIR/ws-daemon.js $HANDLE
Environment=AGENT_CHAT_HANDLE=$HANDLE
Environment=AGENT_CHAT_DIR=$DATA_DIR
Environment=AGENT_CHAT_KEYS_DIR=$KEYS_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
    
    systemctl --user daemon-reload
    systemctl --user enable --now "agent-chat-$HANDLE"
    echo "🔄 Daemon installed + started (systemd)"
    echo "   Log: journalctl --user -u agent-chat-$HANDLE -f"
    
  else
    echo "⚠️  No LaunchAgent/systemd found — start daemon manually:"
    echo "   AGENT_CHAT_HANDLE=$HANDLE node $SCRIPT_DIR/ws-daemon.js $HANDLE"
  fi
fi

# --- Done ---
echo ""
echo "✅ @$HANDLE setup complete!"
if [ "$INSTALL_DAEMON" != "1" ]; then
  echo ""
  echo "Start daemon:  AGENT_CHAT_HANDLE=$HANDLE node $SCRIPT_DIR/ws-daemon.js $HANDLE"
  echo "   Persistent: bash $0 $HANDLE"
fi
