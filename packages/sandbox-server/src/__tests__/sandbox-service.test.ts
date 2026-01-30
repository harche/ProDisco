import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { createSandboxService, type SandboxServiceConfig } from '../server/sandbox-service.js';
import type { ExecuteRequest, ExecuteResponse, HealthCheckRequest, HealthCheckResponse } from '../generated/sandbox.js';
import { existsSync, rmSync } from 'node:fs';

describe('SandboxService', () => {
  // Use unique cache directory per test to avoid conflicts when .ts and .js tests run in parallel
  let testCacheDir: string;

  beforeEach(() => {
    testCacheDir = `/tmp/prodisco-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  // Helper to create mock gRPC call objects
  function createMockCall<T>(request: T): grpc.ServerUnaryCall<T, unknown> {
    return {
      request,
      cancelled: false,
      metadata: new grpc.Metadata(),
      getPeer: () => 'test-peer',
      getDeadline: () => Infinity,
      sendMetadata: vi.fn(),
    } as unknown as grpc.ServerUnaryCall<T, unknown>;
  }

  // Helper to promisify the callback-based handlers
  function promisifyHandler<TReq, TRes>(
    handler: (call: grpc.ServerUnaryCall<TReq, TRes>, callback: grpc.sendUnaryData<TRes>) => void | Promise<void>,
    request: TReq
  ): Promise<TRes> {
    return new Promise((resolve, reject) => {
      const call = createMockCall(request);
      handler(call as any, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve(response);
        } else {
          reject(new Error('No response'));
        }
      });
    });
  }

  describe('createSandboxService', () => {
    it('creates service with default config', () => {
      const service = createSandboxService();

      expect(service).toBeDefined();
      expect(service).toHaveProperty('execute');
      expect(service).toHaveProperty('healthCheck');
      expect(typeof service.execute).toBe('function');
      expect(typeof service.healthCheck).toBe('function');
    });

    it('creates service with custom config', () => {
      const service = createSandboxService({
        prometheusUrl: 'http://localhost:9090',
        cacheDir: testCacheDir,
      });

      expect(service).toBeDefined();
    });
  });

  describe('healthCheck', () => {
    it('returns healthy status', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const response = await promisifyHandler<HealthCheckRequest, HealthCheckResponse>(
        service.healthCheck,
        {}
      );

      expect(response.healthy).toBe(true);
    });

    it('returns kubernetes context', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const response = await promisifyHandler<HealthCheckRequest, HealthCheckResponse>(
        service.healthCheck,
        {}
      );

      expect(response.kubernetesContext).toBeDefined();
      expect(typeof response.kubernetesContext).toBe('string');
    });
  });

  describe('execute - Code Execution', () => {
    it('executes simple code successfully', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("hello")' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('hello');
      expect(response.error).toBeUndefined();
    });

    it('returns execution time as string', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("test")' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.executionTimeMs).toBeDefined();
      expect(typeof response.executionTimeMs).toBe('string');
      expect(parseInt(response.executionTimeMs)).toBeGreaterThanOrEqual(0);
    });

    it('handles execution errors', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'throw new Error("test error")' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('test error');
    });

    it('respects custom timeout', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: {
          $case: 'code',
          code: 'await new Promise(r => setTimeout(r, 5000)); console.log("done");'
        },
        timeoutMs: 100,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('Script execution timed out');
    });

    it('uses default 30000ms timeout when not specified', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("quick")' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
    });
  });

  describe('execute - Caching', () => {
    it('caches successful executions when scriptName provided', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("cache me")' },
        timeoutMs: undefined,
        scriptName: 'cache-test-script',
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.cached).toBeDefined();
      expect(response.cached!.name).toBe('cache-test-script.ts');
    });

    it('does not cache when scriptName not provided', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("no cache")' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.cached).toBeUndefined();
    });

    it('does not cache failed executions', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'throw new Error("fail")' },
        timeoutMs: undefined,
        scriptName: 'fail-script',
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(false);
      expect(response.cached).toBeUndefined();
    });

    it('does not duplicate cache for same script name', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });
      const scriptName = `dedupe-script-${Date.now()}`;

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("dedupe test")' },
        timeoutMs: undefined,
        scriptName,
      };

      const response1 = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      const response2 = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response1.success).toBe(true);
      expect(response2.success).toBe(true);
      expect(response1.cached).toBeDefined();
      // Second execution with same name should not create new cache
      expect(response2.cached).toBeUndefined();
    });
  });

  describe('execute - Cached Script Execution', () => {
    it('executes cached script by name', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      // First, cache some code with a script name
      const cacheRequest: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("cached script output")' },
        timeoutMs: undefined,
        scriptName: 'my-cached-script',
      };

      const cacheResponse = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        cacheRequest
      );

      expect(cacheResponse.cached).toBeDefined();
      expect(cacheResponse.cached!.name).toBe('my-cached-script.ts');

      // Now execute the cached script
      const executeRequest: ExecuteRequest = {
        source: { $case: 'cached', cached: cacheResponse.cached!.name },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        executeRequest
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('cached script output');
      // When running from cache, cached is not returned (not a new cache entry)
      expect(response.cached).toBeUndefined();
    });

    it('returns error for non-existent cached script', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'cached', cached: 'non-existent-script' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
      expect(response.output).toBe('');
      expect(response.executionTimeMs).toBe('0');
    });

    it('finds cached script by partial name', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      // First, cache some code with a script name
      const cacheRequest: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("partial match test")' },
        timeoutMs: undefined,
        scriptName: 'partial-match-script',
      };

      const cacheResponse = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        cacheRequest
      );

      expect(cacheResponse.cached).toBeDefined();
      expect(cacheResponse.cached!.name).toBe('partial-match-script.ts');

      // Execute using just partial name
      const executeRequest: ExecuteRequest = {
        source: { $case: 'cached', cached: 'partial-match' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        executeRequest
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('partial match test');
    });
  });

  describe('execute - Source Validation', () => {
    it('returns error when neither code nor cached is provided', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: undefined,
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('Either code or cached must be provided');
      expect(response.output).toBe('');
      expect(response.executionTimeMs).toBe('0');
    });
  });

  describe('execute - TypeScript Support', () => {
    it('executes TypeScript code', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: {
          $case: 'code',
          code: `
            interface Person { name: string; age: number; }
            const p: Person = { name: "Alice", age: 30 };
            console.log(p.name, p.age);
          `
        },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('Alice 30');
    });
  });

  describe('execute - Async Support', () => {
    it('executes async/await code', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: {
          $case: 'code',
          code: `
            const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
            console.log("start");
            await delay(10);
            console.log("end");
          `
        },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('start\nend');
    });
  });

  describe('execute - Convenience Globals', () => {
    it('does not provide any Kubernetes convenience globals (k8s/kc)', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: {
          $case: 'code',
          code: 'console.log(typeof k8s, typeof kc);'
        },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('undefined undefined');
    });
  });

  describe('execute - Multiple Outputs', () => {
    it('captures all console output', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: {
          $case: 'code',
          code: `
            console.log("line 1");
            console.error("error line");
            console.warn("warn line");
            console.info("info line");
            console.log("line 2");
          `
        },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe(
        'line 1\n[ERROR] error line\n[WARN] warn line\n[INFO] info line\nline 2'
      );
    });
  });

  describe('execute - Edge Cases', () => {
    it('handles empty code', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: '' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('');
    });

    it('handles code with only comments', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: '// just a comment' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('');
    });

    it('handles Unicode in code and output', async () => {
      const service = createSandboxService({ cacheDir: testCacheDir });

      const request: ExecuteRequest = {
        source: { $case: 'code', code: 'console.log("Hello 世界 🌍")' },
        timeoutMs: undefined,
        scriptName: undefined,
      };

      const response = await promisifyHandler<ExecuteRequest, ExecuteResponse>(
        service.execute,
        request
      );

      expect(response.success).toBe(true);
      expect(response.output).toBe('Hello 世界 🌍');
    });
  });
});
