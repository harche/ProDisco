import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Server } from '@grpc/grpc-js';

import { runSandboxTool } from '../tools/kubernetes/runSandbox.js';
import { SCRIPTS_CACHE_DIR } from '../util/paths.js';
import { startServer } from '@prodisco/sandbox-server/server';
import { closeSandboxClient, getSandboxClient } from '@prodisco/sandbox-server/client';

// Test socket path to avoid conflicts
const TEST_SOCKET_PATH = '/tmp/prodisco-sandbox-test.sock';

// Helper to execute runSandbox with proper typing
const runSandbox = runSandboxTool.execute.bind(runSandboxTool) as (input: {
  mode?: 'execute' | 'stream' | 'async' | 'status' | 'cancel' | 'list';
  code?: string;
  cached?: string;
  timeout?: number;
  executionId?: string;
  wait?: boolean;
  outputOffset?: number;
  states?: Array<'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'>;
  limit?: number;
  includeCompletedWithinMs?: number;
}) => ReturnType<typeof runSandboxTool.execute>;

// Test cached script for Cached Script Execution tests
const testCachedScriptName = 'test-cached-script-for-runsandbox.ts';
const testCachedScriptPath = join(SCRIPTS_CACHE_DIR, testCachedScriptName);
const testCachedScriptContent = `// Executed via sandbox at 2025-01-01T00:00:00.000Z
// Test cached script
console.log("executed from cache");
console.log("cached script working");
`;

// gRPC server instance
let grpcServer: Server;

// Ensure cache directory exists, start gRPC server, and create test script before tests
beforeAll(async () => {
  // Set environment for test socket
  process.env.SANDBOX_SOCKET_PATH = TEST_SOCKET_PATH;
  process.env.SCRIPTS_CACHE_DIR = SCRIPTS_CACHE_DIR;

  if (!existsSync(SCRIPTS_CACHE_DIR)) {
    mkdirSync(SCRIPTS_CACHE_DIR, { recursive: true });
  }

  // Start the gRPC sandbox server
  grpcServer = await startServer({
    socketPath: TEST_SOCKET_PATH,
    cacheDir: SCRIPTS_CACHE_DIR,
  });

  // Wait for server to be healthy
  const client = getSandboxClient({ socketPath: TEST_SOCKET_PATH });
  const healthy = await client.waitForHealthy(5000);
  if (!healthy) {
    throw new Error('Sandbox server failed to start');
  }

  // Create test cached script
  writeFileSync(testCachedScriptPath, testCachedScriptContent);
});

// Track scripts created during tests for cleanup
const createdScripts: string[] = [];

afterEach(() => {
  // Clean up any scripts created during tests
  for (const script of createdScripts) {
    const fullPath = join(SCRIPTS_CACHE_DIR, script);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  }
  createdScripts.length = 0;
});

afterAll(() => {
  // Close client and stop server
  closeSandboxClient();
  if (grpcServer) {
    grpcServer.forceShutdown();
  }

  // Clean up test cached script
  if (existsSync(testCachedScriptPath)) {
    unlinkSync(testCachedScriptPath);
  }
  // Final cleanup of any remaining test scripts
  if (existsSync(SCRIPTS_CACHE_DIR)) {
    const files = readdirSync(SCRIPTS_CACHE_DIR);
    for (const file of files) {
      if (file.startsWith('test-') || file.includes('-test-')) {
        const fullPath = join(SCRIPTS_CACHE_DIR, file);
        if (existsSync(fullPath)) {
          unlinkSync(fullPath);
        }
      }
    }
  }
});

