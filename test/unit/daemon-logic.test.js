/**
 * Unit tests for ws-daemon.js logic — message handling, dedup, escapeHtml.
 * Does NOT test actual WS/HTTP connections (that's integration).
 *
 * Tests: DAEMON-DEDUP-001..003, DAEMON-ESCAPE-001..002
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, processedMessageIds, getGuardrailState, resetGuardrailState } from '../../scripts/ws-daemon.js';

before(() => {
  processedMessageIds.clear();
});

describe('escapeHtml', () => {
  it('DAEMON-ESCAPE-001: escapes HTML entities', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('DAEMON-ESCAPE-002: escapes ampersands', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });
});

describe('Deduplication', () => {
  it('DAEMON-DEDUP-001: first message passes dedup', () => {
    const dedupKey = 'msg-001:trusted';
    assert.equal(processedMessageIds.has(dedupKey), false);
    processedMessageIds.add(dedupKey);
    assert.equal(processedMessageIds.has(dedupKey), true);
  });

  it('DAEMON-DEDUP-002: same id+effectiveRead is duplicate', () => {
    const dedupKey = 'msg-001:trusted';
    assert.equal(processedMessageIds.has(dedupKey), true);
  });

  it('DAEMON-DEDUP-003: same id with different effectiveRead passes (redeliver)', () => {
    const dedupKey = 'msg-001:blind';
    assert.equal(processedMessageIds.has(dedupKey), false);
  });
});

describe('Deduplication — processedMessageIds', () => {
  it('processedMessageIds is a Set that tracks dedup keys', () => {
    processedMessageIds.clear();
    processedMessageIds.add('msg-1:trusted');
    processedMessageIds.add('msg-1:blind');
    assert.equal(processedMessageIds.size, 2); // same ID, different effectiveRead
    assert.ok(processedMessageIds.has('msg-1:trusted'));
    assert.ok(processedMessageIds.has('msg-1:blind'));
    processedMessageIds.clear();
  });
});

describe('Guardrail health state', () => {
  // GUARD-DEGRADE-STATE-001: initial state is clean
  it('initial guardrail state: 0 failures, no alert', () => {
    resetGuardrailState();
    const state = getGuardrailState();
    assert.equal(state.failures, 0);
    assert.equal(state.alertSent, false);
  });

  // GUARD-DEGRADE-STATE-002: reset clears state
  it('resetGuardrailState clears failures and alert flag', () => {
    // Manually can't set failures from outside, but reset should work
    resetGuardrailState();
    const state = getGuardrailState();
    assert.equal(state.failures, 0);
    assert.equal(state.alertSent, false);
  });

  // GUARD-DEGRADE-STATE-003: getGuardrailState returns current state
  it('getGuardrailState returns { failures, alertSent }', () => {
    const state = getGuardrailState();
    assert.ok('failures' in state);
    assert.ok('alertSent' in state);
    assert.equal(typeof state.failures, 'number');
    assert.equal(typeof state.alertSent, 'boolean');
  });
});
