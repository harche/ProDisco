import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { createSandboxService } from '../server/sandbox-service.js';
import { SandboxServiceService, ExecutionState } from '../generated/sandbox.js';
import { SandboxClient } from '../client/index.js';
import { existsSync, rmSync } from 'node:fs';

// Hardcoded ports - src uses 59xxx, dist uses 59500+
const isDistBuild = import.meta.url.includes('/dist/');
const PORT_BASE = isDistBuild ? 59500 : 59000;

describe('Streaming Execution API', () => {
  const testCacheDir = '/tmp/prodisco-stream-test-' + Date.now();
  let server: grpc.Server;
  let client: SandboxClient;
  const port = PORT_BASE + 1;

  beforeAll(async () => {
    // Start server
    server = new grpc.Server();
    const service = createSandboxService({ cacheDir: testCacheDir });
    server.addService(SandboxServiceService, service);

    await new Promise<void>((resolve, reject) => {
      server.bindAsync(`localhost:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) reject(err);
        else {
          resolve();
        }
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

  describe('executeStream()', () => {
    it('streams output from execution', async () => {
      const code = `
        console.log("line 1");
        console.log("line 2");
        console.log("line 3");
      `;

      const chunks: string[] = [];
      let result: any = null;

      for await (const chunk of client.executeStream({ code })) {
        if (chunk.type === 'output') {
          chunks.push(chunk.data as string);
        } else if (chunk.type === 'result') {
          result = chunk.data;
        }
      }

      // Should have received output chunks
      expect(chunks.length).toBeGreaterThan(0);
      const allOutput = chunks.join('');
      expect(allOutput).toContain('line 1');
      expect(allOutput).toContain('line 2');
      expect(allOutput).toContain('line 3');

      // Should have received final result
      expect(result).not.toBeNull();
      expect(result.success).toBe(true);
      expect(result.executionId).toBeDefined();
    });

    it('streams error output', async () => {
      const code = `
        console.log("normal");
        console.error("error message");
        console.log("after error");
      `;

      const outputs: Array<{ type: string; data: string }> = [];
      let result: any = null;

      for await (const chunk of client.executeStream({ code })) {
        if (chunk.type === 'output' || chunk.type === 'error') {
          outputs.push({ type: chunk.type, data: chunk.data as string });
        } else if (chunk.type === 'result') {
          result = chunk.data;
        }
      }

      // Should have error output
      const errorChunks = outputs.filter(o => o.type === 'error');
      expect(errorChunks.length).toBeGreaterThan(0);
      expect(errorChunks.some(c => c.data.includes('[ERROR]'))).toBe(true);

      expect(result?.success).toBe(true);
    });

    it('returns execution ID in all chunks', async () => {
      const code = 'console.log("test");';
      const executionIds = new Set<string>();

      for await (const chunk of client.executeStream({ code })) {
        executionIds.add(chunk.executionId);
      }

      // All chunks should have the same execution ID
      expect(executionIds.size).toBe(1);
      const [executionId] = [...executionIds];
      expect(executionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('handles errors in code', async () => {
      const code = 'throw new Error("test error");';
      let result: any = null;

      for await (const chunk of client.executeStream({ code })) {
        if (chunk.type === 'result') {
          result = chunk.data;
        }
      }

      expect(result).not.toBeNull();
      expect(result.success).toBe(false);
      expect(result.error).toContain('test error');
      expect(result.state).toBe(ExecutionState.EXECUTION_STATE_FAILED);
    });

    it('handles cached script not found', async () => {
      let result: any = null;

      for await (const chunk of client.executeStream({ cached: 'nonexistent' })) {
        if (chunk.type === 'result') {
          result = chunk.data;
        }
      }

      expect(result).not.toBeNull();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('includes timestamp in chunks', async () => {
      const code = 'console.log("test");';
      const timestamps: number[] = [];

      for await (const chunk of client.executeStream({ code })) {
        timestamps.push(chunk.timestampMs);
      }

      expect(timestamps.length).toBeGreaterThan(0);
      timestamps.forEach(ts => {
        expect(ts).toBeGreaterThan(Date.now() - 60000);
        expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
      });
    });
  });

  describe('executeStreamWithAbort()', () => {
    it('can abort execution with AbortController', async () => {
      const code = `
        for (let i = 0; i < 100; i++) {
          console.log("iteration " + i);
          await new Promise(r => setTimeout(r, 50));
        }
      `;

      const controller = new AbortController();
      const chunks: string[] = [];

      // Abort after 200ms
      setTimeout(() => controller.abort(), 200);

      try {
        for await (const chunk of client.executeStreamWithAbort({ code }, controller.signal)) {
          if (chunk.type === 'output') {
            chunks.push(chunk.data as string);
          }
        }
        // Should not reach here
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        // Accept either AbortError (from our code) or CANCELLED (from gRPC)
        expect(
          error.name === 'AbortError' ||
          error.message?.includes('CANCELLED') ||
          error.code === 1 // gRPC CANCELLED code
        ).toBe(true);
      }

      // Should have received some output before abort
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.length).toBeLessThan(100);
    });

    it('completes normally if not aborted', async () => {
      const code = 'console.log("complete");';
      const controller = new AbortController();
      let result: any = null;

      for await (const chunk of client.executeStreamWithAbort({ code }, controller.signal)) {
        if (chunk.type === 'result') {
          result = chunk.data;
        }
      }

      expect(result?.success).toBe(true);
    });
  });
});
