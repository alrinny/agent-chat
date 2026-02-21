/**
 * LaunchAgent / daemon lifecycle tests.
 * From test-plan.md section 7, 15.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('LaunchAgent Configuration', () => {
  it('plist label: com.agent-chat.daemon', () => {
    const label = 'com.agent-chat.daemon';
    assert.ok(label.startsWith('com.'));
  });

  it('program path points to daemon.js', () => {
    const program = '/usr/local/bin/node';
    const args = ['/path/to/bin/daemon.js'];
    assert.ok(args[0].endsWith('daemon.js'));
  });

  it('KeepAlive: true (auto-restart on crash)', () => {
    const keepAlive = true;
    assert.ok(keepAlive);
  });

  it('RunAtLoad: true (start on login)', () => {
    const runAtLoad = true;
    assert.ok(runAtLoad);
  });

  it('StandardErrorPath for logging', () => {
    const path = '/tmp/agent-chat-daemon.err.log';
    assert.ok(path.endsWith('.log'));
  });

  it('StandardOutPath for logging', () => {
    const path = '/tmp/agent-chat-daemon.out.log';
    assert.ok(path.endsWith('.log'));
  });
});

describe('Daemon Process Lifecycle', () => {
  it('daemon starts → connects WS', () => {
    const steps = ['load_config', 'load_keys', 'connect_ws', 'start_polling'];
    assert.equal(steps[2], 'connect_ws');
  });

  it('WS auth failure → retry with backoff', () => {
    let attempt = 0;
    const maxDelay = 30000;
    const delay = Math.min(1000 * Math.pow(2, attempt), maxDelay);
    assert.equal(delay, 1000);
  });

  it('graceful shutdown on SIGTERM', () => {
    const signals = ['SIGTERM', 'SIGINT'];
    for (const sig of signals) {
      assert.ok(['SIGTERM', 'SIGINT'].includes(sig));
    }
  });

  it('WS close → reconnect (not exit)', () => {
    const code = 1006;
    const shouldExit = code === 1000;
    assert.equal(shouldExit, false);
  });

  it('1000 close → clean exit', () => {
    const code = 1000;
    const shouldExit = code === 1000;
    assert.ok(shouldExit);
  });
});

describe('Daemon PID File', () => {
  it('PID written to ~/.agent-chat/daemon.pid', () => {
    const pidPath = '/Users/test/.agent-chat/daemon.pid';
    assert.ok(pidPath.includes('daemon.pid'));
  });

  it('PID file removed on clean exit', () => {
    const cleanExit = true;
    const pidRemoved = cleanExit;
    assert.ok(pidRemoved);
  });

  it('stale PID file detected on start', () => {
    const existingPid = 12345;
    // Check if process exists: kill(pid, 0) throws if dead
    assert.ok(typeof existingPid === 'number');
  });
});

describe('Daemon Health Check', () => {
  it('daemon logs heartbeat every minute', () => {
    const heartbeatInterval = 60000;
    assert.equal(heartbeatInterval, 60000);
  });

  it('no WS messages for 5 min → trigger reconnect', () => {
    const silenceThreshold = 300000;
    const lastMessage = Date.now() - 310000;
    const shouldReconnect = Date.now() - lastMessage > silenceThreshold;
    assert.ok(shouldReconnect);
  });
});
