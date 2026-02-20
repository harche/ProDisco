import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from '@grpc/grpc-js';

import { SandboxManager } from '../sandbox-manager.js';
import { startServer } from '@prodisco/sandbox-server/server';
import { SandboxClient } from '@prodisco/sandbox-server/client';
import { createRunSandboxTool, type SandboxClientResolver } from '../tools/prodisco/runSandbox.js';
import { DEFAULT_LIBRARIES_CONFIG } from '../config/libraries.js';
import { SCRIPTS_CACHE_DIR } from '../util/paths.js';

// Use unique socket paths per test suite to avoid conflicts
const SOCKET_A = '/tmp/prodisco-sandbox-mgr-test-a.sock';
const SOCKET_B = '/tmp/prodisco-sandbox-mgr-test-b.sock';
const CACHE_DIR_A = '/tmp/prodisco-test-cache-mgr-a';
const CACHE_DIR_B = '/tmp/prodisco-test-cache-mgr-b';

let serverA: Server;
let serverB: Server;
let clientA: SandboxClient;
let clientB: SandboxClient;

beforeAll(async () => {
  // Configure sandbox environment (same as runSandbox.test.ts)
  process.env.SANDBOX_SOCKET_PATH = SOCKET_A;
  process.env.SCRIPTS_CACHE_DIR = SCRIPTS_CACHE_DIR;

  // Start two independent sandbox servers to simulate per-session sandboxes
  serverA = await startServer({ socketPath: SOCKET_A, cacheDir: CACHE_DIR_A });
  serverB = await startServer({ socketPath: SOCKET_B, cacheDir: CACHE_DIR_B });

  clientA = new SandboxClient({ socketPath: SOCKET_A });
  clientB = new SandboxClient({ socketPath: SOCKET_B });

  const [healthyA, healthyB] = await Promise.all([
    clientA.waitForHealthy(5000),
    clientB.waitForHealthy(5000),
  ]);
  if (!healthyA || !healthyB) {
    throw new Error('Sandbox servers failed to start');
  }
});

afterAll(() => {
  clientA.close();
  clientB.close();
  serverA.forceShutdown();
  serverB.forceShutdown();
});

// ---------------------------------------------------------------------------
// Single mode tests
// ---------------------------------------------------------------------------

