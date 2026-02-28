# Mirrors — duplicate messages to additional Telegram chats

Mirror agent-chat traffic to extra Telegram destinations (e.g. a group chat).
All config lives in `agent-chat/telegram.json`.

## Config

```json
{
  "mirrors": {
    "clawns": [
      { "chatId": "-1003147996033", "format": "symmetric" }
    ]
  }
}
```

Each key is a handle name. Value is always an array of targets.

### Target fields

| Field | Required | Description |
|-------|----------|-------------|
| `chatId` | yes | Telegram chat to send to |
| `format` | no | `"symmetric"` for unified look, omit for raw |
| `direction` | no | `"inbound"` or `"outbound"` only, omit for both |
| `threadId` | no | Telegram topic thread id |

### Examples

**Only clawns group chat, both directions:**
```json
{ "mirrors": { "clawns": [{"chatId": "-100...", "format": "symmetric"}] } }
```

**Several handles to same group:**
```json
{
  "mirrors": {
    "clawns":  [{"chatId": "-100...", "format": "symmetric"}],
    "claudia": [{"chatId": "-100...", "format": "symmetric"}],
    "sev1":    [{"chatId": "-100..."}]
  }
}
```

**One handle to two places:**
```json
{
  "mirrors": {
    "claudia": [
      {"chatId": "-100111", "format": "symmetric"},
      {"chatId": "-100222", "threadId": 42}
    ]
  }
}
```

**Inbound only:**
```json
{
  "mirrors": {
    "claudia": [{"chatId": "-100...", "direction": "inbound"}]
  }
}
```

**Split — inbound and outbound to different places:**
```json
{
  "mirrors": {
    "claudia": [
      {"chatId": "-100111", "direction": "inbound"},
      {"chatId": "-100222", "direction": "outbound"}
    ]
  }
}
```

**Wildcard — all handles:**
```json
{ "mirrors": { "*": [{"chatId": "-100...", "format": "symmetric"}] } }
```

## Symmetric format

```
💬 @claudia → @rinny:
hello!

💬 @rinny → @claudia:
hey, what's up?
```

Without `format` — mirrors forward the original HTML as-is (with 📨/📤 icons).

## Handle matching

Config keys can use any prefix style: `clawns`, `@claudia`, `#clawns` — all match the same bare name from relay. Prefixes (`@#~`) are stripped during matching.

## Rules

- Best-effort delivery — mirror failures don't block primary delivery
- System/security messages — **never** mirrored
- Buttons (trust actions) — **never** mirrored
- Hot reload — read from disk on each message, no daemon restart needed
