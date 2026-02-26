/**
 * Tests for group message display — verifying that group vs DM detection
 * uses relay payload fields correctly.
 *
 * Root cause investigation: relay sends {from, to, recipient} where:
 *   DM:    to === recipient (e.g. to:"sev1", recipient:"sev1")
 *   Group: to !== recipient (e.g. to:"clawns", recipient:"sev1")
 *
 * The daemon currently checks msg.channel (which doesn't exist in relay payload)
 * instead of deriving channel from msg.to vs msg.recipient/handle.
 *
 * Tests: GROUP-001..010
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Group message detection from relay payload', () => {

  // Simulate what relay actually sends via WebSocket (from agent-socket.ts pushToWs)
  function simulateRelayMessage(from, to, recipient, effectiveRead = 'trusted') {
    return {
      id: `msg-${Date.now()}`,
      type: 'message',
      from,
      to,
      recipient,
      ciphertext: 'test',
      ephemeralKey: 'test',
      nonce: 'test',
      senderSig: 'test',
      plaintextHash: 'test',
      ts: Date.now(),
      effectiveRead
    };
  }

  // Current daemon logic (BROKEN): checks msg.channel which doesn't exist
  function detectGroupCurrent(msg) {
    return msg.channel || null;
  }

  // Proposed fix: derive channel from msg.to vs handle
  function detectGroupFixed(msg, myHandle) {
    return (msg.to && msg.to !== myHandle) ? msg.to : null;
  }

  describe('DM messages', () => {

    it('GROUP-001: DM relay payload has to === handle (sev1 → rinny)', () => {
      const msg = simulateRelayMessage('sev1', 'rinny', 'rinny');
      assert.equal(msg.to, 'rinny');
      assert.equal(msg.recipient, 'rinny');
      assert.equal(msg.to, msg.recipient, 'DM: to should equal recipient');
    });

    it('GROUP-002: current daemon shows DM as DM (correct by accident)', () => {
      const msg = simulateRelayMessage('sev1', 'rinny', 'rinny');
      const channel = detectGroupCurrent(msg);
      assert.equal(channel, null, 'no msg.channel → treated as DM (correct)');
    });

    it('GROUP-003: fixed logic also shows DM as DM', () => {
      const msg = simulateRelayMessage('sev1', 'rinny', 'rinny');
      const channel = detectGroupFixed(msg, 'rinny');
      assert.equal(channel, null, 'to === handle → DM');
    });
  });

  describe('Group messages', () => {

    it('GROUP-004: group relay payload has to !== handle (rinny → #clawns, delivered to sev1)', () => {
      const msg = simulateRelayMessage('rinny', 'clawns', 'sev1');
      assert.equal(msg.to, 'clawns');
      assert.equal(msg.recipient, 'sev1');
      assert.notEqual(msg.to, msg.recipient, 'Group: to should differ from recipient');
    });

    it('GROUP-005: current daemon FAILS to detect group (BUG)', () => {
      const msg = simulateRelayMessage('rinny', 'clawns', 'sev1');
      const channel = detectGroupCurrent(msg);
      // This is the bug: msg.channel is undefined, so group looks like DM
      assert.equal(channel, null, 'BUG: current logic returns null for group message');
      assert.equal(msg.channel, undefined, 'msg.channel does not exist in relay payload');
    });

    it('GROUP-006: fixed logic correctly detects group', () => {
      const msg = simulateRelayMessage('rinny', 'clawns', 'sev1');
      const channel = detectGroupFixed(msg, 'sev1');
      assert.equal(channel, 'clawns', 'to !== handle → group, channel = to');
    });

    it('GROUP-007: group message from sev1 in clawns, delivered to rinny', () => {
      const msg = simulateRelayMessage('sev1', 'clawns', 'rinny');
      const channel = detectGroupFixed(msg, 'rinny');
      assert.equal(channel, 'clawns');
    });

    it('GROUP-008: broadcast message (~news) detected as group', () => {
      const msg = simulateRelayMessage('owner', 'news', 'reader1');
      const channel = detectGroupFixed(msg, 'reader1');
      assert.equal(channel, 'news');
    });
  });

  describe('Edge cases', () => {

    it('GROUP-009: self-DM (rinny → rinny) is not a group', () => {
      const msg = simulateRelayMessage('rinny', 'rinny', 'rinny');
      const channel = detectGroupFixed(msg, 'rinny');
      assert.equal(channel, null, 'self-DM: to === handle → not a group');
    });

    it('GROUP-010: missing to field defaults to DM', () => {
      const msg = simulateRelayMessage('sev1', undefined, 'rinny');
      const channel = detectGroupFixed(msg, 'rinny');
      assert.equal(channel, null, 'undefined to → not a group');
    });
  });

  describe('Format verification', () => {

    it('GROUP-011: DM header format is "@sender → @me"', () => {
      const msg = simulateRelayMessage('sev1', 'rinny', 'rinny');
      const channel = detectGroupFixed(msg, 'rinny');
      const fromPart = channel
        ? `#${channel} (@${msg.from})`
        : `@${msg.from}`;
      assert.equal(fromPart, '@sev1');
    });

    it('GROUP-012: group header format is "#group (@sender) → @me"', () => {
      const msg = simulateRelayMessage('rinny', 'clawns', 'sev1');
      const channel = detectGroupFixed(msg, 'sev1');
      const fromPart = channel
        ? `#${channel} (@${msg.from})`
        : `@${msg.from}`;
      assert.equal(fromPart, '#clawns (@rinny)');
    });

    it('GROUP-013: group reply hint includes both group and private options', () => {
      const msg = simulateRelayMessage('rinny', 'clawns', 'sev1');
      const channel = detectGroupFixed(msg, 'sev1');
      const hint = channel
        ? `Reply to #${channel}: send ${channel} "your reply"\nReply to @${msg.from} privately: send ${msg.from} "your reply"`
        : `Reply with: send ${msg.from} "your reply"`;
      assert.ok(hint.includes('send clawns'), 'hint includes group reply');
      assert.ok(hint.includes('send rinny'), 'hint includes private reply');
    });

    it('GROUP-014: DM reply hint only has direct reply', () => {
      const msg = simulateRelayMessage('sev1', 'rinny', 'rinny');
      const channel = detectGroupFixed(msg, 'rinny');
      const hint = channel
        ? `Reply to #${channel}: send ${channel} "your reply"\nReply to @${msg.from} privately: send ${msg.from} "your reply"`
        : `Reply with: send ${msg.from} "your reply"`;
      assert.ok(hint.includes('send sev1'), 'hint includes sender');
      assert.ok(!hint.includes('clawns'), 'hint does NOT include group');
    });
  });

  describe('Group display format — sender → channel (v2.2.2)', () => {

    // New format: group messages show "@sender → #channel" not "#channel (@sender) → @me"
    // This matches how humans think: "mira wrote to clawns", not "clawns (mira) wrote to me"

    function buildHeader(msg, myHandle) {
      const channel = detectGroupFixed(msg, myHandle);
      const fromPart = channel
        ? `@${msg.from} → #${channel}`
        : `@${msg.from} → @${myHandle}`;
      return fromPart;
    }

    function buildAiHeader(msg, myHandle, contactLabel = 'contact') {
      const channel = detectGroupFixed(msg, myHandle);
      if (channel) {
        return `[Agent Chat] @${msg.from} → #${channel}:`;
      }
      return `[Agent Chat] Message from @${msg.from} → @${myHandle} (${contactLabel}):`;
    }

    it('GROUP-015: group Telegram header is "@sender → #channel"', () => {
      const msg = simulateRelayMessage('mira', 'clawns', 'rinny');
      const header = buildHeader(msg, 'rinny');
      assert.equal(header, '@mira → #clawns');
    });

    it('GROUP-016: DM Telegram header unchanged "@sender → @me"', () => {
      const msg = simulateRelayMessage('mira', 'rinny', 'rinny');
      const header = buildHeader(msg, 'rinny');
      assert.equal(header, '@mira → @rinny');
    });

    it('GROUP-017: group AI header has no "Message from", no handle', () => {
      const msg = simulateRelayMessage('mira', 'clawns', 'rinny');
      const header = buildAiHeader(msg, 'rinny');
      assert.equal(header, '[Agent Chat] @mira → #clawns:');
    });

    it('GROUP-018: DM AI header unchanged with "Message from"', () => {
      const msg = simulateRelayMessage('mira', 'rinny', 'rinny');
      const header = buildAiHeader(msg, 'rinny');
      assert.equal(header, '[Agent Chat] Message from @mira → @rinny (contact):');
    });

    it('GROUP-019: self-message in group shows "@me → #channel"', () => {
      const msg = simulateRelayMessage('rinny', 'clawns', 'rinny');
      const header = buildHeader(msg, 'rinny');
      assert.equal(header, '@rinny → #clawns');
    });

    it('GROUP-020: broadcast channel same format as group', () => {
      const msg = simulateRelayMessage('admin', 'news', 'rinny');
      const header = buildHeader(msg, 'rinny');
      assert.equal(header, '@admin → #news');
    });
  });
});