describe('SandboxManager - Single Mode', () => {
  it('returns the shared client for any session ID', async () => {
    const manager = new SandboxManager({ mode: 'single', singleClient: clientA });

    const c1 = await manager.getClient('session-1');
    const c2 = await manager.getClient('session-2');
    const c3 = await manager.getClient(); // no session ID

    expect(c1).toBe(clientA);
    expect(c2).toBe(clientA);
    expect(c3).toBe(clientA);

    await manager.shutdown();
  });

  it('throws if single-mode client is not provided', async () => {
    const manager = new SandboxManager({ mode: 'single' });

    await expect(manager.getClient('session-1')).rejects.toThrow(
      'single-mode client not initialized',
    );

    await manager.shutdown();
  });

  it('onSessionInitialized and onSessionClosed are no-ops', async () => {
    const manager = new SandboxManager({ mode: 'single', singleClient: clientA });

    // Should not throw
    await manager.onSessionInitialized('session-1');
    await manager.onSessionClosed('session-1');

    // Client still works
    const c = await manager.getClient('session-1');
    expect(c).toBe(clientA);

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Multi mode tests (without K8s — testing session tracking and client routing)
// ---------------------------------------------------------------------------

describe('SandboxManager - Multi Mode Session Tracking', () => {
  it('rejects getClient when sessionId is missing', async () => {
    const manager = new SandboxManager({ mode: 'multi' });

    await expect(manager.getClient()).rejects.toThrow(
      'sessionId is required in multi mode',
    );
    await expect(manager.getClient(undefined)).rejects.toThrow(
      'sessionId is required in multi mode',
    );

    await manager.shutdown();
  });

  it('rejects getClient for unknown session (re-creation fails without K8s)', async () => {
    const manager = new SandboxManager({
      mode: 'multi',
      readyTimeoutMs: 1000,
    });

    // Without a real sandbox pod, re-creation attempt will fail
    await expect(manager.getClient('nonexistent')).rejects.toThrow();

    await manager.shutdown();
  }, 10000);

  it('onSessionClosed is idempotent', async () => {
    const manager = new SandboxManager({ mode: 'multi' });

    // Closing a non-existent session should not throw
    await manager.onSessionClosed('nonexistent');
    await manager.onSessionClosed('nonexistent');

    await manager.shutdown();
  });

  it('enforces max sessions limit', async () => {
    const manager = new SandboxManager({
      mode: 'multi',
      maxSessions: 0, // no sessions allowed
    });

    await expect(manager.onSessionInitialized('session-1')).rejects.toThrow(
      'max concurrent sessions reached',
    );

    await manager.shutdown();
  });

  it('shutdown stops the idle reaper timer', async () => {
    const manager = new SandboxManager({
      mode: 'multi',
      idleCheckIntervalMs: 100,
    });

    await manager.shutdown();
    // Should be safe to call again
    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Idle reaper tests
// ---------------------------------------------------------------------------

describe('SandboxManager - Idle Reaper', () => {
  it('reaps sessions after idle timeout', async () => {
    const manager = new SandboxManager({
      mode: 'multi',
      sessionIdleTimeoutMs: 200,  // 200ms idle timeout
      idleCheckIntervalMs: 100,   // check every 100ms
    });

    // Manually inject a session with a dedicated client (not the shared one)
    // so that closing it doesn't affect other tests
    const disposableClient = new SandboxClient({ socketPath: SOCKET_A });
    await disposableClient.waitForHealthy(3000);

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set('idle-session', {
      sandboxName: 'sandbox-idle-session',
      client: disposableClient,
      lastActivityMs: Date.now() - 1000, // Already idle for 1s
    });

    expect(sessions.size).toBe(1);

    // Wait for reaper to run
    await new Promise((r) => setTimeout(r, 500));

    // Session should have been reaped
    expect(sessions.has('idle-session')).toBe(false);

    await manager.shutdown();
  });

  it('does not reap active sessions', async () => {
    const manager = new SandboxManager({
      mode: 'multi',
      sessionIdleTimeoutMs: 5000, // 5s idle timeout
      idleCheckIntervalMs: 100,
    });

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    const disposableClient = new SandboxClient({ socketPath: SOCKET_A });
    await disposableClient.waitForHealthy(3000);

    sessions.set('active-session', {
      sandboxName: 'sandbox-active-session',
      client: disposableClient,
      lastActivityMs: Date.now(), // Just active
    });

    // Wait for reaper cycle
    await new Promise((r) => setTimeout(r, 300));

    // Session should still be there
    expect(sessions.has('active-session')).toBe(true);

    // Cleanup
    disposableClient.close();
    sessions.delete('active-session');
    await manager.shutdown();
  });

  it('getClient updates lastActivityMs', async () => {
    const manager = new SandboxManager({
      mode: 'multi',
      sessionIdleTimeoutMs: 60000,
      idleCheckIntervalMs: 60000,
    });

    const oldTime = Date.now() - 30000;
    const sessions = (manager as unknown as { sessions: Map<string, { lastActivityMs: number }> }).sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions.set('touch-session', { sandboxName: 'sandbox-touch', client: clientA, lastActivityMs: oldTime } as any);

    // getClient should update lastActivityMs
    await manager.getClient('touch-session');

    const updated = sessions.get('touch-session')!;
    expect(updated.lastActivityMs).toBeGreaterThan(oldTime);

    sessions.delete('touch-session');
    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Session-aware runSandbox tool tests
// ---------------------------------------------------------------------------

describe('runSandbox - Session-Aware Client Resolver', () => {
  it('routes execution to session-specific client', async () => {
    const resolver: SandboxClientResolver = (sessionId) => {
      if (sessionId === 'session-a') return clientA;
      if (sessionId === 'session-b') return clientB;
      throw new Error(`Unknown session: ${sessionId}`);
    };

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: resolver,
    });

    // Execute on session A
    const resultA = await tool.execute(
      { mode: 'execute', code: 'console.log("from-A")' },
      { sessionId: 'session-a' },
    );
    expect(resultA).toHaveProperty('success', true);
    expect(resultA).toHaveProperty('output', 'from-A');

    // Execute on session B
    const resultB = await tool.execute(
      { mode: 'execute', code: 'console.log("from-B")' },
      { sessionId: 'session-b' },
    );
    expect(resultB).toHaveProperty('success', true);
    expect(resultB).toHaveProperty('output', 'from-B');
  });

  it('concurrent execution on different sessions does not interfere', async () => {
    const resolver: SandboxClientResolver = (sessionId) => {
      if (sessionId === 'session-a') return clientA;
      if (sessionId === 'session-b') return clientB;
      throw new Error(`Unknown session: ${sessionId}`);
    };

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: resolver,
    });

    const [resultA, resultB] = await Promise.all([
      tool.execute(
        { mode: 'execute', code: 'console.log("concurrent-A")' },
        { sessionId: 'session-a' },
      ),
      tool.execute(
        { mode: 'execute', code: 'console.log("concurrent-B")' },
        { sessionId: 'session-b' },
      ),
    ]);

    expect(resultA).toHaveProperty('success', true);
    expect(resultA).toHaveProperty('output', 'concurrent-A');
    expect(resultB).toHaveProperty('success', true);
    expect(resultB).toHaveProperty('output', 'concurrent-B');
  });

  it('resolver error surfaces in result', async () => {
    const resolver: SandboxClientResolver = () => {
      throw new Error('sandbox not ready');
    };

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: resolver,
    });

    const result = await tool.execute(
      { mode: 'execute', code: 'console.log("hi")' },
      { sessionId: 'bad-session' },
    );

    expect(result).toHaveProperty('success', false);
    expect((result as { error: string }).error).toContain('sandbox not ready');
  });

  it('async resolver (Promise) works', async () => {
    const asyncResolver: SandboxClientResolver = async (sessionId) => {
      await new Promise((r) => setTimeout(r, 10));
      if (sessionId === 'session-a') return clientA;
      throw new Error(`Unknown session: ${sessionId}`);
    };

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: asyncResolver,
    });

    const result = await tool.execute(
      { mode: 'execute', code: 'console.log("async-resolved")' },
      { sessionId: 'session-a' },
    );
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('output', 'async-resolved');
  });

  it('works with stream mode across sessions', async () => {
    const resolver: SandboxClientResolver = (sessionId) => {
      if (sessionId === 'session-b') return clientB;
      throw new Error(`Unknown session: ${sessionId}`);
    };

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: resolver,
    });

    const result = await tool.execute(
      { mode: 'stream', code: 'console.log("streamed")' },
      { sessionId: 'session-b' },
    );

    expect(result).toHaveProperty('mode', 'stream');
    expect(result).toHaveProperty('success', true);
    // Stream mode collects output from chunks
    expect((result as { output: string }).output).toContain('streamed');
  });

  it('works with test mode across sessions', async () => {
    const resolver: SandboxClientResolver = (sessionId) => {
      if (sessionId === 'session-a') return clientA;
      throw new Error(`Unknown session: ${sessionId}`);
    };

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: resolver,
    });

    const result = await tool.execute(
      {
        mode: 'test',
        tests: 'test("basic math", () => { assert.is(1 + 2, 3); });',
      },
      { sessionId: 'session-a' },
    );

    expect(result).toHaveProperty('mode', 'test');
    expect(result).toHaveProperty('success', true);
  });

  it('context without sessionId falls back to default resolver', async () => {
    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      // No getClient — uses getSandboxClient() singleton
    });

    const result = await tool.execute(
      { mode: 'execute', code: 'console.log("no-session")' },
    );
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('output', 'no-session');
  });
});

