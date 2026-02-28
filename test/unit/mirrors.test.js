/**
 * Unit tests for mirror configuration and formatting.
 * Tests: MR-001..027
 *
 * loadMirrors(direction, handle) reads from telegram.json and returns an array
 * of mirror targets for the given direction ('inbound' or 'outbound').
 *
 * formatMirrorText(dataDir, text, opts) applies symmetric formatting when
 * mirrorFormat: "symmetric" is set in telegram.json.
 *
 * Supports formats:
 *   - Per-handle: { "mirrors": { "inbound": { "@handle": [...] } } }
 *   - Wildcard:   { "mirrors": { "inbound": { "*": [...] } } }
 *   - Legacy:     { "mirrors": [...] } (used for both directions)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = join(tmpdir(), `mirrors-${Date.now()}`);

// Replicate loadMirrorConfig / loadMirrors / formatMirrorText from source
function loadMirrorConfig(dataDir) {
  try {
    const dataFile = join(dataDir, 'telegram.json');
    return JSON.parse(readFileSync(dataFile, 'utf8'));
  } catch { return {}; }
}

function loadMirrors(dataDir, direction, handle) {
  try {
    const data = loadMirrorConfig(dataDir);
    const m = data.mirrors;
    if (!m) return [];
    if (Array.isArray(m)) return m.filter(t => t && t.chatId);
    if (m.inbound || m.outbound) {
      const bucket = direction === 'outbound' ? m.outbound : m.inbound;
      if (!bucket) return [];
      if (Array.isArray(bucket)) return bucket.filter(t => t && t.chatId);
      const key = handle ? handle.replace(/^@/, '') : null;
      const targets = (key && bucket[key]) || (key && bucket[`@${key}`]) || bucket['*'];
      return Array.isArray(targets) ? targets.filter(t => t && t.chatId) : [];
    }
    const key = handle ? handle.replace(/^@/, '') : null;
    const entry = (key && m[key]) || (key && m[`@${key}`]) || m['*'];
    if (!entry) return [];
    if (Array.isArray(entry)) return entry.filter(t => t && t.chatId);
    const targets = direction === 'outbound' ? entry.outbound : entry.inbound;
    return Array.isArray(targets) ? targets.filter(t => t && t.chatId) : [];
  } catch { return []; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtHandle(name) {
  if (!name) return '???';
  if (name.startsWith('#')) return name;
  if (name.startsWith('@')) return name;
  return `@${name}`;
}

function formatMirrorText(text, mirror, opts) {
  if (mirror.format !== 'symmetric' || !opts) return text;
  const { from, to, plaintext } = opts;
  if (!from || !to || !plaintext) return text;
  return `💬 <b>${escapeHtml(fmtHandle(from))} → ${escapeHtml(fmtHandle(to))}</b>:\n\n${escapeHtml(plaintext)}`;
}

before(() => {
  mkdirSync(BASE, { recursive: true });
});

after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('mirror config loading', () => {

  // --- New format tests ---

  it('MR-001: new format — loads inbound mirrors', () => {
    const dir = join(BASE, 'mr1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        inbound: [{ chatId: '-100111' }, { chatId: '-100222' }],
        outbound: [{ chatId: '-100333' }]
      }
    }));
    const result = loadMirrors(dir, 'inbound', null);
    assert.equal(result.length, 2);
    assert.equal(result[0].chatId, '-100111');
    assert.equal(result[1].chatId, '-100222');
  });

  it('MR-002: new format — loads outbound mirrors', () => {
    const dir = join(BASE, 'mr2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        inbound: [{ chatId: '-100111' }],
        outbound: [{ chatId: '-100333' }, { chatId: '-100444' }]
      }
    }));
    const result = loadMirrors(dir, 'outbound', null);
    assert.equal(result.length, 2);
    assert.equal(result[0].chatId, '-100333');
    assert.equal(result[1].chatId, '-100444');
  });

  it('MR-003: new format — inbound only, outbound returns empty', () => {
    const dir = join(BASE, 'mr3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: [{ chatId: '-100111' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 1);
    assert.equal(loadMirrors(dir, 'outbound', null).length, 0);
  });

  it('MR-004: new format — outbound only, inbound returns empty', () => {
    const dir = join(BASE, 'mr4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { outbound: [{ chatId: '-100333' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 0);
    assert.equal(loadMirrors(dir, 'outbound', null).length, 1);
  });

  it('MR-005: new format — threadId preserved', () => {
    const dir = join(BASE, 'mr5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: [{ chatId: '-100111', threadId: 42 }] }
    }));
    const result = loadMirrors(dir, 'inbound', null);
    assert.equal(result[0].threadId, 42);
  });

  // --- Legacy format tests ---

  it('MR-006: legacy flat array — works for both directions', () => {
    const dir = join(BASE, 'mr6');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: [{ chatId: '-100111' }, { chatId: '-100222' }]
    }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 2);
    assert.equal(loadMirrors(dir, 'outbound', null).length, 2);
  });

  // --- Edge cases ---

  it('MR-007: no mirrors key — returns empty', () => {
    const dir = join(BASE, 'mr7');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({ chatId: '123' }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 0);
    assert.equal(loadMirrors(dir, 'outbound', null).length, 0);
  });

  it('MR-008: no telegram.json — returns empty', () => {
    const dir = join(BASE, 'mr8');
    mkdirSync(dir, { recursive: true });
    assert.equal(loadMirrors(dir, 'inbound', null).length, 0);
  });

  it('MR-009: invalid JSON — returns empty', () => {
    const dir = join(BASE, 'mr9');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), 'NOT JSON');
    assert.equal(loadMirrors(dir, 'inbound', null).length, 0);
  });

  it('MR-010: filters out entries without chatId', () => {
    const dir = join(BASE, 'mr10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: [{ chatId: '-100111' }, { threadId: 5 }, null, { chatId: '-100222' }] }
    }));
    const result = loadMirrors(dir, 'inbound', null);
    assert.equal(result.length, 2);
  });

  it('MR-011: empty mirrors object — returns empty', () => {
    const dir = join(BASE, 'mr11');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {}
    }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 0);
    assert.equal(loadMirrors(dir, 'outbound', null).length, 0);
  });

  it('MR-012: empty legacy array — returns empty', () => {
    const dir = join(BASE, 'mr12');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: []
    }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 0);
  });

  // --- Per-handle tests ---

  it('MR-013: per-handle — matches specific handle', () => {
    const dir = join(BASE, 'mr13');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        inbound: {
          'claudia': [{ chatId: '-100111' }],
          'sev1': [{ chatId: '-100222' }]
        }
      }
    }));
    const result = loadMirrors(dir, 'inbound', 'claudia');
    assert.equal(result.length, 1);
    assert.equal(result[0].chatId, '-100111');
  });

  it('MR-014: per-handle — handle with @ prefix', () => {
    const dir = join(BASE, 'mr14');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: { 'claudia': [{ chatId: '-100111' }] } }
    }));
    assert.equal(loadMirrors(dir, 'inbound', '@claudia').length, 1);
  });

  it('MR-015: per-handle — config has @ prefix, handle without', () => {
    const dir = join(BASE, 'mr15');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: { '@claudia': [{ chatId: '-100111' }] } }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia').length, 1);
  });

  it('MR-016: per-handle — unmatched handle returns empty', () => {
    const dir = join(BASE, 'mr16');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: { 'claudia': [{ chatId: '-100111' }] } }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'sev1').length, 0);
  });

  it('MR-017: per-handle — wildcard * as fallback', () => {
    const dir = join(BASE, 'mr17');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: { '*': [{ chatId: '-100999' }] } }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'anyone').length, 1);
    assert.equal(loadMirrors(dir, 'inbound', 'anyone')[0].chatId, '-100999');
  });

  it('MR-018: per-handle — specific handle overrides wildcard', () => {
    const dir = join(BASE, 'mr18');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        inbound: {
          'claudia': [{ chatId: '-100111' }],
          '*': [{ chatId: '-100999' }]
        }
      }
    }));
    const claudia = loadMirrors(dir, 'inbound', 'claudia');
    assert.equal(claudia.length, 1);
    assert.equal(claudia[0].chatId, '-100111');
    const other = loadMirrors(dir, 'inbound', 'someone');
    assert.equal(other.length, 1);
    assert.equal(other[0].chatId, '-100999');
  });

  it('MR-019: per-handle — null handle falls back to wildcard', () => {
    const dir = join(BASE, 'mr19');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: { '*': [{ chatId: '-100999' }] } }
    }));
    assert.equal(loadMirrors(dir, 'inbound', null).length, 1);
  });

  it('MR-020: per-handle — group handle with #', () => {
    const dir = join(BASE, 'mr20');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { inbound: { '#clawns': [{ chatId: '-100111' }] } }
    }));
    // # doesn't get stripped (only @ does)
    assert.equal(loadMirrors(dir, 'inbound', '#clawns').length, 1);
  });

  it('MR-021: per-handle — outbound per-handle works too', () => {
    const dir = join(BASE, 'mr21');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        outbound: { 'claudia': [{ chatId: '-100111' }] },
        inbound: { 'claudia': [{ chatId: '-100222' }] }
      }
    }));
    assert.equal(loadMirrors(dir, 'outbound', 'claudia')[0].chatId, '-100111');
    assert.equal(loadMirrors(dir, 'inbound', 'claudia')[0].chatId, '-100222');
  });
});

// --- Handle-first format tests ---

describe('mirror handle-first config', () => {

  it('MR-028: handle-first — array = both directions', () => {
    const dir = join(BASE, 'mr28');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '@claudia': [{ chatId: '-100111' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia').length, 1);
    assert.equal(loadMirrors(dir, 'outbound', 'claudia').length, 1);
    assert.equal(loadMirrors(dir, 'inbound', 'claudia')[0].chatId, '-100111');
  });

  it('MR-029: handle-first — split inbound/outbound per handle', () => {
    const dir = join(BASE, 'mr29');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        '@claudia': {
          inbound: [{ chatId: '-100111' }],
          outbound: [{ chatId: '-100222' }]
        }
      }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia')[0].chatId, '-100111');
    assert.equal(loadMirrors(dir, 'outbound', 'claudia')[0].chatId, '-100222');
  });

  it('MR-030: handle-first — unmatched handle returns empty', () => {
    const dir = join(BASE, 'mr30');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '@claudia': [{ chatId: '-100111' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'sev1').length, 0);
  });

  it('MR-031: handle-first — wildcard * fallback', () => {
    const dir = join(BASE, 'mr31');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '*': [{ chatId: '-100999' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'anyone')[0].chatId, '-100999');
    assert.equal(loadMirrors(dir, 'outbound', 'anyone')[0].chatId, '-100999');
  });

  it('MR-032: handle-first — specific overrides wildcard', () => {
    const dir = join(BASE, 'mr32');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: {
        '@claudia': [{ chatId: '-100111' }],
        '*': [{ chatId: '-100999' }]
      }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia')[0].chatId, '-100111');
    assert.equal(loadMirrors(dir, 'inbound', 'sev1')[0].chatId, '-100999');
  });

  it('MR-033: handle-first — group handle #clawns', () => {
    const dir = join(BASE, 'mr33');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '#clawns': [{ chatId: '-100111' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', '#clawns').length, 1);
  });

  it('MR-034: handle-first — split with only inbound', () => {
    const dir = join(BASE, 'mr34');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '@claudia': { inbound: [{ chatId: '-100111' }] } }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia').length, 1);
    assert.equal(loadMirrors(dir, 'outbound', 'claudia').length, 0);
  });

  it('MR-035: handle-first — threadId preserved', () => {
    const dir = join(BASE, 'mr35');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '@claudia': [{ chatId: '-100111', threadId: 42 }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia')[0].threadId, 42);
  });

  it('MR-036: handle-first — multiple targets per handle', () => {
    const dir = join(BASE, 'mr36');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({
      chatId: '123',
      mirrors: { '@claudia': [{ chatId: '-100111' }, { chatId: '-100222' }] }
    }));
    assert.equal(loadMirrors(dir, 'inbound', 'claudia').length, 2);
  });
});

// --- Symmetric format tests ---

describe('mirror symmetric format', () => {

  const sym = { chatId: '-100', format: 'symmetric' };
  const raw = { chatId: '-100' };
  const rawExplicit = { chatId: '-100', format: 'raw' };

  it('MR-022: symmetric format — basic from → to', () => {
    const result = formatMirrorText('original html', sym, { from: 'claudia', to: 'rinny', plaintext: 'hello!' });
    assert.equal(result, '💬 <b>@claudia → @rinny</b>:\n\nhello!');
  });

  it('MR-023: symmetric format — escapes HTML in plaintext', () => {
    const result = formatMirrorText('x', sym, { from: 'claudia', to: 'rinny', plaintext: '<script>alert("xss")</script>' });
    assert.ok(result.includes('&lt;script&gt;'));
    assert.ok(!result.includes('<script>'));
  });

  it('MR-024: symmetric format — preserves group handle #', () => {
    const result = formatMirrorText('x', sym, { from: 'claudia', to: '#clawns', plaintext: 'hi group' });
    assert.equal(result, '💬 <b>@claudia → #clawns</b>:\n\nhi group');
  });

  it('MR-025: no format — returns original text', () => {
    const original = '📨 <b>@claudia</b>:\n\nhello';
    const result = formatMirrorText(original, raw, { from: 'claudia', to: 'rinny', plaintext: 'hello' });
    assert.equal(result, original);
  });

  it('MR-026: format raw — returns original text', () => {
    const original = '📤 <b>@rinny → @claudia</b>:\n\nhello';
    const result = formatMirrorText(original, rawExplicit, { from: 'rinny', to: 'claudia', plaintext: 'hello' });
    assert.equal(result, original);
  });

  it('MR-027: symmetric format — missing opts returns original', () => {
    const original = 'some text';
    assert.equal(formatMirrorText(original, sym, null), original);
    assert.equal(formatMirrorText(original, sym, { from: null, to: 'rinny', plaintext: 'hi' }), original);
  });

  it('MR-037: format on target — mixed targets different formats', () => {
    const text = '📨 <b>@claudia</b>:\n\nhello';
    const symResult = formatMirrorText(text, sym, { from: 'claudia', to: 'rinny', plaintext: 'hello' });
    const rawResult = formatMirrorText(text, raw, { from: 'claudia', to: 'rinny', plaintext: 'hello' });
    assert.equal(symResult, '💬 <b>@claudia → @rinny</b>:\n\nhello');
    assert.equal(rawResult, text);
  });
});
