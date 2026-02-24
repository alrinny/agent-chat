#!/usr/bin/env bash
# verify.sh — Check that agent-chat is installed and working correctly.
# Usage: bash scripts/verify.sh [handle]
# Exit code 0 = all checks passed.

set -euo pipefail

HANDLE="${1:-${AGENT_CHAT_HANDLE:-}}"
SECRETS_DIR="${AGENT_SECRETS_DIR:-$HOME/.openclaw/secrets}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

echo "🔍 Agent Chat — Verification"
echo ""

# --- 1. Node.js ---
echo "1. Node.js"
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "Node.js $NODE_VER (native WebSocket ✅)"
  elif [ "$NODE_MAJOR" -ge 18 ]; then
    warn "Node.js $NODE_VER (works, but ≥22 recommended for WebSocket)"
  else
    fail "Node.js $NODE_VER — requires ≥18"
  fi
else
  fail "Node.js not found"
fi

# --- 2. Handle ---
echo "2. Handle"
if [ -z "$HANDLE" ]; then
  fail "No handle provided. Usage: bash verify.sh <handle>"
  echo ""
  echo "Result: $PASS passed, $FAIL failed, $WARN warnings"
  exit 1
fi
ok "Handle: $HANDLE"

# --- 3. Keys ---
echo "3. Keys"
KEY_DIR="$SECRETS_DIR/agent-chat-$HANDLE"
for f in ed25519.pub ed25519.priv x25519.pub x25519.priv config.json; do
  if [ -f "$KEY_DIR/$f" ]; then
    ok "$f exists"
  else
    fail "$f missing in $KEY_DIR/"
  fi
done

# --- 4. Config ---
echo "4. Config"
if [ -f "$KEY_DIR/config.json" ]; then
  RELAY=$(node -e "const c=JSON.parse(require('fs').readFileSync('$KEY_DIR/config.json','utf8')); console.log(c.relay||'')" 2>/dev/null || echo "")
  CONF_HANDLE=$(node -e "const c=JSON.parse(require('fs').readFileSync('$KEY_DIR/config.json','utf8')); console.log(c.handle||'')" 2>/dev/null || echo "")
  if [ "$CONF_HANDLE" = "$HANDLE" ]; then
    ok "Config handle matches: $CONF_HANDLE"
  else
    fail "Config handle '$CONF_HANDLE' ≠ '$HANDLE'"
  fi
  if [ -n "$RELAY" ]; then
    ok "Relay: $RELAY"
  else
    fail "No relay URL in config.json"
  fi
else
  fail "config.json not found"
  RELAY=""
fi

# --- 5. Relay connectivity ---
echo "5. Relay"
if [ -n "$RELAY" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$RELAY/handle/info/$HANDLE" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    ok "Relay reachable, handle registered"
  elif [ "$STATUS" = "404" ]; then
    fail "Relay reachable but handle '$HANDLE' not found (not registered?)"
  elif [ "$STATUS" = "000" ]; then
    fail "Cannot reach relay at $RELAY"
  else
    warn "Relay returned HTTP $STATUS"
  fi
else
  fail "Skipped — no relay URL"
fi

# --- 6. Daemon ---
echo "6. Daemon"
if pgrep -f "ws-daemon.js.*$HANDLE" &>/dev/null; then
  ok "Daemon running (ws-daemon.js $HANDLE)"
else
  warn "Daemon not running. Start: AGENT_CHAT_HANDLE=$HANDLE node scripts/ws-daemon.js $HANDLE"
fi

# Check LaunchAgent (macOS)
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.agent-chat.$HANDLE.plist"
  if [ -f "$PLIST" ]; then
    ok "LaunchAgent installed: $PLIST"
  else
    warn "No LaunchAgent plist (daemon won't auto-start on reboot)"
  fi
fi

# Check systemd (Linux)
if [ "$(uname)" = "Linux" ] && command -v systemctl &>/dev/null; then
  if systemctl --user is-enabled "agent-chat-$HANDLE" &>/dev/null; then
    ok "systemd service enabled"
  else
    warn "No systemd service (daemon won't auto-start on reboot)"
  fi
fi

# --- 7. Telegram (optional) ---
echo "7. Telegram (optional)"
TG_CONFIG="$SECRETS_DIR/agent-chat-telegram.json"
if [ -f "$TG_CONFIG" ]; then
  HAS_TOKEN=$(node -e "const c=JSON.parse(require('fs').readFileSync('$TG_CONFIG','utf8')); console.log(c.botToken?'yes':'no')" 2>/dev/null || echo "no")
  HAS_CHAT=$(node -e "const c=JSON.parse(require('fs').readFileSync('$TG_CONFIG','utf8')); console.log(c.chatId?'yes':'no')" 2>/dev/null || echo "no")
  HAS_THREAD=$(node -e "const c=JSON.parse(require('fs').readFileSync('$TG_CONFIG','utf8')); console.log(c.threadId?'yes':'no')" 2>/dev/null || echo "no")
  [ "$HAS_TOKEN" = "yes" ] && ok "Bot token configured" || fail "Bot token missing"
  [ "$HAS_CHAT" = "yes" ] && ok "Chat ID configured" || fail "Chat ID missing"
  [ "$HAS_THREAD" = "yes" ] && ok "Thread ID configured (forum topic)" || warn "No thread ID (messages go to main chat)"
else
  warn "No Telegram config — delivery via AGENT_DELIVER_CMD or stdout"
fi

# --- 8. Send test (optional) ---
echo "8. Self-test"
if [ -n "$RELAY" ]; then
  echo "  → Sending test message to @$HANDLE..."
  OUTPUT=$(AGENT_CHAT_HANDLE="$HANDLE" node "$SCRIPT_DIR/send.js" send "$HANDLE" "Test message to self" 2>&1 || echo "SEND_FAILED")
  if echo "$OUTPUT" | grep -q "Sent to"; then
    ok "Test message sent (check delivery in ~5s)"
  else
    fail "Send failed: $OUTPUT"
  fi
else
  fail "Skipped — no relay"
fi

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ $PASS passed  ❌ $FAIL failed  ⚠️  $WARN warnings"
if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 All checks passed!"
else
  echo "  ⚠️  Fix the failures above and re-run."
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit "$FAIL"
