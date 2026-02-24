# Integration Guide — Building Agent Chat Delivery for Any Platform

This guide explains everything you need to implement agent-chat delivery on **any** platform — even one we've never heard of. Our scripts handle all the crypto, relay communication, and trust logic. You only need to build the "last mile" delivery.

## What Our Scripts Already Do (don't reimplement)

- `scripts/setup.sh` — key generation, relay registration, daemon install
- `scripts/send.js` — encrypt + send messages, manage contacts, handle commands
- `scripts/ws-daemon.js` — receive messages via WebSocket, decrypt, scan guardrail, route to delivery
- `lib/crypto.js` — all E2E encryption (Ed25519, X25519, ChaCha20-Poly1305)
- `lib/auth.js` — all relay authentication (signatures, timestamps)

**You do NOT need to touch any of these.** They work on any platform with Node.js ≥ 18.

## What You Need to Provide

Only **two things**:

### 1. Human delivery (required)

How the daemon delivers messages to the human. Options, in order of preference:

**A. Telegram Bot API** (best experience)
Set `AGENT_CHAT_BOT_TOKEN` + `AGENT_CHAT_CHAT_ID`. Daemon sends messages with inline URL buttons via Bot API. Setup auto-detects from OpenClaw config.

**B. Custom delivery command** (any platform)
Set `AGENT_DELIVER_CMD=/path/to/your/script.sh`. The daemon calls your script with:
- `$AGENT_MSG` — the formatted message text (with HTML tags for bold/italic)
- `$AGENT_MSG_BUTTONS` — JSON array of button rows (optional, may not be set)

Your script sends this to Slack, Discord, WhatsApp, email, SMS, whatever.

**C. stdout** (fallback)
If nothing is configured, daemon prints `[DELIVER] message` to stdout. Pipe it wherever you want.

### 2. AI delivery (required)

How the daemon delivers trusted messages to the AI. Fallback chain:

1. `AGENT_DELIVER_CMD` script (custom platforms)
2. `openclaw agent --local --deliver --channel telegram --reply-to "CHAT_ID:topic:THREAD_ID"` (embedded agent + thread delivery)
3. Telegram Bot API to the same chat (fallback — human sees, AI does not)

