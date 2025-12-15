import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { startServer } from '../server/index.js';
import { SandboxClient } from '../client/index.js';

// Generate unique ID for test isolation
const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe('Integration Tests - Client/Server Communication', () => {
  const testSocketPath = `/tmp/prodisco-sandbox-test-${uniqueId}.sock`;
  const testCacheDir = `/tmp/prodisco-cache-integration-${uniqueId}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    // Start the server
    server = await startServer({
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
    });

    // Create client
    client = new SandboxClient({ socketPath: testSocketPath });

    // Wait for server to be healthy
    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);
  });

  afterAll(async () => {
    // Close client
    client.close();

    // Shutdown server
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) {
          server.forceShutdown();
        }
        resolve();
      });
    });

    // Clean up socket file
    if (existsSync(testSocketPath)) {
      try {
        unlinkSync(testSocketPath);
      } catch {
        // Ignore
      }
    }

    // Clean up cache directory
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  describe('Health Check', () => {
    it('returns healthy status', async () => {
      const result = await client.healthCheck();

      expect(result.healthy).toBe(true);
    });

    it('returns kubernetes context', async () => {
      const result = await client.healthCheck();

      expect(result.kubernetesContext).toBeDefined();
      expect(typeof result.kubernetesContext).toBe('string');
    });
  });

  describe('Code Execution', () => {
    it('executes simple code', async () => {
      const result = await client.execute({
        code: 'console.log("hello from integration test")',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('hello from integration test');
      expect(result.error).toBeUndefined();
    });

    it('handles multiple console outputs', async () => {
      const result = await client.execute({
        code: `
          console.log("line 1");
          console.log("line 2");
          console.log("line 3");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('line 1\nline 2\nline 3');
    });

    it('handles async code', async () => {
      const result = await client.execute({
        code: `
          await new Promise(r => setTimeout(r, 10));
          console.log("async complete");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('async complete');
    });

    it('handles TypeScript code', async () => {
      const result = await client.execute({
        code: `
          interface User { name: string; }
          const user: User = { name: "Test" };
          console.log(user.name);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('Test');
    });

    it('handles execution errors', async () => {
      const result = await client.execute({
        code: 'throw new Error("intentional error")',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('intentional error');
    });

    it('respects timeout', async () => {
      const result = await client.execute({
        code: 'await new Promise(r => setTimeout(r, 10000))',
        timeoutMs: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Script execution timed out');
    });

    it('returns execution time', async () => {
      const result = await client.execute({
        code: 'console.log("timing test")',
      });

      expect(result.success).toBe(true);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Caching', () => {
    it('caches successful executions and returns CacheEntry', async () => {
      const code = `console.log("cache integration test ${Date.now()}")`;
      const result = await client.execute({ code });

      expect(result.success).toBe(true);
      expect(result.cached).toBeDefined();
      expect(result.cached!.name).toMatch(/^script-.*\.ts$/);
      expect(result.cached!.description).toBeDefined();
      expect(result.cached!.contentHash).toBeDefined();
    });

    it('can execute cached scripts', async () => {
      const uniqueValue = `unique-${Date.now()}`;
      const code = `console.log("${uniqueValue}")`;

      // First execution - gets cached
      const firstResult = await client.execute({ code });
      expect(firstResult.success).toBe(true);
      expect(firstResult.cached).toBeDefined();

      // Execute from cache
      const cachedResult = await client.execute({
        cached: firstResult.cached!.name,
      });

      expect(cachedResult.success).toBe(true);
      expect(cachedResult.output).toBe(uniqueValue);
      // When running from cache, cached is not returned (not a new cache)
      expect(cachedResult.cached).toBeUndefined();
    });

    it('returns error for non-existent cached script', async () => {
      const result = await client.execute({
        cached: 'non-existent-script-12345',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('deduplicates cache for identical code', async () => {
      const code = `console.log("dedupe test ${Date.now()}")`;

      const result1 = await client.execute({ code });
      const result2 = await client.execute({ code });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.cached).toBeDefined();
      // Second execution of same code should not create new cache entry
      expect(result2.cached).toBeUndefined();
    });
  });

  describe('Kubernetes Context', () => {
    it('provides k8s library in sandbox', async () => {
      const result = await client.execute({
        code: 'console.log(typeof k8s.KubeConfig)',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('provides pre-configured KubeConfig', async () => {
      const result = await client.execute({
        code: 'console.log(typeof kc.getCurrentContext)',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('can create API clients', async () => {
      const result = await client.execute({
        code: `
          const api = kc.makeApiClient(k8s.CoreV1Api);
          console.log(typeof api);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('object');
    });
  });

  describe('Require Support', () => {
    it('allows require of @kubernetes/client-node', async () => {
      const result = await client.execute({
        code: `
          const k8s = require('@kubernetes/client-node');
          console.log(typeof k8s.KubeConfig);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('allows require of @prodisco/prometheus-client', async () => {
      const result = await client.execute({
        code: `
          const prom = require('@prodisco/prometheus-client');
          console.log(typeof prom.PrometheusClient);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('blocks require of fs', async () => {
      const result = await client.execute({
        code: 'const fs = require("fs")',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Module 'fs' not available");
    });
  });

  describe('Concurrent Requests', () => {
    it('handles multiple concurrent executions', async () => {
      const requests = Array.from({ length: 10 }, (_, i) => ({
        code: `console.log("concurrent ${i}")`,
      }));

      const results = await Promise.all(
        requests.map(req => client.execute(req))
      );

      expect(results.every(r => r.success)).toBe(true);
      results.forEach((result, i) => {
        expect(result.output).toBe(`concurrent ${i}`);
      });
    });

    it('handles mixed success/failure concurrent requests', async () => {
      const requests = [
        { code: 'console.log("success")' },
        { code: 'throw new Error("fail")' },
        { code: 'console.log("success 2")' },
      ];

      const results = await Promise.all(
        requests.map(req => client.execute(req))
      );

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('handles syntax errors', async () => {
      const result = await client.execute({
        code: 'const x = {',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('handles runtime errors', async () => {
      const result = await client.execute({
        code: 'undefinedVariable.property',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('undefinedVariable');
    });

    it('handles async rejection', async () => {
      const result = await client.execute({
        code: 'await Promise.reject(new Error("async fail"))',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('async fail');
    });

    it('preserves output before error', async () => {
      const result = await client.execute({
        code: `
          console.log("before");
          throw new Error("after");
        `,
      });

      expect(result.success).toBe(false);
      expect(result.output).toBe('before');
      expect(result.error).toBe('after');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty code (treated as no source by client)', async () => {
      // Note: The client treats empty string as falsy, so source is undefined
      // This results in "Either code or cached must be provided" error
      const result = await client.execute({ code: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Either code or cached must be provided');
    });

    it('handles code with only whitespace', async () => {
      // Whitespace is truthy, so this gets executed
      const result = await client.execute({ code: '   ' });

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('handles code with Unicode', async () => {
      const result = await client.execute({
        code: 'console.log("Hello 世界 🌍")',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello 世界 🌍');
    });

    it('handles large output', async () => {
      const result = await client.execute({
        code: `
          for (let i = 0; i < 100; i++) {
            console.log("line " + i);
          }
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output.split('\n').length).toBe(100);
    });
  });
});

// Generate unique ID for SandboxClient tests
const clientUniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe('SandboxClient', () => {
  const testSocketPath = `/tmp/prodisco-client-test-${clientUniqueId}.sock`;
  const testCacheDir = `/tmp/prodisco-cache-client-${clientUniqueId}`;
  let server: grpc.Server;

  beforeAll(async () => {
    server = await startServer({
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) {
          server.forceShutdown();
        }
        resolve();
      });
    });

    if (existsSync(testSocketPath)) {
      try {
        unlinkSync(testSocketPath);
      } catch {
        // Ignore
      }
    }

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  describe('Constructor', () => {
    it('uses provided socket path', () => {
      const client = new SandboxClient({ socketPath: testSocketPath });
      expect(client).toBeInstanceOf(SandboxClient);
      client.close();
    });

    it('uses environment variable for socket path', () => {
      const originalEnv = process.env.SANDBOX_SOCKET_PATH;
      process.env.SANDBOX_SOCKET_PATH = testSocketPath;

      const client = new SandboxClient();
      expect(client).toBeInstanceOf(SandboxClient);
      client.close();

      if (originalEnv) {
        process.env.SANDBOX_SOCKET_PATH = originalEnv;
      } else {
        delete process.env.SANDBOX_SOCKET_PATH;
      }
    });
  });

  describe('waitForHealthy', () => {
    it('returns true when server is healthy', async () => {
      const client = new SandboxClient({ socketPath: testSocketPath });

      const result = await client.waitForHealthy(5000);
      expect(result).toBe(true);

      client.close();
    });

    it('returns false when timeout expires', async () => {
      const client = new SandboxClient({ socketPath: '/tmp/non-existent-socket.sock' });

      const result = await client.waitForHealthy(100, 50);
      expect(result).toBe(false);

      client.close();
    });
  });

  describe('close', () => {
    it('closes the client connection', () => {
      const client = new SandboxClient({ socketPath: testSocketPath });
      expect(() => client.close()).not.toThrow();
    });
  });
});
