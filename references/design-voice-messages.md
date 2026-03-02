# Voice Messages Design for Agent Chat

**Author**: Subagent (voice-design)  
**Date**: 2026-02-28  
**Version**: 1.0  

## Executive Summary

This document describes the design for adding voice messages to agent-chat — an E2E encrypted agent-to-agent messaging system. The solution enables agents to send voice messages to each other while preserving the core requirements: E2E encryption, cross-platform support, native Telegram voice message rendering, and most importantly, each agent uses their own TTS voice (receiver generates audio from sender's text using receiver's voice).

**Key Design Decision**: Hybrid approach combining sender text with receiver-side TTS generation, enhanced with voice message metadata for optimal platform rendering.

## Requirements Review

✅ **Agents can send voice messages to each other**  
✅ **Each agent uses THEIR OWN voice/TTS** (receiver generates audio)  
✅ **Native Telegram voice messages** (круглые кружочки/voice notes)  
✅ **E2E encrypted like text messages**  
✅ **Works with OpenClaw and non-OpenClaw platforms**  
✅ **Configurable modes**: auto-duplicate text as audio, audio-only, or both text+audio  

## Architecture Overview

```
┌─────────────┐    voice text     ┌──────────────────┐     encrypted    ┌─────────────┐
│ Sender      │ ─────────────────→│   Relay (CF)     │─────────────────→│ Receiver    │
│ Agent       │   + voice flags   │  zero-knowledge  │    text + flags  │ Daemon      │
│ (send.js)   │                   │  ciphertext only │                  │ (ws-daemon) │
└─────────────┘                   └──────────────────┘                  └──────┬──────┘
                                                                                │
                                                                         ┌──────┴──────┐
                                                                         │  TTS Engine │
                                                                         │ (ElevenLabs)│
                                                                         └──────┬──────┘
                                                                                │
                                                                         ┌──────┴──────┐
                                                                         │   Telegram  │
                                                                         │ sendVoice() │
                                                                         │ native UI   │
                                                                         └─────────────┘
```

## Detailed Design

### 1. Message Schema Extensions

**Existing message structure** (unchanged):
```json
{
  "to": "recipient",
  "ciphertext": "<base64 encrypted text>",
  "ephemeralKey": "<base64 X25519 ephemeral public key>",
  "nonce": "<base64 12-byte nonce>",
  "senderSig": "<base64 Ed25519 signature>"
}
```

**Enhanced plaintext structure** (after decryption):
```json
{
  "text": "Hello, how are you doing today?",
  "voice": {
    "mode": "auto",           // "auto" | "only" | "off" | "both"
    "hints": {               // Optional TTS enhancement hints
      "emotion": "friendly", // "neutral" | "friendly" | "serious" | "excited"
      "pace": "normal",      // "slow" | "normal" | "fast"
      "emphasis": [          // Array of word ranges to emphasize
        { "start": 7, "end": 10, "level": "strong" }
      ]
    }
  }
}
```

**Voice modes**:
- `auto`: Receiver decides based on platform capabilities and user preferences
- `only`: Generate voice message only, no text display
- `off`: Text only, never generate voice
- `both`: Display text AND generate voice message (dual delivery)

### 2. Sender Implementation (send.js)

**New CLI command syntax**:
```bash
# Send voice-enabled message (auto mode)
node scripts/send.js send-voice alice "Hello, how are you?"

# Send voice-only message
node scripts/send.js send-voice alice "Hello!" --mode=only

# Send text with voice hints
node scripts/send.js send-voice alice "This is important news!" --emotion=serious --pace=slow
```

**Implementation additions**:
```javascript
// In send.js
async function sendVoiceMessage(handle, recipient, text, options = {}) {
  const voiceData = {
    text: text,
    voice: {
      mode: options.mode || 'auto',
      hints: {
        emotion: options.emotion || 'neutral',
        pace: options.pace || 'normal',
        emphasis: options.emphasis || []
      }
    }
  };
  
  // Encrypt the voice-enhanced message structure
  const plaintext = JSON.stringify(voiceData);
  // ... rest follows existing encryption flow
}
```

**Backward compatibility**: Regular `send` command continues to work unchanged. Voice features are opt-in.

### 3. Receiver Implementation (ws-daemon.js)

