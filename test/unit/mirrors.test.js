/**
 * Unit tests for mirror configuration and formatting.
 * Tests: MR-001..030
 *
 * Config format:
 *   { "mirrors": { "handle": [{ "chatId": "...", "format"?: "symmetric", "direction"?: "inbound"|"outbound", "threadId"?: N }] } }
 *
 * - Value is always an array of targets
 * - No direction field = both directions
 * - "direction": "inbound" or "outbound" = only that direction
 * - Handle keys: bare name, @name, #name, ~name all match (prefixes stripped)
 * - "*" = wildcard fallback
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = join(tmpdir(), `mirrors-${Date.now()}`);

function loadMirrorConfig(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'telegram.json'), 'utf8'));
  } catch { return {}; }
}

function loadMirrors(dataDir, direction, handle) {
  try {
    const data = loadMirrorConfig(dataDir);
    const m = data.mirrors;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
    const key = handle ? handle.replace(/^[@#~]/, '') : null;
    const entry = (key && m[key]) || (key && m[`@${key}`]) || (key && m[`#${key}`]) || (key && m[`~${key}`]) || m['*'];
    if (!Array.isArray(entry)) return [];
    return entry.filter(t => t && t.chatId && (!t.direction || t.direction === direction));
  } catch { return []; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtHandle(name, type) {
  if (!name) return '???';
  if (name.startsWith('@') || name.startsWith('#') || name.startsWith('~')) return name;
  const prefixes = { personal: '@', group: '#', broadcast: '~' };
  return `${prefixes[type || 'personal'] || '@'}${name}`;
}

function formatMirrorText(text, mirror, opts) {
  if (mirror.format !== 'symmetric' || !opts) return text;
  const { from, to, toType, plaintext } = opts;
  if (!from || !to || !plaintext) return text;
  return `💬 <b>${escapeHtml(fmtHandle(from))} → ${escapeHtml(fmtHandle(to, toType))}</b>:\n\n${escapeHtml(plaintext)}`;
}

function cfg(dataDir, data) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'telegram.json'), JSON.stringify(data));
}

before(() => mkdirSync(BASE, { recursive: true }));
after(() => rmSync(BASE, { recursive: true, force: true }));

// --- Config loading ---

describe('mirror config loading', () => {

  it('MR-001: basic — loads targets for handle', () => {
    const d = join(BASE, 'mr01');
    cfg(d, { mirrors: { clawns: [{ chatId: '-100111' }, { chatId: '-100222' }] } });
    const r = loadMirrors(d, 'inbound', 'clawns');
    assert.equal(r.length, 2);
    assert.equal(r[0].chatId, '-100111');
  });

  it('MR-002: both directions by default', () => {
    const d = join(BASE, 'mr02');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 1);
    assert.equal(loadMirrors(d, 'outbound', 'claudia').length, 1);
  });

  it('MR-003: direction inbound — only inbound', () => {
    const d = join(BASE, 'mr03');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100', direction: 'inbound' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 1);
    assert.equal(loadMirrors(d, 'outbound', 'claudia').length, 0);
  });

  it('MR-004: direction outbound — only outbound', () => {
    const d = join(BASE, 'mr04');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100', direction: 'outbound' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
    assert.equal(loadMirrors(d, 'outbound', 'claudia').length, 1);
  });

  it('MR-005: mixed — one target both, one inbound only', () => {
    const d = join(BASE, 'mr05');
    cfg(d, { mirrors: { claudia: [
      { chatId: '-100111' },
      { chatId: '-100222', direction: 'inbound' }
    ] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 2);
    assert.equal(loadMirrors(d, 'outbound', 'claudia').length, 1);
  });

  it('MR-006: threadId preserved', () => {
    const d = join(BASE, 'mr06');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100', threadId: 42 }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia')[0].threadId, 42);
  });

  it('MR-007: unmatched handle — empty', () => {
    const d = join(BASE, 'mr07');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'sev1').length, 0);
  });

  it('MR-008: wildcard * fallback', () => {
    const d = join(BASE, 'mr08');
    cfg(d, { mirrors: { '*': [{ chatId: '-100999' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'anyone')[0].chatId, '-100999');
  });

  it('MR-009: specific overrides wildcard', () => {
    const d = join(BASE, 'mr09');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100111' }], '*': [{ chatId: '-100999' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia')[0].chatId, '-100111');
    assert.equal(loadMirrors(d, 'inbound', 'sev1')[0].chatId, '-100999');
  });

  it('MR-010: multiple targets per handle', () => {
    const d = join(BASE, 'mr10');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100111' }, { chatId: '-100222' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 2);
  });

  it('MR-011: filters out entries without chatId', () => {
    const d = join(BASE, 'mr11');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100' }, { threadId: 1 }, null, {}] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 1);
  });

  it('MR-012: no mirrors key — empty', () => {
    const d = join(BASE, 'mr12');
    cfg(d, { chatId: '123' });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
  });

  it('MR-013: no telegram.json — empty', () => {
    const d = join(BASE, 'mr13-nonexistent');
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
  });

  it('MR-014: invalid JSON — empty', () => {
    const d = join(BASE, 'mr14');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'telegram.json'), 'not json{{{');
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
  });

  it('MR-015: empty mirrors object — empty', () => {
    const d = join(BASE, 'mr15');
    cfg(d, { mirrors: {} });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
  });

  it('MR-016: mirrors as array (invalid) — empty', () => {
    const d = join(BASE, 'mr16');
    cfg(d, { mirrors: [{ chatId: '-100' }] });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
  });

  it('MR-017: handle value not array — empty', () => {
    const d = join(BASE, 'mr17');
    cfg(d, { mirrors: { claudia: 'not an array' } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 0);
  });
});

// --- Prefix matching ---

describe('mirror prefix matching', () => {

  it('MR-018: config @claudia matches relay bare claudia', () => {
    const d = join(BASE, 'mr18');
    cfg(d, { mirrors: { '@claudia': [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'claudia').length, 1);
  });

  it('MR-019: config #clawns matches relay bare clawns', () => {
    const d = join(BASE, 'mr19');
    cfg(d, { mirrors: { '#clawns': [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'clawns').length, 1);
  });

  it('MR-020: config bare clawns matches relay bare clawns', () => {
    const d = join(BASE, 'mr20');
    cfg(d, { mirrors: { clawns: [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', 'clawns').length, 1);
  });

  it('MR-021: handle with @ prefix matches config without', () => {
    const d = join(BASE, 'mr21');
    cfg(d, { mirrors: { claudia: [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', '@claudia').length, 1);
  });

  it('MR-022: handle with # prefix matches config without', () => {
    const d = join(BASE, 'mr22');
    cfg(d, { mirrors: { clawns: [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', '#clawns').length, 1);
  });

  it('MR-023: null handle falls back to wildcard', () => {
    const d = join(BASE, 'mr23');
    cfg(d, { mirrors: { '*': [{ chatId: '-100' }] } });
    assert.equal(loadMirrors(d, 'inbound', null).length, 1);
  });
});

// --- Symmetric format ---

describe('mirror symmetric format', () => {

  const sym = { chatId: '-100', format: 'symmetric' };
  const raw = { chatId: '-100' };

  it('MR-024: basic from → to', () => {
    const r = formatMirrorText('original', sym, { from: 'claudia', to: 'rinny', plaintext: 'hello!' });
    assert.equal(r, '💬 <b>@claudia → @rinny</b>:\n\nhello!');
  });

  it('MR-025: escapes HTML', () => {
    const r = formatMirrorText('x', sym, { from: 'claudia', to: 'rinny', plaintext: '<b>xss</b>' });
    assert.ok(r.includes('&lt;b&gt;'));
  });

  it('MR-026: group toType shows #', () => {
    const r = formatMirrorText('x', sym, { from: 'claudia', to: 'clawns', toType: 'group', plaintext: 'hi' });
    assert.equal(r, '💬 <b>@claudia → #clawns</b>:\n\nhi');
  });

  it('MR-027: no format — returns original', () => {
    const original = '📨 <b>@claudia</b>:\n\nhello';
    assert.equal(formatMirrorText(original, raw, { from: 'claudia', to: 'rinny', plaintext: 'hello' }), original);
  });

  it('MR-028: missing opts — returns original', () => {
    assert.equal(formatMirrorText('text', sym, null), 'text');
    assert.equal(formatMirrorText('text', sym, { from: null, to: 'rinny', plaintext: 'hi' }), 'text');
  });

  it('MR-029: different targets different formats', () => {
    const text = '📨 original';
    assert.equal(formatMirrorText(text, sym, { from: 'claudia', to: 'rinny', plaintext: 'hi' }), '💬 <b>@claudia → @rinny</b>:\n\nhi');
    assert.equal(formatMirrorText(text, raw, { from: 'claudia', to: 'rinny', plaintext: 'hi' }), text);
  });

  it('MR-030: bare handles — no double prefix', () => {
    const r = formatMirrorText('x', sym, { from: 'claudia', to: 'sev1', plaintext: 'hey' });
    assert.ok(!r.includes('@@'));
    assert.ok(!r.includes('##'));
  });
});
