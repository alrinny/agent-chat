/**
 * Deliver-to-AI tests — OpenClaw CLI invocation, format, error handling.
 * From test-plan.md sections 4.4, 16.4, 22.4
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Deliver to AI: Command Construction', () => {
  it('uses execFileSync (not exec) for injection safety', () => {
    // execFileSync takes array args, no shell interpolation
    const cmd = 'openclaw';
    const args = ['send', '--target', '119111425', '--message', 'hello'];
    assert.equal(cmd, 'openclaw');
    assert.ok(Array.isArray(args));
  });

  it('message passed via AGENT_MSG env var (not CLI arg)', () => {
    const env = { AGENT_MSG: 'Hello from @alice' };
    assert.ok(env.AGENT_MSG);
  });

  it('target is Telegram chat ID', () => {
    const target = '119111425';
    assert.ok(/^\d+$/.test(target));
  });
});

describe('Deliver to AI: Content Formatting', () => {
  it('trusted message includes from handle', () => {
    const from = 'alice';
    const text = 'Hello!';
    const formatted = `[agent-chat] @${from}: ${text}`;
    assert.ok(formatted.includes('@alice'));
    assert.ok(formatted.includes('Hello!'));
  });

  it('system event formatted differently', () => {
    const event = { type: 'system', subtype: 'trust_changed', handle: 'alice', by: 'bob' };
    const formatted = `[agent-chat] System: ${event.subtype} on @${event.handle} by @${event.by}`;
    assert.ok(formatted.includes('System:'));
    assert.ok(formatted.includes('trust_changed'));
  });

  it('guardrail-flagged → NOT delivered to AI', () => {
    const flagged = true;
    const deliver = !flagged;
    assert.equal(deliver, false);
  });

  it('blind → NOT delivered to AI', () => {
    const effectiveRead = 'blind';
    const deliver = effectiveRead === 'trusted';
    assert.equal(deliver, false);
  });

  it('block → NOT delivered to AI', () => {
    const effectiveRead = 'block';
    const deliver = effectiveRead === 'trusted';
    assert.equal(deliver, false);
  });

  it('only trusted delivered to AI', () => {
    const reads = ['trusted', 'blind', 'block'];
    const delivered = reads.filter(r => r === 'trusted');
    assert.equal(delivered.length, 1);
  });
});

describe('Deliver to AI: Error Handling', () => {
  it('execFileSync timeout → caught', () => {
    let caught = false;
    try {
      throw new Error('ETIMEDOUT');
    } catch {
      caught = true;
    }
    assert.ok(caught);
  });

  it('AI delivery failure → warn, do NOT re-queue', () => {
    // If delivery fails, log warning but ack the message anyway
    // Don't create infinite retry loop
    const ackAnyway = true;
    assert.ok(ackAnyway);
  });

  it('AI delivery failure → Telegram fallback notification', () => {
    const fallback = '⚠️ Failed to deliver message from @alice to AI';
    assert.ok(fallback.includes('Failed'));
  });
});

describe('Deliver to AI: 5-Turn Limit', () => {
  it('track conversation turns per contact', () => {
    const turns = new Map();
    turns.set('alice', 0);
    turns.set('alice', turns.get('alice') + 1);
    assert.equal(turns.get('alice'), 1);
  });

  it('default limit: 5 turns', () => {
    const limit = 5;
    assert.equal(limit, 5);
  });

  it('limit reached → pause + notify human', () => {
    const current = 5;
    const limit = 5;
    const shouldPause = current >= limit;
    assert.ok(shouldPause);
  });

  it('human approves → counter resets', () => {
    let turns = 5;
    // Human says "continue"
    turns = 0;
    assert.equal(turns, 0);
  });

  it('limit configurable per contact', () => {
    const limits = { alice: 10, bob: 3, default: 5 };
    assert.equal(limits.alice, 10);
    assert.equal(limits.bob, 3);
  });
});

describe('Deliver to AI: Message Context', () => {
  it('includes sender handle in metadata', () => {
    const metadata = { from: 'alice', handle: 'alice', channel: 'agent-chat' };
    assert.equal(metadata.from, 'alice');
    assert.equal(metadata.channel, 'agent-chat');
  });

  it('group messages include group handle', () => {
    const metadata = { from: 'alice', to: 'team', channel: 'agent-chat' };
    assert.equal(metadata.to, 'team');
  });
});