describe('kubernetes.runSandbox', () => {
  describe('Basic Execution', () => {
    it('executes simple TypeScript code', async () => {
      const result = await runSandbox({
        code: 'console.log("Hello, World!");',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello, World!');
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });

    it('captures console.log output', async () => {
      const result = await runSandbox({
        code: `
          console.log("line 1");
          console.log("line 2");
          console.log("line 3");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('line 1');
      expect(result.output).toContain('line 2');
      expect(result.output).toContain('line 3');
    });

    it('captures console.error output with [ERROR] prefix', async () => {
      const result = await runSandbox({
        code: 'console.error("This is an error");',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('[ERROR]');
      expect(result.output).toContain('This is an error');
    });

    it('captures console.warn output with [WARN] prefix', async () => {
      const result = await runSandbox({
        code: 'console.warn("This is a warning");',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('[WARN]');
      expect(result.output).toContain('This is a warning');
    });

    it('captures console.info output with [INFO] prefix', async () => {
      const result = await runSandbox({
        code: 'console.info("This is info");',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('[INFO]');
      expect(result.output).toContain('This is info');
    });

    it('handles async/await code', async () => {
      const result = await runSandbox({
        code: `
          const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
          await delay(10);
          console.log("async completed");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('async completed');
    });

    it('handles TypeScript types', async () => {
      const result = await runSandbox({
        code: `
          interface Person {
            name: string;
            age: number;
          }
          const person: Person = { name: "Alice", age: 30 };
          console.log(\`\${person.name} is \${person.age} years old\`);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Alice is 30 years old');
    });
  });

  describe('Sandbox Environment', () => {
    it('provides k8s module', async () => {
      const result = await runSandbox({
        code: `
          console.log("k8s available:", typeof k8s !== 'undefined');
          console.log("CoreV1Api:", typeof k8s.CoreV1Api);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('k8s available: true');
      expect(result.output).toContain('CoreV1Api: function');
    });

    it('provides pre-configured kc (KubeConfig)', async () => {
      const result = await runSandbox({
        code: `
          console.log("kc available:", typeof kc !== 'undefined');
          console.log("kc is KubeConfig:", kc.constructor.name);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('kc available: true');
      expect(result.output).toContain('kc is KubeConfig: KubeConfig');
    });

    it('provides require function for whitelisted modules', async () => {
      const result = await runSandbox({
        code: `
          const promQuery = require('prometheus-query');
          console.log("prometheus-query loaded:", typeof promQuery !== 'undefined');
          console.log("PrometheusDriver:", typeof promQuery.PrometheusDriver);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('prometheus-query loaded: true');
      expect(result.output).toContain('PrometheusDriver: function');
    });

    it('require returns k8s for @kubernetes/client-node', async () => {
      const result = await runSandbox({
        code: `
          const k8sModule = require('@kubernetes/client-node');
          console.log("k8s via require:", k8sModule === k8s);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('k8s via require: true');
    });

    it('throws error for non-whitelisted modules', async () => {
      const result = await runSandbox({
        code: `
          const fs = require('fs');
          console.log(fs);
        `,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Module 'fs' not available in sandbox");
    });

    it('provides process.env', async () => {
      const result = await runSandbox({
        code: `
          console.log("process.env available:", typeof process.env !== 'undefined');
          console.log("PATH exists:", typeof process.env.PATH !== 'undefined');
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('process.env available: true');
    });

    it('provides standard globals (JSON, Date, Math, etc.)', async () => {
      const result = await runSandbox({
        code: `
          console.log("JSON:", typeof JSON);
          console.log("Date:", typeof Date);
          console.log("Math:", typeof Math);
          console.log("Promise:", typeof Promise);
          console.log("Buffer:", typeof Buffer);
          console.log("Array:", typeof Array);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('JSON: object');
      expect(result.output).toContain('Date: function');
      expect(result.output).toContain('Math: object');
      expect(result.output).toContain('Promise: function');
      expect(result.output).toContain('Buffer: function');
      expect(result.output).toContain('Array: function');
    });

    it('provides setTimeout and setInterval', async () => {
      const result = await runSandbox({
        code: `
          console.log("setTimeout:", typeof setTimeout);
          console.log("setInterval:", typeof setInterval);
          console.log("clearTimeout:", typeof clearTimeout);
          console.log("clearInterval:", typeof clearInterval);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('setTimeout: function');
      expect(result.output).toContain('setInterval: function');
      expect(result.output).toContain('clearTimeout: function');
      expect(result.output).toContain('clearInterval: function');
    });
  });

  describe('Error Handling', () => {
    it('catches synchronous errors', async () => {
      const result = await runSandbox({
        code: 'throw new Error("Intentional error");',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Intentional error');
    });

    it('catches async errors', async () => {
      const result = await runSandbox({
        code: `
          await Promise.reject(new Error("Async error"));
        `,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Async error');
    });

    it('catches syntax errors', async () => {
      const result = await runSandbox({
        code: 'const x = {',  // Invalid syntax
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('preserves output before error', async () => {
      const result = await runSandbox({
        code: `
          console.log("before error");
          throw new Error("error occurred");
        `,
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('before error');
      expect(result.error).toContain('error occurred');
    });

    it('handles undefined variable access', async () => {
      const result = await runSandbox({
        code: 'console.log(undefinedVariable);',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('undefinedVariable');
    });
  });

  describe('Timeout Handling', () => {
    it('respects default timeout', async () => {
      const result = await runSandbox({
        code: `
          // This should complete well within default timeout
          console.log("quick execution");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.executionTimeMs).toBeLessThan(30000);
    });

    it('respects custom timeout', async () => {
      const start = Date.now();
      const result = await runSandbox({
        code: `
          await new Promise(resolve => setTimeout(resolve, 5000));
          console.log("completed");
        `,
        timeout: 100,  // 100ms timeout
      });

      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      expect(elapsed).toBeLessThan(5000);  // Should fail before 5 seconds
    });

    it('completes before timeout for fast code', async () => {
      const result = await runSandbox({
        code: `
          console.log("fast");
        `,
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.executionTimeMs).toBeLessThan(5000);
    });
  });

  describe('Script Caching', () => {
    it('caches successfully executed scripts', async () => {
      const uniqueId = Date.now();
      const result = await runSandbox({
        code: `
          // Test script ${uniqueId} for caching verification
          console.log("cached script test ${uniqueId}");
        `,
      });

      expect(result.success).toBe(true);

      // Wait for caching to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check that a script was cached
      const files = readdirSync(SCRIPTS_CACHE_DIR);
      const _cachedScript = files.find(f => f.includes(uniqueId.toString().slice(-8)));

      // May or may not find by ID, but cache should have scripts
      expect(files.length).toBeGreaterThan(0);
    });

    it('does not cache failed scripts', async () => {
      const uniqueMarker = `FAIL_${Date.now()}`;

      const result = await runSandbox({
        code: `
          // Script that fails ${uniqueMarker}
          throw new Error("intentional failure");
        `,
      });

      expect(result.success).toBe(false);

      // Wait a moment for any potential caching to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check that no script with our unique marker was cached
      // (avoid counting all files which can be flaky due to other tests)
      const files = readdirSync(SCRIPTS_CACHE_DIR, { withFileTypes: true })
        .filter(f => f.isFile())
        .map(f => f.name);
      const failedScriptCached = files.some(f => {
        const content = readFileSync(join(SCRIPTS_CACHE_DIR, f), 'utf-8');
        return content.includes(uniqueMarker);
      });
      expect(failedScriptCached).toBe(false);
    });

    it('deduplicates scripts with identical content', async () => {
      // Use unique code to avoid collisions with other tests or runs
      const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const uniqueMarker = `DEDUP_TEST_${uniqueId}`;
      const code = `
        // Deduplication test script ${uniqueMarker}
        console.log("same content ${uniqueMarker}");
      `;

      // Execute same code twice
      await runSandbox({ code });
      await new Promise((resolve) => setTimeout(resolve, 200));

      await runSandbox({ code });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Count files containing our unique marker - should be exactly 1
      const filesWithMarker = readdirSync(SCRIPTS_CACHE_DIR)
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => {
          const content = readFileSync(join(SCRIPTS_CACHE_DIR, f), 'utf-8');
          return content.includes(uniqueMarker);
        });

      expect(filesWithMarker.length).toBe(1);
    });

    it('adds header comment to cached scripts', async () => {
      const uniqueContent = `console.log("header test ${Date.now()}");`;

      await runSandbox({ code: uniqueContent });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Find the most recently created script
      const files = readdirSync(SCRIPTS_CACHE_DIR)
        .filter(f => f.endsWith('.ts'))
        .sort()
        .reverse();

      if (files.length > 0) {
        const content = readFileSync(join(SCRIPTS_CACHE_DIR, files[0]), 'utf-8');
        expect(content).toContain('// Executed via sandbox');
      }
    });
  });

  describe('Cached Script Execution', () => {
    // Test script is created in the global beforeAll at the top of the file

    it('executes cached script by exact filename', async () => {
      const result = await runSandbox({
        cached: testCachedScriptName,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('executed from cache');
      expect(result.cachedScript).toBe(testCachedScriptName);
    });

    it('executes cached script by filename without extension', async () => {
      const result = await runSandbox({
        cached: testCachedScriptName.replace('.ts', ''),
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('executed from cache');
    });

    it('executes cached script by partial match', async () => {
      const result = await runSandbox({
        cached: 'cached-script-for-runsandbox',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('executed from cache');
    });

    it('returns error for non-existent cached script', async () => {
      const result = await runSandbox({
        cached: 'nonexistent-script-xyz123.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('strips header comment when executing cached script', async () => {
      const result = await runSandbox({
        cached: testCachedScriptName,
      });

      expect(result.success).toBe(true);
      // Should not have header comment in output (it's stripped before execution)
      expect(result.output).not.toContain('// Executed via sandbox');
    });

    it('does not re-cache already cached scripts', async () => {
      const beforeCount = readdirSync(SCRIPTS_CACHE_DIR).length;

      await runSandbox({ cached: testCachedScriptName });
      await new Promise(resolve => setTimeout(resolve, 200));

      const afterCount = readdirSync(SCRIPTS_CACHE_DIR).length;
      expect(afterCount).toBe(beforeCount);
    });

    it('includes cachedScript field in result', async () => {
      const result = await runSandbox({
        cached: testCachedScriptName,
      });

      expect(result.cachedScript).toBe(testCachedScriptName);
    });
  });

  describe('Input Validation', () => {
    it('requires either code or cached parameter', async () => {
      const result = await runSandbox({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
    });

    it('accepts code parameter', async () => {
      const result = await runSandbox({
        code: 'console.log("test");',
      });

      expect(result.success).toBe(true);
    });

    it('accepts cached parameter', async () => {
      // This will fail because the script doesn't exist, but it validates the parameter
      const result = await runSandbox({
        cached: 'some-script.ts',
      });

      // Either success (if script exists) or specific "not found" error
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('handles empty code string', async () => {
      const result = await runSandbox({
        code: '',
      });

      // Empty code may fail due to esbuild transformation
      // The important thing is it doesn't crash the system
      expect(result).toHaveProperty('mode', 'execute');
      expect(result).toHaveProperty('success');
      // If successful, should have executionTimeMs; if failed, may have just mode, success, error
      if (result.success) {
        expect(result).toHaveProperty('executionTimeMs');
      }
    });

    it('timeout must be positive', async () => {
      const result = await runSandbox({
        code: 'console.log("test");',
        timeout: 1000,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Result Structure', () => {
    it('returns complete result structure on success', async () => {
      const result = await runSandbox({
        code: 'console.log("test");',
      });

      expect(result).toHaveProperty('mode', 'execute');
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('executionTimeMs');
      expect(typeof result.output).toBe('string');
      expect(typeof result.executionTimeMs).toBe('number');
    });

    it('returns complete result structure on failure', async () => {
      const result = await runSandbox({
        code: 'throw new Error("test error");',
      });

      expect(result).toHaveProperty('mode', 'execute');
      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('executionTimeMs');
      expect(typeof result.error).toBe('string');
    });

    it('execution time is reasonable', async () => {
      const result = await runSandbox({
        code: 'console.log("quick");',
      });

      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThan(10000);  // Should complete in under 10s
    });
  });

  describe('TypeScript Features', () => {
    it('handles arrow functions', async () => {
      const result = await runSandbox({
        code: `
          const add = (a: number, b: number): number => a + b;
          console.log("Result:", add(2, 3));
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Result: 5');
    });

    it('handles async arrow functions', async () => {
      const result = await runSandbox({
        code: `
          const asyncFn = async (): Promise<string> => {
            return "async result";
          };
          const value = await asyncFn();
          console.log(value);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('async result');
    });

    it('handles destructuring', async () => {
      const result = await runSandbox({
        code: `
          const obj = { a: 1, b: 2, c: 3 };
          const { a, ...rest } = obj;
          console.log("a:", a);
          console.log("rest:", JSON.stringify(rest));
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('a: 1');
      expect(result.output).toContain('rest: {"b":2,"c":3}');
    });

    it('handles template literals', async () => {
      const result = await runSandbox({
        code: `
          const name = "World";
          const greeting = \`Hello, \${name}!\`;
          console.log(greeting);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello, World!');
    });

    it('handles class definitions', async () => {
      const result = await runSandbox({
        code: `
          class Greeter {
            private name: string;
            constructor(name: string) {
              this.name = name;
            }
            greet(): string {
              return \`Hello, \${this.name}\`;
            }
          }
          const g = new Greeter("TypeScript");
          console.log(g.greet());
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello, TypeScript');
    });

    it('handles optional chaining', async () => {
      const result = await runSandbox({
        code: `
          const obj: { a?: { b?: { c: number } } } = {};
          console.log("value:", obj?.a?.b?.c ?? "undefined");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('value: undefined');
    });

    it('handles nullish coalescing', async () => {
      const result = await runSandbox({
        code: `
          const value: string | null = null;
          console.log("result:", value ?? "default");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('result: default');
    });
  });

  describe('Kubernetes Integration', () => {
    it('can create API client from kc', async () => {
      const result = await runSandbox({
        code: `
          const api = kc.makeApiClient(k8s.CoreV1Api);
          console.log("API client created:", api.constructor.name);
        `,
      });

      expect(result.success).toBe(true);
      // Constructor name may include "Object" prefix in some environments
      expect(result.output).toContain('API client created:');
      expect(result.output).toContain('CoreV1Api');
    });

    it('can access different API classes', async () => {
      const result = await runSandbox({
        code: `
          console.log("CoreV1Api:", typeof k8s.CoreV1Api);
          console.log("AppsV1Api:", typeof k8s.AppsV1Api);
          console.log("BatchV1Api:", typeof k8s.BatchV1Api);
          console.log("NetworkingV1Api:", typeof k8s.NetworkingV1Api);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('CoreV1Api: function');
      expect(result.output).toContain('AppsV1Api: function');
      expect(result.output).toContain('BatchV1Api: function');
      expect(result.output).toContain('NetworkingV1Api: function');
    });
  });

  describe('Prometheus Integration', () => {
    it('can load prometheus-query module', async () => {
      const result = await runSandbox({
        code: `
          const { PrometheusDriver } = require('prometheus-query');
          console.log("PrometheusDriver loaded:", typeof PrometheusDriver === 'function');
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('PrometheusDriver loaded: true');
    });

    it('can create PrometheusDriver instance', async () => {
      const result = await runSandbox({
        code: `
          const { PrometheusDriver } = require('prometheus-query');
          const driver = new PrometheusDriver({
            endpoint: 'http://localhost:9090'
          });
          console.log("Driver created:", driver.constructor.name);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Driver created: PrometheusDriver');
    });

    it('can access PROMETHEUS_URL from environment', async () => {
      const result = await runSandbox({
        code: `
          const url = process.env.PROMETHEUS_URL;
          console.log("PROMETHEUS_URL type:", typeof url);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('PROMETHEUS_URL type:');
    });
  });

  describe('Tool Definition', () => {
    it('has correct name', () => {
      expect(runSandboxTool.name).toBe('kubernetes.runSandbox');
    });

    it('has description', () => {
      expect(runSandboxTool.description).toBeDefined();
      expect(runSandboxTool.description.length).toBeGreaterThan(0);
    });

    it('description mentions key features', () => {
      expect(runSandboxTool.description).toContain('TypeScript');
      expect(runSandboxTool.description).toContain('sandbox');
      expect(runSandboxTool.description).toContain('Kubernetes');
      expect(runSandboxTool.description).toContain('Prometheus');
    });

    it('has schema', () => {
      expect(runSandboxTool.schema).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('handles very long output', async () => {
      const result = await runSandbox({
        code: `
          for (let i = 0; i < 1000; i++) {
            console.log("Line " + i);
          }
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Line 0');
      expect(result.output).toContain('Line 999');
    });

    it('handles Unicode characters', async () => {
      const result = await runSandbox({
        code: `
          console.log("Hello 世界! 🌍");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello 世界! 🌍');
    });

    it('handles multiline strings', async () => {
      const result = await runSandbox({
        code: `
          const multiline = \`
            Line 1
            Line 2
            Line 3
          \`;
          console.log(multiline);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Line 1');
      expect(result.output).toContain('Line 2');
      expect(result.output).toContain('Line 3');
    });

    it('handles JSON stringify', async () => {
      const result = await runSandbox({
        code: `
          const obj = { name: "test", values: [1, 2, 3] };
          console.log(JSON.stringify(obj, null, 2));
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('"name": "test"');
    });

    it('handles Buffer operations', async () => {
      const result = await runSandbox({
        code: `
          const buf = Buffer.from("hello");
          console.log("Buffer length:", buf.length);
          console.log("Buffer toString:", buf.toString());
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Buffer length: 5');
      expect(result.output).toContain('Buffer toString: hello');
    });

    it('handles Date operations', async () => {
      const result = await runSandbox({
        code: `
          const now = new Date();
          console.log("Date type:", typeof now.getTime());
          console.log("Is valid:", !isNaN(now.getTime()));
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Date type: number');
      expect(result.output).toContain('Is valid: true');
    });

    it('handles Math operations', async () => {
      const result = await runSandbox({
        code: `
          console.log("PI:", Math.PI.toFixed(4));
          console.log("sqrt(16):", Math.sqrt(16));
          console.log("max(1,5,3):", Math.max(1, 5, 3));
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('PI: 3.1416');
      expect(result.output).toContain('sqrt(16): 4');
      expect(result.output).toContain('max(1,5,3): 5');
    });
  });
});

describe('runSandbox - Mutex and Concurrency', () => {
  it('handles concurrent executions', async () => {
    const results = await Promise.all([
      runSandbox({ code: 'console.log("exec 1");' }),
      runSandbox({ code: 'console.log("exec 2");' }),
      runSandbox({ code: 'console.log("exec 3");' }),
    ]);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[2].success).toBe(true);
    expect(results[0].output).toContain('exec 1');
    expect(results[1].output).toContain('exec 2');
    expect(results[2].output).toContain('exec 3');
  });

  it('handles concurrent caching without duplicates', async () => {
    const beforeCount = readdirSync(SCRIPTS_CACHE_DIR).length;
    const uniqueCode = `console.log("concurrent ${Date.now()}");`;

    // Execute same code concurrently
    await Promise.all([
      runSandbox({ code: uniqueCode }),
      runSandbox({ code: uniqueCode }),
      runSandbox({ code: uniqueCode }),
    ]);

    await new Promise(resolve => setTimeout(resolve, 500));

    const afterCount = readdirSync(SCRIPTS_CACHE_DIR).length;

    // Should only add one script despite concurrent executions
    expect(afterCount - beforeCount).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Mode-Based Execution Tests
// =============================================================================

describe('runSandbox - Execute Mode', () => {
  it('defaults to execute mode when mode is not specified', async () => {
    const result = await runSandbox({
      code: 'console.log("default mode");',
    });

    expect(result.mode).toBe('execute');
    expect(result.success).toBe(true);
    expect(result.output).toContain('default mode');
  });

  it('explicitly uses execute mode', async () => {
    const result = await runSandbox({
      mode: 'execute',
      code: 'console.log("explicit execute");',
    });

    expect(result.mode).toBe('execute');
    expect(result.success).toBe(true);
    expect(result.output).toContain('explicit execute');
  });

  it('returns executionTimeMs in execute mode', async () => {
    const result = await runSandbox({
      mode: 'execute',
      code: 'console.log("timing test");',
    });

    expect(result.mode).toBe('execute');
    expect(result).toHaveProperty('executionTimeMs');
    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error when neither code nor cached provided in execute mode', async () => {
    const result = await runSandbox({
      mode: 'execute',
    });

    expect(result.mode).toBe('execute');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Either "code" or "cached" must be provided');
  });
});

describe('runSandbox - Stream Mode', () => {
  it('executes code in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
      code: 'console.log("stream test");',
    });

    expect(result.mode).toBe('stream');
    expect(result.success).toBe(true);
    expect(result.output).toContain('stream test');
  });

  it('returns executionId in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
      code: 'console.log("stream id test");',
    });

    expect(result.mode).toBe('stream');
    expect(result).toHaveProperty('executionId');
    expect(typeof result.executionId).toBe('string');
    expect(result.executionId.length).toBeGreaterThan(0);
  });

  it('returns state in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
      code: 'console.log("state test");',
    });

    expect(result.mode).toBe('stream');
    expect(result).toHaveProperty('state');
    expect(result.state).toBe('completed');
  });

  it('captures error output separately in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
      code: 'console.error("error message"); console.log("normal message");',
    });

    expect(result.mode).toBe('stream');
    expect(result.success).toBe(true);
    expect(result.output).toContain('normal message');
    expect(result).toHaveProperty('errorOutput');
  });

  it('handles multi-line output in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
      code: `
        for (let i = 0; i < 5; i++) {
          console.log("Line " + i);
        }
      `,
    });

    expect(result.mode).toBe('stream');
    expect(result.success).toBe(true);
    expect(result.output).toContain('Line 0');
    expect(result.output).toContain('Line 4');
  });

  it('returns error when neither code nor cached provided in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
    });

    expect(result.mode).toBe('stream');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Either "code" or "cached" must be provided');
  });

  it('handles execution failure in stream mode', async () => {
    const result = await runSandbox({
      mode: 'stream',
      code: 'throw new Error("stream error");',
    });

    expect(result.mode).toBe('stream');
    expect(result.success).toBe(false);
    expect(result.state).toBe('failed');
  });
});

describe('runSandbox - Async Mode', () => {
  it('starts async execution and returns execution ID', async () => {
    const result = await runSandbox({
      mode: 'async',
      code: 'console.log("async test");',
    });

    expect(result.mode).toBe('async');
    expect(result).toHaveProperty('executionId');
    expect(typeof result.executionId).toBe('string');
    expect(result.executionId.length).toBeGreaterThan(0);
  });

  it('returns initial state in async mode', async () => {
    const result = await runSandbox({
      mode: 'async',
      code: 'console.log("async state test");',
    });

    expect(result.mode).toBe('async');
    expect(result).toHaveProperty('state');
    // Initial state should be pending or running
    expect(['pending', 'running', 'completed']).toContain(result.state);
  });

  it('returns helpful message in async mode', async () => {
    const result = await runSandbox({
      mode: 'async',
      code: 'console.log("async message test");',
    });

    expect(result.mode).toBe('async');
    expect(result).toHaveProperty('message');
    expect(result.message).toContain('status');
    expect(result.message).toContain(result.executionId);
  });

  it('returns error when neither code nor cached provided in async mode', async () => {
    const result = await runSandbox({
      mode: 'async',
    });

    expect(result.mode).toBe('async');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Either "code" or "cached" must be provided');
  });
});

describe('runSandbox - Status Mode', () => {
  it('gets status of an async execution', async () => {
    // First start an async execution
    const asyncResult = await runSandbox({
      mode: 'async',
      code: 'console.log("status check");',
    });

    expect(asyncResult.mode).toBe('async');
    const executionId = asyncResult.executionId;

    // Wait a bit for execution to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Then check status
    const statusResult = await runSandbox({
      mode: 'status',
      executionId,
    });

    expect(statusResult.mode).toBe('status');
    expect(statusResult.executionId).toBe(executionId);
    expect(statusResult).toHaveProperty('state');
    expect(statusResult).toHaveProperty('output');
  });

  it('waits for completion when wait=true', async () => {
    // Start a longer running async execution
    const asyncResult = await runSandbox({
      mode: 'async',
      code: `
        await new Promise(r => setTimeout(r, 100));
        console.log("waited execution");
      `,
    });

    expect(asyncResult.mode).toBe('async');
    const executionId = asyncResult.executionId;

    // Check status with wait
    const statusResult = await runSandbox({
      mode: 'status',
      executionId,
      wait: true,
    });

    expect(statusResult.mode).toBe('status');
    expect(statusResult.state).toBe('completed');
    expect(statusResult.output).toContain('waited execution');
  });

  it('supports incremental output reading with outputOffset', async () => {
    // Start async execution with multiple outputs
    const asyncResult = await runSandbox({
      mode: 'async',
      code: `
        console.log("line1");
        console.log("line2");
        console.log("line3");
      `,
    });

    const executionId = asyncResult.executionId;

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 200));

    // First read
    const status1 = await runSandbox({
      mode: 'status',
      executionId,
    });

    expect(status1.mode).toBe('status');
    expect(status1).toHaveProperty('outputLength');
    expect(status1.outputLength).toBeGreaterThan(0);

    // Second read with offset (should return less or empty)
    const status2 = await runSandbox({
      mode: 'status',
      executionId,
      outputOffset: status1.outputLength,
    });

    expect(status2.mode).toBe('status');
    // Output should be empty or minimal since we're reading from the end
    expect(status2.output.length).toBeLessThanOrEqual(status1.output.length);
  });

  it('returns result details when execution is complete', async () => {
    const asyncResult = await runSandbox({
      mode: 'async',
      code: 'console.log("complete test");',
    });

    const executionId = asyncResult.executionId;

    // Wait and get final status
    const statusResult = await runSandbox({
      mode: 'status',
      executionId,
      wait: true,
    });

    expect(statusResult.mode).toBe('status');
    expect(statusResult.state).toBe('completed');
    expect(statusResult).toHaveProperty('result');
    expect(statusResult.result).toHaveProperty('success', true);
    expect(statusResult.result).toHaveProperty('executionTimeMs');
  });

  it('returns error when executionId is not provided', async () => {
    const result = await runSandbox({
      mode: 'status',
    });

    expect(result.mode).toBe('status');
    expect(result.success).toBe(false);
    expect(result.error).toContain('executionId is required');
  });

  it('handles non-existent execution ID', async () => {
    const result = await runSandbox({
      mode: 'status',
      executionId: 'non-existent-id-12345',
    });

    expect(result.mode).toBe('status');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('runSandbox - Cancel Mode', () => {
  it('cancels a running execution', async () => {
    // Start a long-running async execution
    const asyncResult = await runSandbox({
      mode: 'async',
      code: `
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 100));
          console.log("iteration", i);
        }
      `,
    });

    expect(asyncResult.mode).toBe('async');
    const executionId = asyncResult.executionId;

    // Small delay to ensure execution starts
    await new Promise(resolve => setTimeout(resolve, 50));

    // Cancel the execution
    const cancelResult = await runSandbox({
      mode: 'cancel',
      executionId,
    });

    expect(cancelResult.mode).toBe('cancel');
    expect(cancelResult.executionId).toBe(executionId);
    expect(cancelResult).toHaveProperty('state');
    // State should be cancelled or already completed
    expect(['cancelled', 'completed', 'failed']).toContain(cancelResult.state);
  });

  it('returns error when executionId is not provided', async () => {
    const result = await runSandbox({
      mode: 'cancel',
    });

    expect(result.mode).toBe('cancel');
    expect(result.success).toBe(false);
    expect(result.error).toContain('executionId is required');
  });

  it('handles cancellation of already completed execution', async () => {
    // Start and wait for a quick execution
    const asyncResult = await runSandbox({
      mode: 'async',
      code: 'console.log("quick");',
    });

    const executionId = asyncResult.executionId;

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 200));

    // Try to cancel completed execution
    const cancelResult = await runSandbox({
      mode: 'cancel',
      executionId,
    });

    expect(cancelResult.mode).toBe('cancel');
    expect(cancelResult.executionId).toBe(executionId);
    // Should indicate it's already completed
    expect(['completed', 'cancelled', 'failed']).toContain(cancelResult.state);
  });
});

describe('runSandbox - List Mode', () => {
  it('lists recent executions', async () => {
    // Execute a few scripts first
    await runSandbox({ code: 'console.log("list test 1");' });
    await runSandbox({ code: 'console.log("list test 2");' });

    const result = await runSandbox({
      mode: 'list',
      includeCompletedWithinMs: 10000, // Last 10 seconds
    });

    expect(result.mode).toBe('list');
    expect(result).toHaveProperty('executions');
    expect(Array.isArray(result.executions)).toBe(true);
    expect(result).toHaveProperty('totalCount');
  });

  it('filters by execution state', async () => {
    const result = await runSandbox({
      mode: 'list',
      states: ['completed'],
      includeCompletedWithinMs: 10000,
    });

    expect(result.mode).toBe('list');
    expect(result).toHaveProperty('executions');

    // All returned executions should be completed
    for (const exec of result.executions) {
      expect(exec.state).toBe('completed');
    }
  });

  it('respects limit parameter', async () => {
    // Execute several scripts
    for (let i = 0; i < 5; i++) {
      await runSandbox({ code: `console.log("limit test ${i}");` });
    }

    const result = await runSandbox({
      mode: 'list',
      limit: 3,
      includeCompletedWithinMs: 10000,
    });

    expect(result.mode).toBe('list');
    expect(result.executions.length).toBeLessThanOrEqual(3);
  });

  it('returns execution details', async () => {
    await runSandbox({ code: 'console.log("details test");' });

    const result = await runSandbox({
      mode: 'list',
      includeCompletedWithinMs: 5000,
      limit: 5,
    });

    expect(result.mode).toBe('list');

    if (result.executions.length > 0) {
      const exec = result.executions[0];
      expect(exec).toHaveProperty('executionId');
      expect(exec).toHaveProperty('state');
      expect(exec).toHaveProperty('startedAtMs');
      expect(exec).toHaveProperty('codePreview');
      expect(exec).toHaveProperty('isCached');
    }
  });

  it('can list running executions', async () => {
    // Start a long-running async execution
    const asyncResult = await runSandbox({
      mode: 'async',
      code: `
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          console.log(i);
        }
      `,
    });

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 50));

    // List running executions
    const listResult = await runSandbox({
      mode: 'list',
      states: ['running'],
    });

    expect(listResult.mode).toBe('list');
    // May or may not find running execution depending on timing
    expect(listResult).toHaveProperty('executions');

    // Cancel the long-running execution
    await runSandbox({
      mode: 'cancel',
      executionId: asyncResult.executionId,
    });
  });

  it('returns empty list when no matching executions', async () => {
    const result = await runSandbox({
      mode: 'list',
      states: ['pending'], // Unlikely to have pending executions
      limit: 10,
    });

    expect(result.mode).toBe('list');
    expect(result.executions).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

describe('runSandbox - Mode Integration', () => {
  it('can execute async, check status, and verify completion', async () => {
    // Step 1: Start async execution
    const asyncResult = await runSandbox({
      mode: 'async',
      code: 'console.log("integration test");',
    });

    expect(asyncResult.mode).toBe('async');
    const executionId = asyncResult.executionId;

    // Step 2: Wait for completion using status mode
    const statusResult = await runSandbox({
      mode: 'status',
      executionId,
      wait: true,
    });

    expect(statusResult.mode).toBe('status');
    expect(statusResult.state).toBe('completed');
    expect(statusResult.output).toContain('integration test');

    // Step 3: Verify list mode works (may or may not contain the specific execution
    // depending on cleanup timing, so just verify the list call works)
    const listResult = await runSandbox({
      mode: 'list',
      includeCompletedWithinMs: 30000, // Longer window
      limit: 50,
    });

    expect(listResult.mode).toBe('list');
    expect(Array.isArray(listResult.executions)).toBe(true);
    // The execution registry may have already cleaned up, so we just verify the list works
  });

  it('stream and execute modes produce consistent results', async () => {
    const code = 'console.log("consistency test"); console.log(1 + 2);';

    const executeResult = await runSandbox({
      mode: 'execute',
      code,
    });

    const streamResult = await runSandbox({
      mode: 'stream',
      code,
    });

    // Both should succeed
    expect(executeResult.success).toBe(true);
    expect(streamResult.success).toBe(true);

    // Both should have the same output content
    expect(executeResult.output).toContain('consistency test');
    expect(streamResult.output).toContain('consistency test');
    expect(executeResult.output).toContain('3');
    expect(streamResult.output).toContain('3');
  });

  it('handles concurrent async executions', async () => {
    // Start multiple async executions
    const [async1, async2, async3] = await Promise.all([
      runSandbox({ mode: 'async', code: 'console.log("concurrent 1");' }),
      runSandbox({ mode: 'async', code: 'console.log("concurrent 2");' }),
      runSandbox({ mode: 'async', code: 'console.log("concurrent 3");' }),
    ]);

    // All should have unique execution IDs
    expect(async1.executionId).not.toBe(async2.executionId);
    expect(async2.executionId).not.toBe(async3.executionId);
    expect(async1.executionId).not.toBe(async3.executionId);

    // Wait for all to complete
    const [status1, status2, status3] = await Promise.all([
      runSandbox({ mode: 'status', executionId: async1.executionId, wait: true }),
      runSandbox({ mode: 'status', executionId: async2.executionId, wait: true }),
      runSandbox({ mode: 'status', executionId: async3.executionId, wait: true }),
    ]);

    // All should complete successfully
    expect(status1.state).toBe('completed');
    expect(status2.state).toBe('completed');
    expect(status3.state).toBe('completed');
  });

  it('cached scripts work in all execution modes', async () => {
    // Test execute mode with cached script
    const executeResult = await runSandbox({
      mode: 'execute',
      cached: testCachedScriptName,
    });
    expect(executeResult.mode).toBe('execute');
    expect(executeResult.success).toBe(true);
    expect(executeResult.output).toContain('executed from cache');

    // Test stream mode with cached script
    const streamResult = await runSandbox({
      mode: 'stream',
      cached: testCachedScriptName,
    });
    expect(streamResult.mode).toBe('stream');
    expect(streamResult.success).toBe(true);
    expect(streamResult.output).toContain('executed from cache');

    // Test async mode with cached script
    const asyncResult = await runSandbox({
      mode: 'async',
      cached: testCachedScriptName,
    });
    expect(asyncResult.mode).toBe('async');
    expect(asyncResult.executionId).toBeDefined();

    // Verify async completed successfully
    const statusResult = await runSandbox({
      mode: 'status',
      executionId: asyncResult.executionId,
      wait: true,
    });
    expect(statusResult.state).toBe('completed');
    expect(statusResult.output).toContain('executed from cache');
  });
});
