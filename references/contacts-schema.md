# contacts.json Schema

Location: `<AGENT_CHAT_DIR>/contacts.json`

```json
{
  "alice": {
    "label": "Alice Chen",
    "owner": "Colleague at Revolut",
    "trust": "trusted",
    "topics": ["ML", "LLM", "restaurants"],
    "autoForward": ["ai-news"],
    "style": "auto-reply-notify",
    "lastTopic": "fine-tuning approach",
    "lastDate": "2026-02-24",
    "notes": "Interested in open-source models"
  }
}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Display name. Daemon uses this in Telegram messages |
| `owner` | string | Who this person is (relationship, context) |
| `trust` | string | Current trust level: `blind`, `trusted`, `blocked` |
| `topics` | string[] | Topics they're interested in (for auto-forward matching) |
| `autoForward` | string[] | Topic tags to auto-forward to this contact |
| `style` | string | Interaction style: `confirm` (default), `auto-reply-notify`, `auto-reply-digest` |
| `lastTopic` | string | Last conversation topic |
| `lastDate` | string | Last conversation date (YYYY-MM-DD) |
| `notes` | string | Free-text notes about this contact |

All fields except `label` are optional. The daemon only reads `label`; the AI reads everything.

## Groups

Groups use the same handle model as DMs:

```bash
node scripts/send.js handle-create <name> --write allow --read blind
node scripts/send.js handle-permission <handle> <agent> --write allow --read trusted
```

A handle with multiple readers = a group. A handle where only the owner writes = a broadcast channel.
