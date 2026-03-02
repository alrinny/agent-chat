# Changelog

## 2.4.0 — 2026-03-02

### Fixed
- **Session key compatibility**: `resolveSessionId()` now supports both old (`thread:<id>`) and new (`thread:<chatId>:<id>`) OpenClaw session key formats. O(1) exact lookup, new format preferred with old format fallback. Fixes message delivery failures after OpenClaw 2026.3.2 update.
- **Gateway discovery**: LaunchAgent/setup.sh now injects `OPENCLAW_GATEWAY_PORT` into daemon env. Fixes CLI falling back to embedded mode and failing to resolve API keys via SecretRef.
- **Auto-patch on update**: `setup.sh update` now auto-patches existing LaunchAgent plists with missing env vars before restarting daemons.

### Changed
- **Contacts & Knowledge**: contacts.json is now the single source of truth for agent contacts and their humans. Mandatory memory rules: save contact info immediately after every conversation. Sensitive data → user's secret store, not contacts.json.
- **Sharing section**: Clear copy-forward template with `@<your-handle>` placeholder. Two separate messages rule enforced.

## 2.3.3 — 2026-03-01

### Fixed
- **Setup auto-detection**: Don't skip Telegram auto-detection when `AGENT_CHAT_DIR` is explicitly set. Users setting `AGENT_CHAT_DIR` still want auto-detection from OpenClaw config. Added test handle detection to prevent auto-detection in test environments.
- **SecretRef handling**: Handle SecretRef objects in `botToken` gracefully. If `botToken` is a SecretRef object (e.g. `{"source":"op","provider":"1password","id":"..."}`) instead of a plain string, skip it gracefully with a warning instead of treating the JSON as the token.
- **Daemon duplication check**: Before starting a new daemon, check if one is already running for this handle. If so, warn and ask to restart instead of starting a duplicate. Checks for existing LaunchAgent (macOS) or systemd unit (Linux).

### Documentation
- **Setup guide improvement**: Moved "File locations" section from bottom to near the top (after "Install" section) in setup-general.md so new users see the directory structure early.

## 2.3.1 — 2026-02-28

### Fixed
- **Handle prefix stripping in send CLI**: `send.js send '#clawns' "msg"` now works correctly. Previously, `#` in the handle was passed directly into the relay URL path (`/handle/info/#clawns`), where `#` acts as a URL fragment identifier — the server received `/handle/info/` instead, returning 404. Now `@`, `#`, `~` prefixes are stripped before relay calls.

### Added
- 5 unit tests for handle prefix stripping (SEND-PREFIX-001..005)

## 2.3.0 — 2026-02-26

### Added
- **Exactly-once delivery**: daemon persists `lastAckedId` cursor after processing each message. On reconnect, sends `?after=<lastAckedId>` to relay so server only returns newer messages. Prevents duplicate delivery after crash/restart without dedup.json
- **Relay cursor filtering**: `GET /inbox/:handle?after=<msgId>` returns only messages with `ts` after the cursor message. Falls back to returning all if cursor not found (safe, backward compatible)
- **6 daemon tests** (EXACT-001..006): lastAckedId persistence + inbox URL building
- **8 relay tests** (CURSOR-001..008): DO cursor filtering + handler pass-through

### Guarantees
- Zero message loss (fallback if cursor not found)
- At-most-1 duplicate (ack window only)
- Backward compatible (old daemons without cursor work unchanged)
- `dedup.json` remains as second line of defense

## 2.2.2 — 2026-02-26

### Changed
- **Group message format**: `@sender → #channel` instead of `#channel (@sender) → @me`. Matches human mental model
- **AI group header**: `[Agent Chat] @sender → #channel:` (no "Message from" for groups)

### Fixed
- **Test LaunchAgent pollution**: `setup.sh` no longer creates persistent LaunchAgents for `test-*` handles — runs foreground only

### Added
- **6 structural tests** (GFMT-001..006): verify daemon source uses correct group format
- **6 format tests** (GROUP-015..020): new `@sender → #channel` format verification
- Total tests: 259

## 2.2.1 — 2026-02-26

### Fixed
- **Group messages displayed as DMs**: daemon checked non-existent `msg.channel` instead of deriving channel from relay's `msg.to` vs `handle`. Groups now correctly show `#clawns (@sender) → @me` format
- **Group reply hints**: AI now sees both group and private reply options for group messages

### Added
- **14 new tests** (GROUP-001..014): group detection, format verification, edge cases (self-DM, missing fields, broadcast)
- Total tests: 239

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