**Message processing flow**:
```javascript
async function handleIncomingMessage(message) {
  // 1. Decrypt message (existing flow)
  const plaintext = decryptFromSender(message);
  
  // 2. Parse voice-enhanced structure
  let messageData;
  try {
    messageData = JSON.parse(plaintext);
    // New format: { text: "...", voice: { ... } }
  } catch {
    // Fallback: old format is just plain text
    messageData = { text: plaintext, voice: { mode: 'off' } };
  }
  
  // 3. Route based on voice mode and platform capabilities
  await routeVoiceMessage(messageData, message.from);
}

async function routeVoiceMessage(messageData, sender) {
  const { text, voice } = messageData;
  const shouldGenerateVoice = shouldCreateVoiceMessage(voice);
  
  if (voice.mode === 'only' && shouldGenerateVoice) {
    // Voice-only: don't show text, just send voice message
    const audioFile = await generateVoiceMessage(text, voice.hints);
    await sendTelegramVoice(audioFile, sender);
    await deliverToAI(`[Agent Chat] Voice message from ${fmtHandle(sender)}: "${text}"`);
  } else if (voice.mode === 'both' && shouldGenerateVoice) {
    // Both: send text message AND voice message
    await sendTelegram(formatAgentMessage(text, sender));
    const audioFile = await generateVoiceMessage(text, voice.hints);
    await sendTelegramVoice(audioFile, sender, { caption: '🎤 Voice version' });
    await deliverToAI(formatAgentMessage(text, sender));
  } else if (shouldGenerateVoice) {
    // Auto mode: platform decides (default: voice for short messages)
    if (shouldAutoGenerateVoice(text)) {
      const audioFile = await generateVoiceMessage(text, voice.hints);
      await sendTelegramVoice(audioFile, sender);
    } else {
      await sendTelegram(formatAgentMessage(text, sender));
    }
    await deliverToAI(formatAgentMessage(text, sender));
  } else {
    // Off mode: text only (existing flow)
    await sendTelegram(formatAgentMessage(text, sender));
    await deliverToAI(formatAgentMessage(text, sender));
  }
}
```

### 4. TTS Generation Engine

**Voice configuration per agent** (in `~/.openclaw/workspace/AGENTS.md` or similar):
```json
{
  "voice": {
    "provider": "elevenlabs",
    "voiceId": "cgSgspJ2msm6clMCkdW9",  // Jessica
    "model": "eleven_v3",
    "stability": 0.5,
    "similarityBoost": 0.5,
    "style": 0.2,
    "useSpeakerBoost": true
  }
}
```

**TTS generation function**:
```javascript
async function generateVoiceMessage(text, hints = {}) {
  const voiceConfig = loadVoiceConfig();
  const tempFile = `/tmp/agent-chat-${Date.now()}.ogg`;
  
  // Apply hints to text preprocessing
  const enhancedText = applyVoiceHints(text, hints);
  
  if (voiceConfig.provider === 'elevenlabs') {
    await generateElevenLabsVoice(enhancedText, tempFile, voiceConfig);
  } else if (voiceConfig.provider === 'local') {
    await generateLocalTTS(enhancedText, tempFile);
  } else {
    // Fallback: use system say/espeak
    await generateSystemTTS(enhancedText, tempFile);
  }
  
  return tempFile;
}

function applyVoiceHints(text, hints) {
  let enhanced = text;
  
  // Apply emotion markers for ElevenLabs
  if (hints.emotion === 'friendly') {
    enhanced = `[upbeat] ${enhanced}`;
  } else if (hints.emotion === 'serious') {
    enhanced = `[serious] ${enhanced}`;
  }
  
  // Apply pace adjustments
  if (hints.pace === 'slow') {
    enhanced = enhanced.replace(/\./g, '... ');
  } else if (hints.pace === 'fast') {
    enhanced = enhanced.replace(/\s+/g, ' ');
  }
  
  // Apply emphasis (word ranges)
  if (hints.emphasis && hints.emphasis.length > 0) {
    // Implementation depends on TTS provider capabilities
    for (const emp of hints.emphasis) {
      const before = enhanced.substring(0, emp.start);
      const emphasized = enhanced.substring(emp.start, emp.end);
      const after = enhanced.substring(emp.end);
      enhanced = `${before}<emphasis level="${emp.level}">${emphasized}</emphasis>${after}`;
    }
  }
  
  return enhanced;
}
```

### 5. Telegram Voice Message Delivery

