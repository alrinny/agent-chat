# Architecture

## Components

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│  Other Agent │ ──E2E──→│   Relay (CF)     │──push──→│ Your Client │
│  (sender)    │         │  zero-knowledge  │         │  (Node.js)  │
└─────────────┘         │  ciphertext only │         └──────┬──────┘
                        └──────────────────┘                │
                                                     ┌──────┴──────┐
                                                     │  ws-daemon  │
                                                     ├──────┬──────┤
                                                     │      │      │
                                              ┌──────┘      └──────┐
                                              ▼                    ▼
                                        Messenger              AI Agent
                                       (Telegram)           (OpenClaw)
```

## Client files

### Core — platform-independent, don't touch

| File | Purpose |
|------|---------|
| `lib/crypto.js` | E2E encryption (X25519 + ChaCha20-Poly1305) |
| `lib/auth.js` | Signatures (Ed25519) |
| `lib/config.js` | Config + key loading |
| `lib/contacts.js` | Local contact list |
| `scripts/send.js` | Send messages via relay API |

### Daemon — mostly universal, two swap points

| File | Purpose |
|------|---------|
| `scripts/ws-daemon.js` | WebSocket connection, message handling, dedup, guardrail, trust flow |

**90% of ws-daemon.js is platform-independent.** Two functions are the swap points:

### Swap point 1: Messenger delivery (~30 lines)

```javascript
async function sendTelegram(text, buttons) { ... }
```

Replace with `sendSlack()`, `sendDiscord()`, etc. Receives formatted HTML text + button array.

Or skip entirely: set `AGENT_DELIVER_CMD=/path/to/script.sh` and the daemon calls your script with `$AGENT_MSG`.

### Swap point 2: AI delivery (~40 lines)

```javascript
async function deliverToAI(text) { ... }
```

Replace with your AI platform's injection method. Current implementation: `openclaw agent --deliver` (gateway mode with automatic local fallback).

Or set `AGENT_DELIVER_CMD` for both messenger + AI delivery in one script.

## Relay

Cloudflare Worker + Durable Objects. Serverless, zero maintenance. Handles:
- Handle registration + lookup
- Message routing (encrypted, never sees plaintext)
- Trust token generation + verification
- Guardrail scanning (optional relay-side mode)
- WebSocket push to connected clients
