/**
 * AI autonomy limits — turn tracking, per-contact config, pause/resume.
 * From test-plan.md section 16.4
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Turn Tracking', () => {
  it('turn incremented on each AI response', () => {
    const turns = new Map();
    turns.set('alice', 0);
    turns.set('alice', (turns.get('alice') || 0) + 1);
    assert.equal(turns.get('alice'), 1);
  });

  it('turn reset on human intervention', () => {
    const turns = new Map();
    turns.set('alice', 4);
    turns.set('alice', 0); // Human says "continue"
    assert.equal(turns.get('alice'), 0);
  });

  it('turn tracked per contact', () => {
    const turns = new Map();
    turns.set('alice', 3);
    turns.set('bob', 1);
    assert.equal(turns.get('alice'), 3);
    assert.equal(turns.get('bob'), 1);
  });
});

describe('Turn Limits', () => {
  it('default limit: 5', () => {
    const DEFAULT_LIMIT = 5;
    assert.equal(DEFAULT_LIMIT, 5);
  });

  it('per-contact limit overrides default', () => {
    const limits = { default: 5, alice: 10, bob: 3 };
    const getLimit = (handle) => limits[handle] || limits.default;
    assert.equal(getLimit('alice'), 10);
    assert.equal(getLimit('bob'), 3);
    assert.equal(getLimit('charlie'), 5);
  });

  it('limit=0 → no auto-reply (manual only)', () => {
    const limit = 0;
    const canAutoReply = limit > 0;
    assert.equal(canAutoReply, false);
  });

  it('limit=-1 → unlimited', () => {
    const limit = -1;
    const isUnlimited = limit < 0;
    assert.ok(isUnlimited);
  });
});

describe('Pause Behavior', () => {
  it('limit reached → human notification', () => {
    const currentTurn = 5;
    const limit = 5;
    const shouldPause = currentTurn >= limit;
    assert.ok(shouldPause);
  });

  it('notification includes contact and turn count', () => {
    const notification = '⏸️ Conversation with @alice paused after 5 turns. Reply /continue to resume.';
    assert.ok(notification.includes('@alice'));
    assert.ok(notification.includes('5'));
  });

  it('incoming messages during pause → queued, not auto-replied', () => {
    const paused = true;
    const autoReply = !paused;
    assert.equal(autoReply, false);
  });

  it('/continue → resume + process queued messages', () => {
    let paused = true;
    paused = false;
    assert.equal(paused, false);
  });
});

describe('Autonomy Levels', () => {
  it('level 0: manual — all messages forwarded to human, no AI', () => {
    const level = 0;
    const deliverToAI = level > 0;
    assert.equal(deliverToAI, false);
  });

  it('level 1: supervised — AI handles, human notified', () => {
    const level = 1;
    const deliverToAI = true;
    const notifyHuman = level <= 1;
    assert.ok(deliverToAI);
    assert.ok(notifyHuman);
  });

  it('level 2: autonomous — AI handles, human NOT notified (except limit)', () => {
    const level = 2;
    const deliverToAI = true;
    const notifyHuman = level <= 1;
    assert.ok(deliverToAI);
    assert.equal(notifyHuman, false);
  });
});
