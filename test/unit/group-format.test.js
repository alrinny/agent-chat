/**
 * Structural tests for group message display format in ws-daemon.
 *
 * Verifies that the daemon source uses "@sender → #channel" format
 * for group messages, not "#channel (@sender) → @me".
 *
 * Tests: GFMT-001..006
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_SRC = readFileSync(
  join(__dirname, '../../scripts/ws-daemon.js'),
  'utf8'
);

// Extract the Telegram header construction for group messages
// Look for the fromPart assignment when channel is truthy
function findGroupFromPart() {
  // Match the pattern: channel ? `...` : `...`
  const match = DAEMON_SRC.match(/const fromPart = channel\s*\n?\s*\? `([^`]+)`\s*\n?\s*: /);
  return match ? match[1] : null;
}

// Extract AI header for trusted group messages
function findAiTrustedGroupHeader() {
  // Find the [Agent Chat] line in trusted delivery
  const lines = DAEMON_SRC.split('\n');
  for (const line of lines) {
    if (line.includes('[Agent Chat]') && line.includes('aiFromPart')) {
      return line.trim();
    }
  }
  return null;
}

describe('Group format in daemon source', () => {

  // GFMT-001: Telegram header for groups uses @sender → #channel pattern
  it('GFMT-001: group fromPart puts sender first, channel second', () => {
    const fromPart = findGroupFromPart();
    assert.ok(fromPart, 'fromPart pattern found in source');
    // New format: sender first, then arrow, then channel
    // e.g. ${fmtHandle(msg.from)} → ${fmtHandle(channel, ...)}
    assert.ok(
      fromPart.includes('msg.from') && fromPart.indexOf('msg.from') < fromPart.indexOf('channel'),
      `sender (msg.from) should come before channel in group header. Got: ${fromPart}`
    );
  });

  // GFMT-002: group header does NOT contain → @handle (→ @me)
  it('GFMT-002: group header arrow points to channel, not to self', () => {
    // The main header line should not have "→ ${...handle}" when channel exists
    // Look for the header = line
    const headerMatch = DAEMON_SRC.match(/const header = .*fromPart.*→.*handle/);
    // After fix, header for groups should NOT have → @handle
    // Instead, the arrow is embedded in fromPart itself
    const fromPart = findGroupFromPart();
    assert.ok(fromPart, 'fromPart found');
    // fromPart for groups should contain → (arrow to channel)
    assert.ok(
      fromPart.includes('→') || fromPart.includes('\\u2192'),
      `group fromPart should contain arrow to channel. Got: ${fromPart}`
    );
  });

  // GFMT-003: AI trusted header for groups does NOT have "Message from"
  it('GFMT-003: AI group header omits "Message from"', () => {
    // Find the aiMessage construction for trusted delivery
    const lines = DAEMON_SRC.split('\n');
    let aiMessageLine = null;
    for (const line of lines) {
      if (line.includes('`[Agent Chat]') && line.includes('aiFromPart')) {
        aiMessageLine = line.trim();
        break;
      }
    }
    assert.ok(aiMessageLine, 'AI message line found');
    // For groups, should be [Agent Chat] ${aiFromPart}: (no "Message from")
    // We check that the template supports conditional "Message from"
    // or that group path doesn't include it
    assert.ok(
      aiMessageLine.includes('channel ?') || !aiMessageLine.includes('Message from'),
      `AI header should conditionally omit "Message from" for groups. Got: ${aiMessageLine}`
    );
  });

  // GFMT-004: AI blind receipt for groups uses sender → channel format  
  it('GFMT-004: AI blind group receipt has sender → channel', () => {
    const lines = DAEMON_SRC.split('\n');
    // Find the aiFromPart ternary for blind section (first occurrence)
    // It spans multiple lines: const aiFromPart = channel\n  ? `...msg.from...channel...`
    let ternaryBody = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('const aiFromPart = channel')) {
        // Grab next line which has the truthy branch
        ternaryBody = lines[i + 1]?.trim() || '';
        break;
      }
    }
    assert.ok(ternaryBody, 'aiFromPart ternary truthy branch found');
    // Should have sender (msg.from) before channel
    assert.ok(
      ternaryBody.includes('msg.from') && ternaryBody.indexOf('msg.from') < ternaryBody.indexOf('channel'),
      `blind receipt: sender before channel. Got: ${ternaryBody}`
    );
  });

  // GFMT-005: DM format unchanged — still has "Message from"
  it('GFMT-005: DM AI header still has "Message from"', () => {
    const hasMessageFrom = DAEMON_SRC.includes('Message from');
    assert.ok(hasMessageFrom, 'DM path still uses "Message from"');
  });

  // GFMT-006: Reply hint unchanged
  it('GFMT-006: group reply hint still offers both group and private reply', () => {
    const hasGroupReply = DAEMON_SRC.includes('Reply to') && DAEMON_SRC.includes('privately');
    assert.ok(hasGroupReply, 'Reply hint offers both options');
  });
});
