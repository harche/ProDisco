import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { createSandboxService } from '../server/sandbox-service.js';
import { SandboxServiceService, ExecutionState } from '../generated/sandbox.js';
import { SandboxClient } from '../client/index.js';
import { existsSync, rmSync } from 'node:fs';

describe('Async Execution API', () => {
  const testCacheDir = '/tmp/prodisco-async-test-' + Date.now();
  let server: grpc.Server;
  let client: SandboxClient;
  // Use unique port range (51100-51199) to avoid conflicts with transport-security.test.ts
  const port = 51100 + Math.floor(Math.random() * 100);

  beforeAll(async () => {
    // Start server
    server = new grpc.Server();
    const service = createSandboxService({ cacheDir: testCacheDir });
    server.addService(SandboxServiceService, service);

    await new Promise<void>((resolve, reject) => {
      server.bindAsync(`localhost:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Create client
    client = new SandboxClient({ tcpHost: 'localhost', tcpPort: port });

    // Wait for server
    const healthy = await client.waitForHealthy(5000);
    if (!healthy) throw new Error('Server did not become healthy');
  });

  afterAll(() => {
    client.close();
    server.forceShutdown();
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  describe('executeAsync()', () => {
    it('returns execution ID immediately', async () => {
      const code = `
        await new Promise(r => setTimeout(r, 100));
        console.log("done");
      `;

      const start = Date.now();
      const { executionId, state } = await client.executeAsync({ code });
      const elapsed = Date.now() - start;

      // Should return immediately (not wait for execution)
      expect(elapsed).toBeLessThan(50);
      expect(executionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state).toBe(ExecutionState.EXECUTION_STATE_PENDING);
    });

    it('rejects invalid request', async () => {
      await expect(client.executeAsync({ cached: 'nonexistent' }))
        .rejects
        .toThrow(/not found/);
    });
  });

  describe('getExecution()', () => {
    it('returns current status of running execution', async () => {
      const code = `
        console.log("line 1");
        await new Promise(r => setTimeout(r, 200));
        console.log("line 2");
      `;

      const { executionId } = await client.executeAsync({ code });

      // Give it time to start and produce output
      await new Promise(r => setTimeout(r, 50));

      const status = await client.getExecution(executionId);

      expect(status.executionId).toBe(executionId);
      expect([
        ExecutionState.EXECUTION_STATE_PENDING,
        ExecutionState.EXECUTION_STATE_RUNNING,
      ]).toContain(status.state);
    });

    it('returns output incrementally with offset', async () => {
      const code = `
        console.log("first");
        await new Promise(r => setTimeout(r, 100));
        console.log("second");
        await new Promise(r => setTimeout(r, 100));
        console.log("third");
      `;

      const { executionId } = await client.executeAsync({ code });

      // Wait for some output
      await new Promise(r => setTimeout(r, 150));

      // Get first batch
      const status1 = await client.getExecution(executionId);
      const offset1 = status1.outputLength;

      // Wait for more output
      await new Promise(r => setTimeout(r, 150));

      // Get incremental output
      const status2 = await client.getExecution(executionId, { outputOffset: offset1 });

      // Should have new output
      if (status2.outputLength > offset1) {
        expect(status2.output.length).toBeGreaterThan(0);
        // First batch's content should not be included
        expect(status2.output).not.toContain(status1.output.slice(0, 5));
      }
    });

    it('returns NOT_FOUND for invalid execution ID', async () => {
      await expect(client.getExecution('invalid-id'))
        .rejects
        .toThrow(/not found/i);
    });
  });

  describe('waitForExecution()', () => {
    it('waits for execution to complete', async () => {
      const code = `
        await new Promise(r => setTimeout(r, 100));
        console.log("completed");
      `;

      const { executionId } = await client.executeAsync({ code });
      const status = await client.waitForExecution(executionId);

      expect(status.executionId).toBe(executionId);
      expect(status.state).toBe(ExecutionState.EXECUTION_STATE_COMPLETED);
      expect(status.result).toBeDefined();
      expect(status.result?.success).toBe(true);
    });

    it('returns immediately if already completed', async () => {
      const code = 'console.log("quick");';

      const { executionId } = await client.executeAsync({ code });

      // Wait for completion
      await new Promise(r => setTimeout(r, 200));

      const start = Date.now();
      const status = await client.waitForExecution(executionId);
      const elapsed = Date.now() - start;

      expect(status.state).toBe(ExecutionState.EXECUTION_STATE_COMPLETED);
      // Should return quickly since already done
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('cancelExecution()', () => {
    it('cancels a running execution', async () => {
      const code = `
        for (let i = 0; i < 100; i++) {
          console.log("loop " + i);
          await new Promise(r => setTimeout(r, 50));
        }
      `;

      const { executionId } = await client.executeAsync({ code });

      // Wait for it to start
      await new Promise(r => setTimeout(r, 100));

      // Cancel it
      const result = await client.cancelExecution(executionId);

      expect(result.success).toBe(true);
      expect(result.state).toBe(ExecutionState.EXECUTION_STATE_CANCELLED);
    });

    it('returns failure for already completed execution', async () => {
      const code = 'console.log("quick");';

      const { executionId } = await client.executeAsync({ code });

      // Wait for completion
      await new Promise(r => setTimeout(r, 200));

      const result = await client.cancelExecution(executionId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('already finished');
    });

    it('returns NOT_FOUND for invalid execution ID', async () => {
      await expect(client.cancelExecution('invalid-id'))
        .rejects
        .toThrow(/not found/i);
    });
  });

  describe('listExecutions()', () => {
    it('lists recent executions', async () => {
      // Run a few executions
      await client.executeAsync({ code: 'console.log("exec 1");' });
      await client.executeAsync({ code: 'console.log("exec 2");' });
      await client.executeAsync({ code: 'console.log("exec 3");' });

      // Wait for them to complete
      await new Promise(r => setTimeout(r, 200));

      const executions = await client.listExecutions({
        includeCompletedWithinMs: 60000,
      });

      expect(executions.length).toBeGreaterThanOrEqual(3);
      executions.forEach(e => {
        expect(e.executionId).toBeDefined();
        expect(e.state).toBeDefined();
        expect(e.startedAtMs).toBeGreaterThan(0);
      });
    });

    it('filters by state', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 20));
          }
        `,
      });

      // Give it time to start
      await new Promise(r => setTimeout(r, 50));

      const running = await client.listExecutions({
        states: [ExecutionState.EXECUTION_STATE_RUNNING],
      });

      const hasRunning = running.some(e => e.executionId === executionId);
      expect(hasRunning).toBe(true);

      // Cancel it to clean up
      await client.cancelExecution(executionId);
    });

    it('respects limit parameter', async () => {
      const executions = await client.listExecutions({
        limit: 2,
        includeCompletedWithinMs: 60000,
      });

      expect(executions.length).toBeLessThanOrEqual(2);
    });

    it('includes code preview', async () => {
      const code = 'console.log("unique preview test 12345");';
      await client.executeAsync({ code });

      await new Promise(r => setTimeout(r, 200));

      const executions = await client.listExecutions({
        includeCompletedWithinMs: 60000,
      });

      const found = executions.find(e => e.codePreview.includes('unique preview'));
      expect(found).toBeDefined();
    });
  });
});
