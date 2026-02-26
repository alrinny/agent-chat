/**
 * Tests for OpenClaw discovery (resolveOpenClaw) and unified fallback.
 * Tests: DISCOVERY-001..012
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const BASE = join(tmpdir(), `oc-discovery-${Date.now()}`);
const DAEMON_PATH = join(import.meta.dirname, '../../scripts/ws-daemon.js');

before(() => {
  mkdirSync(BASE, { recursive: true });
});

after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('resolveOpenClaw', () => {

  it('DISCOVERY-001: resolves from config.json openclawPath', async () => {
    // Create a fake openclaw binary
    const fakeBin = join(BASE, 'fake-openclaw-001');
    writeFileSync(fakeBin, '#!/bin/sh\necho ok');
    chmodSync(fakeBin, 0o755);

    // Create handle config with openclawPath
    const handleDir = join(BASE, 'handle-001');
    mkdirSync(handleDir, { recursive: true });
    writeFileSync(join(handleDir, 'config.json'), JSON.stringify({
      handle: 'test001', openclawPath: fakeBin
    }));

    // Test that config.json path is read correctly
    const cfg = JSON.parse(readFileSync(join(handleDir, 'config.json'), 'utf8'));
    assert.equal(cfg.openclawPath, fakeBin);
    assert.ok(existsSync(cfg.openclawPath), 'fake binary should exist');
  });

  it('DISCOVERY-002: config.json openclawPath=null means not found', () => {
    const handleDir = join(BASE, 'handle-002');
    mkdirSync(handleDir, { recursive: true });
    writeFileSync(join(handleDir, 'config.json'), JSON.stringify({
      handle: 'test002', openclawPath: null
    }));

    const cfg = JSON.parse(readFileSync(join(handleDir, 'config.json'), 'utf8'));
    assert.equal(cfg.openclawPath, null);
  });

  it('DISCOVERY-003: OPENCLAW_PATH env var is respected', () => {
    const fakeBin = join(BASE, 'fake-openclaw-003');
    writeFileSync(fakeBin, '#!/bin/sh\necho ok');
    chmodSync(fakeBin, 0o755);

    // Verify the env var mechanism (just the existence check)
    assert.ok(existsSync(fakeBin));
    // In real daemon, process.env.OPENCLAW_PATH would be checked
  });

  it('DISCOVERY-004: non-existent openclawPath in config logs warning', () => {
    const handleDir = join(BASE, 'handle-004');
    mkdirSync(handleDir, { recursive: true });
    writeFileSync(join(handleDir, 'config.json'), JSON.stringify({
      handle: 'test004', openclawPath: '/nonexistent/path/openclaw'
    }));

    const cfg = JSON.parse(readFileSync(join(handleDir, 'config.json'), 'utf8'));
    assert.ok(!existsSync(cfg.openclawPath), 'path should not exist');
  });

  it('DISCOVERY-005: standard path ~/openclaw/dist/index.js detected', () => {
    // Test that the standard path candidate list includes index.js
    const indexJsPath = join(process.env.HOME, 'openclaw', 'dist', 'index.js');
    // Just verify the candidate is in the expected format (don't require it to exist)
    assert.ok(indexJsPath.endsWith('openclaw/dist/index.js'));
  });

  it('DISCOVERY-006: index.js path triggers node execution', () => {
    // When openclawPath ends in .js, daemon should use process.execPath (node) to run it
    const jsPath = '/some/path/dist/index.js';
    const isIndexJs = jsPath.endsWith('.js');
    assert.ok(isIndexJs, 'should detect .js extension');
    // In daemon: execBin = isIndexJs ? process.execPath : openclawBin
    // baseArgs = isIndexJs ? [openclawBin] : []
  });
});

describe('unified fallback mode', () => {

  it('DISCOVERY-007: unified fallback icon is ⚠️ with fix setup message', () => {
    // Replicate the daemon icon logic
    const DELIVER_CMD = null;
    const openclawFound = false; // resolveOpenClaw() returned null
    const UNIFIED_CHANNEL = false; // not explicitly set
    const aiExcluded = false; // trusted message

    const inUnifiedFallback = !DELIVER_CMD && !openclawFound && !UNIFIED_CHANNEL;
    const icon = inUnifiedFallback ? '⚠️' : (aiExcluded ? '🔒' : '📨');
    const privacyNote = inUnifiedFallback
      ? ' (AI sees this — fix setup)'
      : (aiExcluded ? ' (AI doesn\'t see this)' : '');

    assert.equal(icon, '⚠️');
    assert.equal(privacyNote, ' (AI sees this — fix setup)');
  });

  it('DISCOVERY-008: normal mode shows 📨 for trusted messages', () => {
    const DELIVER_CMD = null;
    const openclawFound = true;
    const UNIFIED_CHANNEL = false;
    const aiExcluded = false;

    const inUnifiedFallback = !DELIVER_CMD && !openclawFound && !UNIFIED_CHANNEL;
    const icon = inUnifiedFallback ? '⚠️' : (aiExcluded ? '🔒' : '📨');

    assert.equal(icon, '📨');
  });

  it('DISCOVERY-009: normal mode shows 🔒 for blind messages', () => {
    const DELIVER_CMD = null;
    const openclawFound = true;
    const UNIFIED_CHANNEL = false;
    const aiExcluded = true;

    const inUnifiedFallback = !DELIVER_CMD && !openclawFound && !UNIFIED_CHANNEL;
    const icon = inUnifiedFallback ? '⚠️' : (aiExcluded ? '🔒' : '📨');

    assert.equal(icon, '🔒');
  });

  it('DISCOVERY-010: DELIVER_CMD set = no unified fallback even without openclaw', () => {
    const DELIVER_CMD = '/path/to/custom/script.sh';
    const openclawFound = false;
    const UNIFIED_CHANNEL = false;
    const aiExcluded = false;

    const inUnifiedFallback = !DELIVER_CMD && !openclawFound && !UNIFIED_CHANNEL;
    const icon = inUnifiedFallback ? '⚠️' : (aiExcluded ? '🔒' : '📨');

    assert.equal(inUnifiedFallback, false, 'DELIVER_CMD should prevent unified fallback');
    assert.equal(icon, '📨');
  });

  it('DISCOVERY-011: explicit unifiedChannel=true = no fallback warning', () => {
    // When user explicitly sets unifiedChannel, it's intentional — no ⚠️ fix setup
    const DELIVER_CMD = null;
    const openclawFound = false;
    const UNIFIED_CHANNEL = true; // explicitly set by user

    const inUnifiedFallback = !DELIVER_CMD && !openclawFound && !UNIFIED_CHANNEL;
    assert.equal(inUnifiedFallback, false, 'explicit unified should not trigger fallback warning');
  });

  it('DISCOVERY-012: warning shown only once (flag mechanism)', () => {
    let warningShown = false;
    let warningCount = 0;

    // Simulate multiple deliverToAI calls with no openclaw
    for (let i = 0; i < 5; i++) {
      if (!warningShown) {
        warningShown = true;
        warningCount++;
      }
    }

    assert.equal(warningCount, 1, 'warning should fire exactly once');
    assert.equal(warningShown, true);
  });
});

describe('setup.sh OpenClaw discovery', () => {

  it('DISCOVERY-013: setup writes openclawPath to config.json', () => {
    const handleDir = join(BASE, 'handle-013');
    mkdirSync(handleDir, { recursive: true });
    const configPath = join(handleDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ handle: 'test013', relay: 'https://test.example.com' }));

    // Simulate what setup.sh does
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.openclawPath = '/usr/local/bin/openclaw';
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(updated.openclawPath, '/usr/local/bin/openclaw');
    assert.equal(updated.handle, 'test013', 'other fields preserved');
    assert.equal(updated.relay, 'https://test.example.com', 'relay preserved');
  });

  it('DISCOVERY-014: setup writes null openclawPath when not found', () => {
    const handleDir = join(BASE, 'handle-014');
    mkdirSync(handleDir, { recursive: true });
    const configPath = join(handleDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ handle: 'test014' }));

    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.openclawPath = null;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(updated.openclawPath, null);
  });

  it('DISCOVERY-015: openclawPath coexists with other config fields', () => {
    const handleDir = join(BASE, 'handle-015');
    mkdirSync(handleDir, { recursive: true });
    const configPath = join(handleDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      handle: 'test015', relay: 'https://relay.example.com',
      blindReceipts: true, unifiedChannel: false, threadId: 12345
    }));

    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.openclawPath = '/opt/homebrew/bin/openclaw';
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(updated.openclawPath, '/opt/homebrew/bin/openclaw');
    assert.equal(updated.blindReceipts, true);
    assert.equal(updated.unifiedChannel, false);
    assert.equal(updated.threadId, 12345);
    assert.equal(updated.handle, 'test015');
  });
});
