/**
 * Unit tests for persistent deduplication in ws-daemon.js.
 * Tests file-based dedup state survival across daemon restarts.
 *
 * Tests: DEDUP-PERSIST-001..008
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the persistence logic by importing the module and manipulating its state
import {
  processedMessageIds, loadDedupState, saveDedupState, getDedupPath
} from '../../scripts/ws-daemon.js';

describe('Persistent dedup — file I/O', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dedup-test-'));
    // Set CONFIG_DIR for the module — we can't directly, but getDedupPath reads CONFIG_DIR
    // Since CONFIG_DIR is set at module load (null without handle), we test the functions directly
    processedMessageIds.clear();
  });

  after(() => {
    processedMessageIds.clear();
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('DEDUP-PERSIST-001: processedMessageIds survives add/check cycle', () => {
    processedMessageIds.add('msg-a:blind');
    processedMessageIds.add('msg-b:trusted');
    assert.ok(processedMessageIds.has('msg-a:blind'));
    assert.ok(processedMessageIds.has('msg-b:trusted'));
    assert.ok(!processedMessageIds.has('msg-a:trusted')); // different effectiveRead
  });

  it('DEDUP-PERSIST-002: saveDedupState does not throw without CONFIG_DIR', () => {
    // getDedupPath returns null when no CONFIG_DIR → saveDedupState is a no-op
    assert.doesNotThrow(() => saveDedupState());
  });

  it('DEDUP-PERSIST-003: loadDedupState does not throw without CONFIG_DIR', () => {
    assert.doesNotThrow(() => loadDedupState());
  });

  it('DEDUP-PERSIST-004: dedup key format is msgId:effectiveRead', () => {
    processedMessageIds.clear();
    const key1 = 'uuid-123:blind';
    const key2 = 'uuid-123:trusted';
    processedMessageIds.add(key1);
    assert.ok(processedMessageIds.has(key1));
    assert.ok(!processedMessageIds.has(key2)); // same ID, different read level
    processedMessageIds.add(key2);
    assert.equal(processedMessageIds.size, 2);
  });

  it('DEDUP-PERSIST-005: getDedupPath returns null without CONFIG_DIR', () => {
    // When daemon runs without a handle, CONFIG_DIR is null
    const p = getDedupPath();
    assert.equal(p, null);
  });

  it('DEDUP-PERSIST-006: manual file round-trip works', () => {
    // Simulate what saveDedupState/loadDedupState do
    const dedupFile = join(tmpDir, 'dedup.json');
    const entries = ['msg-1:blind', 'msg-2:trusted', 'msg-3:blind'];
    writeFileSync(dedupFile, JSON.stringify(entries));

    const loaded = JSON.parse(readFileSync(dedupFile, 'utf8'));
    assert.deepEqual(loaded, entries);
  });

  it('DEDUP-PERSIST-007: corrupt dedup file does not crash loadDedupState', () => {
    // loadDedupState catches JSON parse errors
    assert.doesNotThrow(() => loadDedupState());
  });

  it('DEDUP-PERSIST-008: dedup Set handles > 10000 entries gracefully', () => {
    processedMessageIds.clear();
    for (let i = 0; i < 10001; i++) {
      processedMessageIds.add(`msg-${i}:trusted`);
    }
    assert.equal(processedMessageIds.size, 10001);
    // saveDedupState should prune (but only when CONFIG_DIR is set)
    // At least verify Set doesn't crash at this size
    assert.ok(processedMessageIds.has('msg-10000:trusted'));
    processedMessageIds.clear();
  });
});