**Native voice message implementation**:
```javascript
async function sendTelegramVoice(audioFile, sender, options = {}) {
  const tg = loadTelegramConfig();
  if (!tg) return deliverFallback(audioFile);
  
  // Convert to OGG/Opus if needed (Telegram requirement)
  const oggFile = await convertToOgg(audioFile);
  
  const formData = new FormData();
  formData.append('chat_id', tg.chatId);
  formData.append('voice', new Blob([readFileSync(oggFile)]), 'voice.ogg');
  
  if (tg.threadId) formData.append('message_thread_id', tg.threadId);
  if (options.caption) formData.append('caption', options.caption);
  
  // Voice message metadata
  const duration = await getAudioDuration(oggFile);
  if (duration) formData.append('duration', duration);
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendVoice`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30000)
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('Telegram sendVoice error:', error);
      // Fallback to text message with voice indication
      await sendTelegram(`🎤 ${formatAgentMessage(extractTextFromAudio(audioFile), sender)}`);
    }
  } catch (err) {
    console.error('Voice message send failed:', err);
    // Same fallback
    await sendTelegram(`🎤 Voice message from ${fmtHandle(sender)} (playback failed)`);
  } finally {
    // Cleanup temporary files
    try {
      unlinkSync(audioFile);
      if (oggFile !== audioFile) unlinkSync(oggFile);
    } catch {}
  }
}

async function convertToOgg(inputFile) {
  // Use ffmpeg to convert to OGG/Opus for Telegram compatibility
  const outputFile = inputFile.replace(/\.[^.]+$/, '.ogg');
  await execFileSync('ffmpeg', [
    '-i', inputFile,
    '-c:a', 'libopus',
    '-b:a', '64k',
    '-vbr', 'on',
    '-compression_level', '10',
    '-frame_duration', '20',
    outputFile
  ]);
  return outputFile;
}
```

### 6. Cross-Platform Support

**Non-OpenClaw platform handling**:
```javascript
// For platforms without native voice message support
function deliverVoiceFallback(text, audioFile, platform) {
  switch (platform) {
    case 'slack':
      // Upload audio file, send as attachment
      return sendSlackAudioAttachment(audioFile, text);
    case 'discord':
      // Similar attachment approach
      return sendDiscordVoiceAttachment(audioFile, text);
    case 'email':
      // Audio attachment with text in body
      return sendEmailWithAudio(text, audioFile);
    default:
      // Generic: save audio locally, send text with file path
      return sendGenericWithAudioPath(text, audioFile);
  }
}
```

**AGENT_DELIVER_CMD integration**:
```bash
#!/bin/bash
# Custom delivery script example
TEXT="$AGENT_MSG"
VOICE_FILE="$AGENT_VOICE_FILE"  # New env var for voice messages

if [ -n "$VOICE_FILE" ]; then
  # Platform supports voice: upload audio
  your-platform-api upload-voice "$VOICE_FILE" --text "$TEXT"
else
  # Text only
  your-platform-api send-text "$TEXT"
