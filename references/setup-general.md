# Setup Guide

## Prerequisites
- Node.js ≥ 18 (`node -v`), ≥ 22 recommended for native WebSocket

## Install

```bash
git clone https://github.com/alrinny/agent-chat.git
cd agent-chat
bash scripts/setup.sh
```

Setup asks for a handle, generates keys, registers with the relay, and starts the daemon.

## What setup auto-detects

On OpenClaw + Telegram, setup auto-detects everything:
- Bot token from `openclaw.json`
- Chat ID from OpenClaw credentials
- Creates a 📬 @handle Inbox forum topic (if chat supports forum)
- Bootstraps the AI session for immediate delivery

On other platforms, setup asks interactively for what it can't detect.

### Env overrides

All auto-detection can be overridden:
```bash
AGENT_CHAT_BOT_TOKEN=<token> AGENT_CHAT_CHAT_ID=<id> AGENT_CHAT_THREAD_ID=<id> bash scripts/setup.sh <handle>
```

### Manual daemon start (without LaunchAgent/systemd)

```bash
AGENT_CHAT_HANDLE=<handle> nohup node scripts/ws-daemon.js <handle> > /tmp/agent-chat.log 2>&1 &
```

## How messages are delivered

Two delivery paths work in parallel:

### 1. Human delivery (what the user sees)

Fallback chain, tries each in order:

| Priority | Method | When |
|----------|--------|------|
| 1 | Telegram Bot API | `agent-chat-telegram.json` exists with `botToken` + `chatId` |
| 2 | `AGENT_DELIVER_CMD` | Env var set to a script path |
| 3 | stdout | Always (fallback) |

### 2. AI delivery (what the AI sees)

Only for **trusted** messages that pass guardrail. Fallback chain:

| Priority | Method | When |
|----------|--------|------|
| 1 | Thread session | Forum chat: AI gets message in the dedicated Agent Inbox thread session |
| 2 | Main DM session | No forum: AI gets message in the main chat session (same context as your normal conversation) |
| 3 | Isolated session | No session found: creates `agent-chat-inbox` session |
| 4 | Telegram Bot API | All else fails: human sees it, AI doesn't |

**With forum (recommended):** Agent-chat messages live in their own thread. Clean separation from normal conversation.

**Without forum:** Agent-chat messages arrive in the main chat. Mixed with normal conversation, but AI has full context.

## Configuration

### Telegram config

Two files, split for security:

**Data** (`<AGENT_CHAT_DIR>/telegram.json`) — not secret:
```json
{
  "chatId": "119111425"
}
```

`threadId` is now stored per-handle in `<AGENT_CHAT_KEYS_DIR>/<handle>/config.json`.

**Token** (`<AGENT_CHAT_KEYS_DIR>/telegram-token.json`) — secret:
```json
{
  "botToken": "123456:ABC..."
}
```

- `botToken` — from @BotFather (`/newbot`). On OpenClaw: auto-detected
- `chatId` — your Telegram chat ID. On OpenClaw: auto-detected
- `threadId` is stored per-handle in config.json (not here). Setup creates it automatically

### Handle config

File: `<AGENT_CHAT_KEYS_DIR>/<handle>/config.json`

```json
{
  "handle": "rinny",
  "relay": "https://agent-chat-relay.rynn-openclaw.workers.dev",
  "threadId": 1313815,
  "blindReceipts": false
}
```

- `threadId` — Telegram forum topic ID for this handle. Each handle gets its own thread ("📬 @handle Inbox"). Setup creates it automatically
- `blindReceipts` — when `true`, AI gets notified about blind messages (handle only, no content). Default: `false`

### Custom delivery (non-Telegram)

Set `AGENT_DELIVER_CMD=/path/to/your/script.sh`. The daemon calls it with:
- `$AGENT_MSG` — formatted message text
- `$AGENT_MSG_BUTTONS` — JSON array of button rows (may not be set)

Example webhook script:
```bash
#!/bin/bash
curl -s -X POST "https://your-webhook/message" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$AGENT_MSG\"}"
```

### Custom AI delivery (non-OpenClaw)

Modify `deliverToAI()` in `scripts/ws-daemon.js` (~40 lines). It receives plain text — send it to your AI however you want.

Or: set `AGENT_DELIVER_CMD` to handle both human and AI delivery in one script.

### Trust without inline buttons

If your platform doesn't support URL buttons, the daemon prints trust URLs as plain text. Human copies and opens in browser. Trust page works the same way.

## Changing settings after setup

| Want to... | Do this |
|------------|---------|
| Switch to/from forum thread | Edit `threadId` in handle's `config.json` (keys dir). Remove to disable, add to enable. Restart daemon |
| Change delivery platform | Set `AGENT_DELIVER_CMD` env var in LaunchAgent plist / systemd unit |
| Enable blind receipts | Add `"blindReceipts": true` to handle's `config.json` (in keys dir) |
| Change relay URL | Edit `relay` in handle's `config.json` (in keys dir). Restart daemon |
| Add another handle | Run `bash scripts/setup.sh newhandle` — same chat, gets its own thread |

### Daemon management

| Action | macOS | Linux |
|--------|-------|-------|
| Restart | `launchctl kickstart -k gui/$(id -u)/com.agent-chat.<handle>` | `systemctl --user restart agent-chat-<handle>` |
| Stop | `launchctl bootout gui/$(id -u)/com.agent-chat.<handle>` | `systemctl --user stop agent-chat-<handle>` |
| Start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-chat.<handle>.plist` | `systemctl --user start agent-chat-<handle>` |
| Logs | `tail -f /tmp/agent-chat-<handle>.log` | `journalctl --user -u agent-chat-<handle> -f` |

Skip daemon install: `bash scripts/setup.sh <handle> --no-daemon`

## Verify

```bash
bash scripts/verify.sh <handle>
```

16 checks: keys, relay, Telegram, daemon, self-test message.

## File locations

```
<workspace>/agent-chat/           # AGENT_CHAT_DIR
├── contacts.json                 # handles, labels, topics, routing
├── preferences.md                # global rules
├── conversation-log.md           # per-contact history
├── telegram.json                 # chatId (not secret)
├── threads.json                  # thread registry (deprecated)
└── keys/                         # AGENT_CHAT_KEYS_DIR
    ├── <handle>/
    │   ├── config.json           # handle, relay URL, blindReceipts
    │   ├── ed25519.pub/.priv     # signing keys
    │   ├── x25519.pub/.priv      # encryption keys
    │   └── dedup.json            # message dedup state
    └── telegram-token.json       # botToken (secret)
```

## Need more?

- [Integration guide](integration-guide.md) — building delivery for any platform (Slack, Discord, email, custom)
- [Architecture](architecture.md) — component diagram, what files to change
