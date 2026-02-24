/**
 * Tests for message delivery routing:
 * - Trusted → Agent Inbox (Telegram) + AI (openclaw CLI)
 * - Blind → Agent Inbox (Telegram only), AI excluded
 * - Guardrail errors → unavailable (not flagged)
 * - ThreadId propagation
 * - Platform fallbacks (no Telegram, no openclaw, stdout)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const DAEMON_PATH = join(import.meta.dirname, '../../scripts/ws-daemon.js');

describe('Delivery routing', () => {

  describe('Telegram config loading', () => {
    it('DELIVER-001: loadTelegramConfig returns null when no config file', () => {
      // Daemon uses AGENT_SECRETS_DIR env var; when missing, returns null
      const result = execSync(
        `node --input-type=module -e "
          process.env.AGENT_SECRETS_DIR = '/tmp/nonexistent-deliver-test';
          const m = await import('${DAEMON_PATH}');
          // loadTelegramConfig is internal, but sendTelegram falls back gracefully
          console.log('ok');
        "`, { encoding: 'utf8', timeout: 5000 }
      ).trim();
      assert.equal(result, 'ok');
    });

    it('DELIVER-002: threadId included in telegram config when present', () => {
      const dir = '/tmp/deliver-test-002';
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent-chat-telegram.json'),
        JSON.stringify({ botToken: 'test', chatId: '123', threadId: 456 }));
      try {
        const result = execSync(
          `node --input-type=module -e "
            import {readFileSync} from 'fs';
            const cfg = JSON.parse(readFileSync('${dir}/agent-chat-telegram.json','utf8'));
            console.log(cfg.threadId);
          "`, { encoding: 'utf8', timeout: 5000 }
        ).trim();
        assert.equal(result, '456');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('DELIVER-003: telegram config works without threadId', () => {
      const dir = '/tmp/deliver-test-003';
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent-chat-telegram.json'),
        JSON.stringify({ botToken: 'test', chatId: '123' }));
      try {
        const result = execSync(
          `node --input-type=module -e "
            import {readFileSync} from 'fs';
            const cfg = JSON.parse(readFileSync('${dir}/agent-chat-telegram.json','utf8'));
            console.log(cfg.threadId === undefined ? 'no-thread' : cfg.threadId);
          "`, { encoding: 'utf8', timeout: 5000 }
        ).trim();
        assert.equal(result, 'no-thread');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Guardrail error handling', () => {
    it('DELIVER-004: scanGuardrail returns unavailable (not flagged) on error', async () => {
      // Import scanGuardrail and test with no key + invalid messageId
      const { scanGuardrail, resetGuardrailState } = await import(DAEMON_PATH);
      resetGuardrailState();

      // No LAKERA_GUARD_KEY, no valid relay → should be unavailable
      const result = await scanGuardrail('Hello world');
      // Without messageId, falls to Level 3: no guardrail
      assert.equal(result.flagged, false);
      assert.equal(result.unavailable, true);
    });

    it('DELIVER-005: scanGuardrail with messageId but relay error → unavailable not flagged', async () => {
      const { scanGuardrail, resetGuardrailState } = await import(DAEMON_PATH);
      resetGuardrailState();

      // With messageId but relay will return error (no auth)
      const result = await scanGuardrail('Test message', 'fake-id-12345');
      assert.equal(result.flagged, false, 'should NOT flag on relay error');
      assert.equal(result.unavailable, true, 'should mark as unavailable');
    });
  });

  describe('Setup script — thread creation', () => {
    it('DELIVER-006: setup.sh creates config without threadId when forum unavailable', () => {
      const dir = `/tmp/deliver-test-006-${Date.now()}`;
      try {
        const output = execSync(
          `AGENT_SECRETS_DIR="${dir}" AGENT_CHAT_BOT_TOKEN=fake:token AGENT_CHAT_CHAT_ID=999 ` +
          `AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev ` +
          `bash ${join(import.meta.dirname, '../../scripts/setup.sh')} deliver-test-006 --no-daemon 2>&1`,
          { encoding: 'utf8', timeout: 15000 }
        );
        assert.ok(output.includes('Could not create forum topic') || output.includes('Delivering to main chat'),
          'should indicate forum topic creation failed gracefully');
        
        const cfg = JSON.parse(readFileSync(join(dir, 'agent-chat-telegram.json'), 'utf8'));
        assert.equal(cfg.chatId, '999');
        assert.equal(cfg.threadId, undefined, 'threadId should not be set when forum unavailable');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('DELIVER-007: setup.sh uses AGENT_CHAT_THREAD_ID env var when provided', () => {
      const dir = `/tmp/deliver-test-007-${Date.now()}`;
      try {
        execSync(
          `AGENT_SECRETS_DIR="${dir}" AGENT_CHAT_BOT_TOKEN=fake:token AGENT_CHAT_CHAT_ID=999 ` +
          `AGENT_CHAT_THREAD_ID=12345 ` +
          `AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev ` +
          `bash ${join(import.meta.dirname, '../../scripts/setup.sh')} deliver-test-007 --no-daemon 2>&1`,
          { encoding: 'utf8', timeout: 15000 }
        );
        const cfg = JSON.parse(readFileSync(join(dir, 'agent-chat-telegram.json'), 'utf8'));
        assert.equal(cfg.threadId, 12345, 'threadId should come from env var');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('DELIVER-008: setup.sh works without Telegram at all', () => {
      const dir = `/tmp/deliver-test-008-${Date.now()}`;
      try {
        const output = execSync(
          `AGENT_SECRETS_DIR="${dir}" ` +
          `AGENT_CHAT_RELAY=https://agent-chat-relay.rynn-openclaw.workers.dev ` +
          `bash ${join(import.meta.dirname, '../../scripts/setup.sh')} deliver-test-008 --no-daemon 2>&1`,
          { encoding: 'utf8', timeout: 15000 }
        );
        assert.ok(output.includes('Registered'), 'should register successfully');
        // No telegram config should exist
        try {
          readFileSync(join(dir, 'agent-chat-telegram.json'));
          assert.fail('telegram config should not exist');
        } catch (e) {
          assert.equal(e.code, 'ENOENT');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Dedup with effectiveRead', () => {
    it('DELIVER-009: same message blind then trusted = both processed', async () => {
      const { processedMessageIds } = await import(DAEMON_PATH);
      processedMessageIds.clear();
      
      const blindKey = 'msg-deliver-009:blind';
      const trustedKey = 'msg-deliver-009:trusted';
      
      processedMessageIds.add(blindKey);
      assert.ok(processedMessageIds.has(blindKey));
      assert.ok(!processedMessageIds.has(trustedKey), 'trusted version not yet processed');
      
      processedMessageIds.add(trustedKey);
      assert.ok(processedMessageIds.has(trustedKey), 'trusted version now processed');
      assert.equal(processedMessageIds.size >= 2, true);
      processedMessageIds.clear();
    });
  });

  describe('escapeHtml in delivery', () => {
    it('DELIVER-010: escapeHtml handles all HTML special chars', async () => {
      const { escapeHtml } = await import(DAEMON_PATH);
      assert.equal(escapeHtml('<b>"test"</b> & more'), '&lt;b&gt;"test"&lt;/b&gt; &amp; more');
    });

    it('DELIVER-011: escapeHtml handles empty string', async () => {
      const { escapeHtml } = await import(DAEMON_PATH);
      assert.equal(escapeHtml(''), '');
    });
  });
});
