#!/usr/bin/env bash
# Agent Chat — Wipe script
# Default: soft wipe (daemon + transient state, keeps keys/contacts/config/handles)
# --full:  hard wipe (unregisters handles, deletes everything)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Resolve paths (same logic as setup.sh) ---
WORKSPACE=""
if [ -n "${AGENT_CHAT_DIR:-}" ]; then
  WORKSPACE="$AGENT_CHAT_DIR"
elif command -v openclaw &>/dev/null; then
  OC_WORKSPACE=$(openclaw status 2>/dev/null | grep -i workspace | head -1 | awk '{print $NF}' || true)
  [ -n "$OC_WORKSPACE" ] && WORKSPACE="$OC_WORKSPACE/agent-chat"
fi
[ -z "$WORKSPACE" ] && WORKSPACE="$HOME/.openclaw/workspace/agent-chat"

KEYS_DIR="${AGENT_CHAT_KEYS_DIR:-$WORKSPACE/keys}"
FULL=false
[ "${1:-}" = "--full" ] && FULL=true

echo "🧹 Agent Chat Wipe"
echo "   Data:  $WORKSPACE"
echo "   Keys:  $KEYS_DIR"
echo "   Mode:  $($FULL && echo 'FULL (unregister + delete everything)' || echo 'soft (keep keys, contacts, config, handles)')"
echo ""

# --- 1. Kill daemon processes ---
echo "1. Stopping daemons..."
KILLED=0
for pid in $(pgrep -f "ws-daemon.js" 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null && ((KILLED++)) || true
done
echo "   Killed $KILLED daemon process(es)"

# --- 2. Remove LaunchAgents / systemd units ---
echo "2. Removing service files..."
REMOVED=0
for plist in "$HOME/Library/LaunchAgents"/com.agent-chat.*.plist; do
  [ -f "$plist" ] || continue
  LABEL=$(basename "$plist" .plist)
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
  ((REMOVED++))
  echo "   Removed $LABEL"
done
# Linux systemd
for unit in "$HOME/.config/systemd/user"/agent-chat-*.service; do
  [ -f "$unit" ] || continue
  NAME=$(basename "$unit" .service)
  systemctl --user stop "$NAME" 2>/dev/null || true
  systemctl --user disable "$NAME" 2>/dev/null || true
  rm -f "$unit"
  systemctl --user daemon-reload 2>/dev/null || true
  ((REMOVED++))
  echo "   Removed $NAME"
done
[ "$REMOVED" -eq 0 ] && echo "   None found"

# --- 3. Delete Telegram threads (per-handle) ---
echo "3. Telegram threads..."
TG_FILE="$WORKSPACE/telegram.json"
TG_TOKEN_FILE="$KEYS_DIR/telegram-token.json"
CHAT_ID=""
BOT_TOKEN=""
if [ -f "$TG_FILE" ]; then
  CHAT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TG_FILE','utf8')).chatId || '')" 2>/dev/null || true)
fi
if [ -f "$TG_TOKEN_FILE" ]; then
  BOT_TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TG_TOKEN_FILE','utf8')).botToken || '')" 2>/dev/null || true)
fi
THREADS_DELETED=0
if [ -n "$CHAT_ID" ] && [ -n "$BOT_TOKEN" ]; then
  # Delete threads from per-handle config.json
  for config in "$KEYS_DIR"/*/config.json; do
    [ -f "$config" ] || continue
    THREAD_ID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$config','utf8')).threadId||'')}catch{}" 2>/dev/null || true)
    [ -z "$THREAD_ID" ] && continue
    HANDLE_NAME=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$config','utf8')).handle||'')}catch{}" 2>/dev/null || true)
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/closeForumTopic" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"$CHAT_ID\",\"message_thread_id\":$THREAD_ID}" >/dev/null 2>&1 || true
    RESULT=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"$CHAT_ID\",\"message_thread_id\":$THREAD_ID}" 2>/dev/null || true)
    if echo "$RESULT" | grep -q '"ok":true'; then
      echo "   Deleted thread $THREAD_ID (@${HANDLE_NAME:-unknown})"
      ((THREADS_DELETED++))
    else
      echo "   Could not delete thread $THREAD_ID (may not exist or no permission)"
    fi
  done
  [ "$THREADS_DELETED" -eq 0 ] && echo "   No threads found"
else
  echo "   No Telegram config found"
fi

# --- 4. Remove transient files ---
echo "4. Cleaning transient files..."
for f in threads.json .first-delivery-done; do
  [ -f "$WORKSPACE/$f" ] && rm -f "$WORKSPACE/$f" && echo "   Removed $f"
done
# dedup.json is per-handle inside keys dir
for dd in "$KEYS_DIR"/*/dedup.json; do
  [ -f "$dd" ] || continue
  rm -f "$dd"
  echo "   Removed $(basename "$(dirname "$dd")")/dedup.json"
done
# Daemon logs
for log in /tmp/agent-chat-*.log; do
  [ -f "$log" ] || continue
  rm -f "$log"
  echo "   Removed $(basename "$log")"
done

# --- 5. Full mode: unregister + delete everything ---
if $FULL; then
  echo "5. Unregistering handles..."
  for config in "$KEYS_DIR"/*/config.json; do
    [ -f "$config" ] || continue
    HANDLE_DIR=$(dirname "$config")
    HANDLE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$config','utf8')).handle || '')" 2>/dev/null || true)
    [ -z "$HANDLE" ] && continue
    echo -n "   @$HANDLE: "
    AGENT_CHAT_DIR="$WORKSPACE" AGENT_CHAT_KEYS_DIR="$KEYS_DIR" AGENT_CHAT_HANDLE="$HANDLE" \
      node "$SCRIPT_DIR/send.js" unregister 2>/dev/null && echo "" || echo "failed (may already be unregistered)"
  done

  echo "6. Deleting all data..."
  if [ "$KEYS_DIR" != "$WORKSPACE/keys" ] && [ -d "$KEYS_DIR" ]; then
    rm -rf "$KEYS_DIR"
    echo "   Removed $KEYS_DIR"
  fi
  if [ -d "$WORKSPACE" ]; then
    rm -rf "$WORKSPACE"
    echo "   Removed $WORKSPACE"
  fi
else
  echo "5. Keeping: keys, config, contacts, preferences, telegram config, handles on relay"
fi

echo ""
echo "✅ Wipe complete ($($FULL && echo 'full' || echo 'soft'))"
$FULL && echo "   Run setup.sh to start fresh" || echo "   Run setup.sh to re-setup (existing keys & contacts will be reused)"