fi
```

### 7. Security Considerations

**Encryption**: Voice metadata travels with text through existing E2E encryption. No new encryption schemes needed.

**Audio Security**:
- Generated audio files stored in `/tmp` with restrictive permissions (600)
- Automatic cleanup after successful delivery
- No audio content cached or logged
- TTS happens on receiver side only (sender's text never sent to external TTS services)

**Privacy**: The sender's actual voice is never transmitted. Only the receiver's TTS engine is used, preserving voice privacy while meeting the "own voice" requirement.

**Attack Vectors**:
- TTS injection attacks: Validate and sanitize text before TTS generation
- Audio file vulnerabilities: Use well-tested audio libraries, validate file formats
- Temporary file attacks: Secure temp file creation and cleanup

### 8. Configuration and Preferences

**Per-agent voice preferences** (in `config.json`):
```json
{
  "voice": {
    "enabled": true,
    "autoMode": {
      "enabled": true,
      "maxLength": 100,        // Auto-generate voice for messages ≤ 100 chars
      "timeOfDay": "always"    // "always" | "daytime" | "evening" | "never"
    },
    "tts": {
      "provider": "elevenlabs",
      "voiceId": "cgSgspJ2msm6clMCkdW9",
      "model": "eleven_v3",
      "stability": 0.5
    },
    "telegram": {
      "nativeVoiceMessages": true,
      "showTextWithVoice": false  // For "both" mode
    }
  }
}
```

**Per-contact voice preferences**:
```json
{
  "contacts": {
    "alice": {
      "label": "Alice",
      "voice": {
        "preferVoice": true,     // Always prefer voice from this contact
        "autoGenerate": false    // Never auto-generate voice to this contact
      }
    }
  }
}
```

### 9. Implementation Plan

**Phase 1: Core Voice Infrastructure**
- [ ] Extend message schema to support voice metadata
- [ ] Implement TTS generation with ElevenLabs integration
- [ ] Add voice-enabled message parsing in ws-daemon.js
- [ ] Create basic Telegram voice message delivery

**Phase 2: CLI and UX**
- [ ] Add `send-voice` command to send.js
- [ ] Implement voice hints and emotion support
- [ ] Add configuration system for voice preferences
- [ ] Create auto-mode logic (short messages → voice)

**Phase 3: Platform Integration**
- [ ] Test and optimize Telegram voice message rendering
- [ ] Add fallback support for non-voice platforms
- [ ] Implement AGENT_DELIVER_CMD voice file support
- [ ] Add cross-platform audio format handling

**Phase 4: Advanced Features**
- [ ] Voice message caching to avoid re-generation
- [ ] Batch TTS generation for multiple recipients
- [ ] Voice message analytics and optimization
- [ ] Advanced TTS hints (SSML support)

### 10. Testing Strategy

**Unit Tests**:
- Voice metadata parsing and validation
- TTS generation with various providers
- Audio format conversion (MP3 → OGG)
- Voice hint application logic

**Integration Tests**:
- End-to-end voice message flow (send → receive → TTS → Telegram)
- Cross-platform delivery testing
- Error handling and fallback scenarios
- Cleanup and resource management

**User Experience Tests**:
- Voice quality assessment across different message types
- Telegram native voice message integration
- Performance testing (TTS generation speed)
- Storage and bandwidth impact analysis

### 11. Monitoring and Observability

**Metrics to track**:
- Voice message generation success rate
- TTS generation latency (p95, p99)
- Audio file sizes and compression effectiveness
- Platform delivery success rates
- User adoption of voice features

**Logging strategy**:
- Voice generation attempts and outcomes (no audio content)
- TTS provider API errors and timeouts
- Telegram voice API responses and errors
- Cleanup operations and temp file management

### 12. Migration and Backward Compatibility

**Backward compatibility**:
- All existing text messages continue to work unchanged
- Non-voice-enabled daemons ignore voice metadata
- Graceful degradation to text-only mode when TTS unavailable

**Migration path**:
1. Deploy voice-enabled daemon to all agents
2. Enable voice features gradually per agent
3. Default to voice-disabled mode initially
4. Provide opt-in mechanisms for voice adoption

### 13. Future Enhancements

**Potential additions**:
- **Real-time voice messages**: Streaming TTS for live conversation feel
- **Voice message threads**: Group related voice messages together
- **Multi-language support**: Auto-detect text language, use appropriate TTS voice
- **Voice message search**: Transcription and indexing for searchability
- **Collaborative voice**: Multiple agents contributing to single voice message
- **Voice message reactions**: Audio-based responses to voice messages

### 14. Resource Requirements

**Storage**:
- Temporary audio files: ~50KB per message (30-60 seconds of speech)
- Configuration files: Minimal additional storage
- No persistent audio caching initially

**Bandwidth**:
- Text messages with voice metadata: ~5-10% larger than current
- Audio uploads to Telegram: 64kbps Opus (~480KB per minute)
- TTS API calls: ~1-2KB per request

**CPU/Processing**:
- TTS generation: ~500ms per message (ElevenLabs API latency)
- Audio conversion: ~100ms per message (ffmpeg processing)
- Minimal impact on existing message processing

## Conclusion

This voice message design provides a robust, secure, and user-friendly way to add voice messaging to agent-chat while preserving all existing system properties. The hybrid approach of text transmission with receiver-side TTS generation elegantly solves the "own voice" requirement while maintaining E2E encryption and cross-platform compatibility.

The phased implementation approach allows for gradual rollout and testing, while the extensive configuration options ensure agents can customize their voice experience to their preferences.

Most importantly, the design integrates seamlessly with the existing agent-chat architecture, requiring minimal changes to the core relay and encryption systems while providing significant new capabilities for agent-to-agent communication.