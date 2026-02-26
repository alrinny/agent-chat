# Changelog

## 2.2.0 — 2026-02-26

### Added
- **OpenClaw discovery**: daemon auto-finds OpenClaw via config → env → PATH → standard paths
- **Unified fallback mode**: when OpenClaw not found, delivers via Telegram with `⚠️ (AI sees this — fix setup)` warning instead of silent duplicate
- **Setup discovery**: `setup.sh` finds and saves `openclawPath` to config.json during installation
- **`OPENCLAW_PATH` env var**: override for CI/containers
- **index.js support**: daemon can run OpenClaw via `node /path/to/index.js` (not just binary)
- **15 new tests**: DISCOVERY-001..015 covering discovery, fallback, icon logic, config persistence
- **CONTRIBUTING.md**: development guidelines for contributors

### Fixed
- **Duplicate messages**: removed Telegram API "last resort" from `deliverToAI()` — no more double messages when OpenClaw isn't on PATH
- **Non-OpenClaw setups**: graceful degradation instead of broken delivery

### Changed
- `deliverToAI()` now uses `resolveOpenClaw()` instead of hardcoded `'openclaw'` binary name
- OpenClaw not found = unified fallback (explicit warning), not silent Telegram duplicate
- Total tests: 225 (was 210)

### Docs
- `references/setup-general.md`: OpenClaw discovery priority table, unified fallback explanation
- `references/integration-guide.md`: delivery modes (split/unified/fallback), ephemeral environment notes

## 2.1.0 — 2026-02-25

### Added
- **Handle prefixes**: `@personal`, `#group`, `~broadcast` — unified display everywhere (Telegram, AI, CLI, docs)
- **Group reply hint**: AI sees both group and private reply options for group messages
- **Outgoing echo**: sent messages appear in sender's Inbox thread (`📤 @you → @target`)
- **Unified channel mode**: `unifiedChannel: true` in config for platforms without AI/human separation
- **Auto-verify**: `setup.sh` runs `verify.sh` automatically after setup
- **formatHandle()**: `lib/format.js` — single source of truth for handle display
- **PID lock**: prevents duplicate daemons (`keys/<handle>/daemon.pid`)
- **Graceful shutdown**: SIGTERM/SIGINT → close WebSocket, save dedup, remove PID
- **WebSocket fallback**: native (Node ≥21) → `ws` package → HTTP polling. Never crashes
- **AGENT_CHAT_VERBOSE**: debug logging for each message step (decrypt, guardrail, delivery)
- **CHANGELOG.md**: version history
- **`setup.sh update`**: `git pull` + restart all daemons

### Improved
- Error messages show actual paths and suggest env vars (AGENT_CHAT_DIR, AGENT_CHAT_KEYS_DIR)

### Changed
- Group message format: `#group (@sender) → @me` (was `@sender → @me`)
- Reply hint uses absolute path to `send.js` (AI doesn't need SKILL.md)
- `--no-daemon` marked as testing only — daemon always runs by default
- Docs consolidated: README, SKILL.md, integration-guide, setup-general all aligned
- Version bumped to 2.1.0

### Fixed
- Self-test delivery works (SKIP-SELF removed)
- Per-handle threadId in config.json (was shared)
- `wipe.sh` reads threadId from per-handle configs

## 2.0.0 — 2026-02-24

### Added
- **E2E encryption**: X25519 ECDH + ChaCha20-Poly1305
- **Guardrail v2**: relay-side + local scan, plaintextHash, 4-part senderSig
- **Trust system**: blind/trusted/block with Turnstile-protected URLs
- **Groups**: multi-reader handles with permissions (read/write/blind/trusted/deny/allow)
- **Contacts CLI**: add/remove/list with labels
- **Auto-trust**: invited handles auto-trusted when inviter is in contacts
- **Persistent daemon**: LaunchAgent (macOS) / systemd (Linux)
- **Telegram integration**: forum topics, inline buttons (Trust/Block/Forward)
- **Idempotent setup**: reuses keys, registration, telegram config
- **wipe.sh**: soft (keep keys) and full (unregister + delete all) modes
- **200 tests**: crypto, auth, config, contacts, delivery, format, setup, CLI

### Architecture
- Workspace data (`agent-chat/`) separate from keys (`agent-chat/keys/`)
- Relay: Cloudflare Workers + Durable Objects (zero-knowledge)
- Client: Node.js 18+, zero dependencies
