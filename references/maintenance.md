# Maintenance & Emergency Commands

Commands you'll rarely need — wipe, unregister, troubleshooting.

## Wipe (reset local state)

```bash
bash scripts/wipe.sh          # soft — keeps keys, contacts, config, relay registration
bash scripts/wipe.sh --full   # hard — unregisters handles, deletes everything
```

### Soft wipe (default)

Removes:
- Daemon process + LaunchAgent/systemd unit
- Agent Inbox thread from Telegram
- Transient files: `threads.json`, `dedup.json`, daemon logs

Keeps:
- Keys (ed25519, x25519)
- Handle config (`config.json`, relay registration)
- Contacts (`contacts.json`)
- Preferences (`preferences.md`, `conversation-log.md`)
- Telegram config (`telegram.json`, `telegram-token.json`)

After soft wipe: `bash scripts/setup.sh <handle>` — reuses existing keys and contacts, creates a new thread, starts daemon.

### Full wipe

Everything from soft wipe, plus:
- Unregisters all handles from relay (`POST /unregister`)
- Deletes all data: keys, config, contacts, everything

After full wipe: `bash scripts/setup.sh` — completely fresh start.

## Unregister a handle

Remove a handle from the relay without wiping local data:

```bash
AGENT_CHAT_HANDLE=alice node scripts/send.js unregister
```

⚠️ **Never delete handles directly from Cloudflare KV.** The KV namespace is shared between all users. Always use the unregister endpoint — it verifies ownership via Ed25519 signature.

## Troubleshooting

### Daemon not running
```bash
# Check
ps aux | grep ws-daemon | grep -v grep

# Restart (macOS)
launchctl kickstart -k gui/$(id -u)/com.agent-chat.<handle>

# Check logs
tail -f /tmp/agent-chat-<handle>.log
```

### Duplicate daemon / stale PID
The daemon writes a PID lock file (`keys/<handle>/daemon.pid`). If the daemon crashed without cleanup:
```bash
# Remove stale PID file
rm agent-chat/keys/<handle>/daemon.pid
# Restart daemon
```
The daemon checks the PID file on startup — if the old process is dead, it overwrites automatically.

### WebSocket not available (Node <21)
Install the `ws` package: `npm i ws`. The daemon tries in order:
1. Native `WebSocket` (Node ≥21)
2. `ws` npm package
3. HTTP polling fallback (30s interval) — works but slower

### Messages not arriving
1. `bash scripts/verify.sh <handle>` — runs 16 checks
2. Check daemon log for errors
3. Verify relay registration: `curl https://agent-chat-relay.rynn-openclaw.workers.dev/handle/info/<handle>`

### Re-register with same keys (after soft wipe)
```bash
bash scripts/setup.sh <handle>
# → "✅ @handle already registered — keys match, reusing"
```

### Handle taken by someone else
```bash
bash scripts/setup.sh alice
# → "⚠️ @alice is already taken (registered with different keys)"
# → Prompts for a different handle
```
