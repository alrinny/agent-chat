/**
 * Tests for trust change → redeliver flow.
 *
 * Root cause investigation: when user clicks "Trust @sender",
 * the relay does (in order):
 *   1. system-event "trust_changed" → pushed to WS → daemon re-fetches inbox
 *   2. /redeliver → updates effectiveRead in DO storage (NO WS push)
 *
 * Race condition: daemon re-fetches inbox BEFORE redeliver completes,
 * sees messages still at "blind", processes them as blind (skipped for AI).
 * After redeliver updates to "trusted", nothing notifies the daemon.
 *
 * Tests: TRUST-REDELIVER-001..008
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Trust redeliver race condition', () => {

  // Simulate the relay DO behavior
  class SimulatedDO {
    constructor() {
      this.inbox = [];
      this.wsPushes = [];
    }

    receive(msg) {
      this.inbox.push({ ...msg });
      this.wsPushes.push({ ...msg }); // pushToWs on receive
    }

    systemEvent(event) {
      const sysMsg = { type: 'system', data: event, id: `sys-${Date.now()}`, effectiveRead: 'trusted' };
      this.inbox.push(sysMsg);
      this.wsPushes.push(sysMsg); // pushToWs on system event ✅
    }

    redeliver(sender, newEffectiveRead) {
      if (newEffectiveRead === 'block') {
        this.inbox = this.inbox.filter(m => m.from !== sender);
      } else {
        for (const m of this.inbox) {
          if (m.from === sender) {
            m.effectiveRead = newEffectiveRead;
          }
        }
      }
      // NO pushToWs here! ← THE BUG
    }

    redeliverOne(messageId) {
      const msg = this.inbox.find(m => m.id === messageId);
      if (msg) {
        msg.effectiveRead = 'trusted';
        this.wsPushes.push({ ...msg }); // pushToWs on redeliverOne ✅
      }
    }

    getInbox() {
      return [...this.inbox];
    }

    getWsPushes() {
      return [...this.wsPushes];
    }
  }

  // Simulate daemon behavior on trust_changed
  class SimulatedDaemon {
    constructor(handle) {
      this.handle = handle;
      this.processedKeys = new Set();
      this.deliveredToAI = [];
      this.deliveredToTelegram = [];
    }

    processMessage(msg) {
      const dedupKey = `${msg.id}:${msg.effectiveRead}`;
      if (this.processedKeys.has(dedupKey)) return 'dedup-skip';
      this.processedKeys.add(dedupKey);

      if (msg.effectiveRead === 'trusted') {
        this.deliveredToAI.push(msg);
        this.deliveredToTelegram.push(msg);
        return 'delivered-trusted';
      } else if (msg.effectiveRead === 'blind') {
        this.deliveredToTelegram.push(msg);
        return 'delivered-blind';
      }
      return 'unknown';
    }

    processSystemEvent(event) {
      if (event.data?.event === 'trust_changed' && event.data?.level === 'trust') {
        this.deliveredToAI.push({ type: 'trust-notification', target: event.data.target });
        return 'trust-changed';
      }
      return 'other-event';
    }
  }

  it('TRUST-REDELIVER-001: redeliver does NOT push to WS (confirms bug exists)', () => {
    const dO = new SimulatedDO();

    // Blind message arrives
    dO.receive({ id: 'msg1', from: 'mira', effectiveRead: 'blind', content: 'hello' });
    assert.equal(dO.getWsPushes().length, 1, 'initial receive pushes to WS');

    // Trust change: redeliver
    dO.redeliver('mira', 'trusted');
    assert.equal(dO.getWsPushes().length, 1, 'redeliver does NOT push to WS (bug)');

    // But inbox IS updated
    assert.equal(dO.getInbox()[0].effectiveRead, 'trusted', 'inbox is updated');
  });

  it('TRUST-REDELIVER-002: redeliverOne DOES push to WS (working correctly)', () => {
    const dO = new SimulatedDO();
    dO.receive({ id: 'msg1', from: 'mira', effectiveRead: 'blind', content: 'hello' });

    dO.redeliverOne('msg1');
    assert.equal(dO.getWsPushes().length, 2, 'redeliverOne pushes to WS');
    assert.equal(dO.getWsPushes()[1].effectiveRead, 'trusted');
  });

  it('TRUST-REDELIVER-003: race condition — daemon re-fetches before redeliver completes', () => {
    const dO = new SimulatedDO();
    const daemon = new SimulatedDaemon('rinny');

    // Step 1: blind message arrives, daemon processes it
    dO.receive({ id: 'msg1', from: 'mira', effectiveRead: 'blind', content: 'hello' });
    daemon.processMessage(dO.getWsPushes()[0]);
    assert.equal(daemon.deliveredToAI.length, 0, 'blind message not sent to AI');
    assert.equal(daemon.deliveredToTelegram.length, 1, 'blind message sent to Telegram');

    // Step 2: user clicks Trust → system event fires FIRST
    dO.systemEvent({ event: 'trust_changed', target: 'mira', level: 'trust' });

    // Step 3: daemon receives system event, re-fetches inbox BEFORE redeliver
    // At this point, inbox still has effectiveRead: 'blind' !
    const inboxBeforeRedeliver = dO.getInbox().filter(m => m.type !== 'system');
    assert.equal(inboxBeforeRedeliver[0].effectiveRead, 'blind',
      'RACE: inbox still blind before redeliver runs');

    // Step 4: daemon processes inbox messages (still blind)
    for (const msg of inboxBeforeRedeliver) {
      daemon.processMessage(msg);
    }
    // Dedup catches it — same id:blind already processed
    assert.equal(daemon.deliveredToAI.length, 0, 'still no AI delivery');

    // Step 5: NOW redeliver runs (too late)
    dO.redeliver('mira', 'trusted');
    assert.equal(dO.getInbox()[0].effectiveRead, 'trusted', 'inbox updated to trusted');

    // Step 6: but daemon never sees this update — no WS push, no re-fetch
    // Even if daemon somehow re-fetched now, dedup key "msg1:trusted" would pass
    // but there's no trigger to re-fetch!
    assert.equal(daemon.deliveredToAI.length, 0, 'AI NEVER receives the message (BUG)');
  });

  it('TRUST-REDELIVER-004: even without race, daemon needs re-fetch trigger after redeliver', () => {
    const dO = new SimulatedDO();
    const daemon = new SimulatedDaemon('rinny');

    // Blind message
    dO.receive({ id: 'msg1', from: 'mira', effectiveRead: 'blind', content: 'hello' });
    daemon.processMessage(dO.getWsPushes()[0]);

    // Redeliver happens (no WS push)
    dO.redeliver('mira', 'trusted');

    // Daemon has no way to know redeliver happened unless:
    // a) WS push after redeliver (missing)
    // b) system event + re-fetch (race condition)
    // c) daemon periodically polls (not implemented)
    assert.equal(dO.getWsPushes().length, 1, 'only initial receive was pushed');
  });

  it('TRUST-REDELIVER-005: proposed fix — redeliver should push updated messages', () => {
    const dO = new SimulatedDO();
    const daemon = new SimulatedDaemon('rinny');

    // Blind message
    dO.receive({ id: 'msg1', from: 'mira', effectiveRead: 'blind', content: 'hello' });
    daemon.processMessage(dO.getWsPushes()[0]);

    // Simulate FIXED redeliver that pushes to WS
    dO.redeliver('mira', 'trusted');
    // Simulate what the fix would do:
    const updatedMsgs = dO.getInbox().filter(m => m.from === 'mira' && m.type !== 'system');
    for (const m of updatedMsgs) {
      dO.wsPushes.push({ ...m }); // This is what the fix adds
    }

    // Daemon processes the WS push with new effectiveRead
    const newPush = dO.getWsPushes()[dO.getWsPushes().length - 1];
    assert.equal(newPush.effectiveRead, 'trusted');

    const result = daemon.processMessage(newPush);
    assert.equal(result, 'delivered-trusted', 'dedup passes because key is msg1:trusted (new)');
    assert.equal(daemon.deliveredToAI.length, 1, 'AI receives the message after fix');
  });

  it('TRUST-REDELIVER-006: dedup allows blind→trusted redeliver (different key)', () => {
    const daemon = new SimulatedDaemon('rinny');

    // Process as blind
    daemon.processMessage({ id: 'msg1', from: 'mira', effectiveRead: 'blind' });
    assert.ok(daemon.processedKeys.has('msg1:blind'));

    // Same message, now trusted — dedup key is different
    const result = daemon.processMessage({ id: 'msg1', from: 'mira', effectiveRead: 'trusted' });
    assert.equal(result, 'delivered-trusted', 'different effectiveRead = different dedup key');
    assert.ok(daemon.processedKeys.has('msg1:trusted'));
  });

  it('TRUST-REDELIVER-007: block redeliver removes messages (no push needed)', () => {
    const dO = new SimulatedDO();
    dO.receive({ id: 'msg1', from: 'mira', effectiveRead: 'blind', content: 'hello' });
    dO.receive({ id: 'msg2', from: 'mira', effectiveRead: 'blind', content: 'world' });

    dO.redeliver('mira', 'block');
    const remaining = dO.getInbox().filter(m => m.type !== 'system');
    assert.equal(remaining.length, 0, 'blocked messages removed from inbox');
  });

  it('TRUST-REDELIVER-008: system event arrives and daemon can process it', () => {
    const dO = new SimulatedDO();
    const daemon = new SimulatedDaemon('rinny');

    dO.systemEvent({ event: 'trust_changed', target: 'mira', level: 'trust' });
    const sysMsg = dO.getWsPushes()[0];
    assert.equal(sysMsg.type, 'system');

    const result = daemon.processSystemEvent(sysMsg);
    assert.equal(result, 'trust-changed');
  });
});