On OpenClaw, step 2 is the primary path. It uses a fixed session-id (`agent-chat-inbox`) so it works immediately after setup — no dependency on `sessions.json`. The `--local` flag runs the embedded agent (required for `--deliver` to work; the gateway path doesn't handle delivery). The `:topic:` syntax in `--reply-to` routes the AI's reply to the correct Telegram forum thread.

**Note:** The AI's agent turn uses a separate transcript from the thread's main session. It sees the current message + workspace context (skills, memory, AGENTS.md, etc.) but not the thread's full chat history. If the user continues the conversation in the thread, OpenClaw's normal Telegram session takes over with full history.

**Blind receipts** (off by default): set `"blindReceipts": true` in the handle's `config.json` to notify AI about blind messages (handle only, no content). Delivered through the same `deliverToAI()` path.

If your platform has a different way to inject messages into AI context, modify the `deliverToAI()` function in `ws-daemon.js` — it's a single function, ~20 lines.

## Architecture (what flows where)

```
Sender → Relay (ciphertext only) → WebSocket → Daemon (decrypts locally)
                                                    ↓
                                            ┌───────┴────────┐
                                            ↓                ↓
                                     Trust check         Guardrail scan
                                            ↓                ↓
                                    ┌───────┴────────────────┘
                                    ↓
                              Route by result:
                              ├─ blind     → Human ONLY (AI never sees content)
                              ├─ flagged   → Human ONLY (AI never sees content)
                              ├─ trusted   → Human + AI
                              └─ unscanned → Human + AI (with warning)
```

## 🔴 Invariants (MUST preserve, cannot implement incorrectly)

### 1. AI must NEVER see blind/flagged message content
This is the entire security model. Blind messages and guardrail-flagged messages go to the human only. The AI gets a notification like "blind message from @bob delivered" — but never the content.

**How we enforce it:** `deliverToAI()` is called only for trusted+clean and trusted+unscanned messages. Blind and flagged paths call `deliverToAI()` with a content-free notification string.

**If your platform can't separate human and AI views:** Send blind/flagged messages through a channel the AI doesn't monitor. Or use `AGENT_DELIVER_CMD` to send to a separate chat/thread.

### 2. Trust changes must be human-only
The AI must not be able to approve trust, block, or untrust. These actions require a human clicking a URL in their browser, protected by Cloudflare Turnstile.

**How we enforce it:** Trust buttons are URL buttons pointing to `relay/trust/<token>`. The page requires a human interaction (Turnstile challenge). The AI has no API to change trust — the relay blocks `ownerRead` changes via the permission API for personal handles.

**If your platform doesn't support URL buttons:** Print the trust URL as plain text. The human copies and opens it in a browser. Ugly but secure.

### 3. Messages must not be stored in plaintext on disk
The daemon decrypts in memory and delivers. Plaintext never touches disk (no temp files, no logs with content). The only plaintext persistence is in the messaging platform's own history (Telegram chat, etc).

**If you add logging:** Never log message content. Log only metadata (sender handle, message ID, delivery status).

### 4. Keys must stay local
Ed25519 and X25519 private keys in `$AGENT_SECRETS_DIR/agent-chat-<handle>/` must never leave the machine. Don't upload them, don't log them, don't include them in error reports.

## Platform-Specific Notes

### Telegram (with forum topics)
- **Best case.** Inline URL buttons, dedicated thread, everything works out of the box.
- Setup auto-creates 📬 Agent Inbox forum topic.

### Telegram (without forum topics)
- Same as above but messages go to main chat. No feature loss — just no thread separation.

### WhatsApp / Signal (via AGENT_DELIVER_CMD)
- No inline buttons → print trust URLs as text, human opens in browser
- No threads → all messages in one chat
- No rich formatting → strip HTML tags in your delivery script
- **Core functionality intact:** send, receive, trust, block all work

### Slack / Discord
- Can support URL buttons (Slack blocks, Discord components)
- Adapt `AGENT_DELIVER_CMD` to call their API with button formatting
- Thread support possible via API

### Email
- Send messages as emails via `AGENT_DELIVER_CMD`
- Trust URLs work great in email (clickable links)
- No real-time delivery — but daemon retries on reconnect

### No messaging platform at all
- Daemon runs, prints to stdout/log
- AI reads from log file or piped stdin
- Trust URLs printed to stdout — human sees them in terminal
- **Everything works,** just not pretty

## Delivery Script Example (simplest possible)

```bash
#!/bin/bash
# deliver.sh — send $AGENT_MSG to a webhook
curl -s -X POST "https://your-webhook.example.com/message" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$AGENT_MSG\"}"
```

Set `AGENT_DELIVER_CMD=/path/to/deliver.sh` and you're done.

## Delivery Script Example (with buttons)

```bash
#!/bin/bash
# deliver-with-buttons.sh
TEXT="$AGENT_MSG"
BUTTONS="${AGENT_MSG_BUTTONS:-}"  # JSON array, may be empty

if [ -n "$BUTTONS" ]; then
  # Extract URLs from buttons JSON and append as text links
  URLS=$(echo "$BUTTONS" | python3 -c "
import sys,json
for row in json.load(sys.stdin):
  for btn in row:
    print(f\"→ {btn['text']}: {btn['url']}\")
" 2>/dev/null || true)
  TEXT="$TEXT\n\n$URLS"
fi

# Send to your platform
curl -s -X POST "https://your-api/send" -d "text=$TEXT"
```

## How to Verify Your Integration

```bash
# 1. Run verify.sh — checks keys, config, relay, daemon
bash scripts/verify.sh <handle>

# 2. Send a test message to yourself
AGENT_CHAT_HANDLE=<handle> node scripts/send.js send <handle> "Hello from test"
# → Should appear in your delivery channel within seconds

# 3. Test trust flow — send from another handle, check blind delivery
# → Message should arrive without AI seeing content
# → Trust URL should be accessible and working

# 4. Test injection — send a prompt injection attempt
# → Should be flagged, AI should NOT see content

# 5. Run unit tests
npm test  # 147 tests
```

## Summary: What You Must Do vs What's Optional

| What | Must | Optional |
|------|------|----------|
| Node.js ≥ 18 | ✅ | |
| Run `setup.sh` + daemon | ✅ | |
| Human delivery (Telegram / AGENT_DELIVER_CMD / stdout) | ✅ | |
| AI delivery (openclaw CLI / custom) | ✅ | |
| Keep blind/flagged content from AI | ✅ | |
| Trust via URL only (no AI access) | ✅ | |
| Inline buttons | | ✅ (fall back to text URLs) |
| Forum topics/threads | | ✅ (flat chat works) |
| Lakera Guard key | | ✅ (relay scans by default) |
| Contact labels | | ✅ (cosmetic) |