// ---------------------------------------------------------------------------
// SandboxManager single-mode integration with real sandbox
// ---------------------------------------------------------------------------

describe('SandboxManager - Single Mode Integration', () => {
  it('executes code through SandboxManager.getClient()', async () => {
    const manager = new SandboxManager({ mode: 'single', singleClient: clientA });

    const client = await manager.getClient('any-session');
    const result = await client.execute({ code: 'console.log("via-manager")' });

    expect(result.success).toBe(true);
    expect(result.output).toBe('via-manager');

    await manager.shutdown();
  });

  it('works end-to-end with createRunSandboxTool', async () => {
    const manager = new SandboxManager({ mode: 'single', singleClient: clientB });

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: (sessionId) => manager.getClient(sessionId),
    });

    const result = await tool.execute(
      { mode: 'execute', code: 'console.log("e2e-single")' },
      { sessionId: 'test-session' },
    );

    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('output', 'e2e-single');

    await manager.shutdown();
  });

  it('multiple sequential tool calls on different sessions share the same sandbox', async () => {
    const manager = new SandboxManager({ mode: 'single', singleClient: clientA });

    const tool = createRunSandboxTool({
      libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
      getClient: (sessionId) => manager.getClient(sessionId),
    });

    const r1 = await tool.execute(
      { mode: 'execute', code: 'console.log("s1")' },
      { sessionId: 'session-1' },
    );
    const r2 = await tool.execute(
      { mode: 'execute', code: 'console.log("s2")' },
      { sessionId: 'session-2' },
    );

    expect(r1).toHaveProperty('success', true);
    expect(r1).toHaveProperty('output', 's1');
    expect(r2).toHaveProperty('success', true);
    expect(r2).toHaveProperty('output', 's2');

    await manager.shutdown();
  });
});
