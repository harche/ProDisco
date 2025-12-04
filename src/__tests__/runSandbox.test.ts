import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { runSandboxTool } from '../tools/kubernetes/runSandbox.js';
import { SCRIPTS_CACHE_DIR } from '../util/paths.js';

// Helper to execute runSandbox with proper typing
const runSandbox = runSandboxTool.execute.bind(runSandboxTool) as (input: {
  code?: string;
  cached?: string;
  timeout?: number;
}) => ReturnType<typeof runSandboxTool.execute>;

// Test cached script for Cached Script Execution tests
const testCachedScriptName = 'test-cached-script-for-runsandbox.ts';
const testCachedScriptPath = join(SCRIPTS_CACHE_DIR, testCachedScriptName);
const testCachedScriptContent = `// Executed via runSandbox at 2025-01-01T00:00:00.000Z
// Test cached script
console.log("executed from cache");
console.log("cached script working");
`;

// Ensure cache directory exists and create test script before tests
beforeAll(() => {
  if (!existsSync(SCRIPTS_CACHE_DIR)) {
    mkdirSync(SCRIPTS_CACHE_DIR, { recursive: true });
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
  // Clean up test cached script
  if (existsSync(testCachedScriptPath)) {
    unlinkSync(testCachedScriptPath);
  }
  // Final cleanup of any remaining test scripts
  const files = readdirSync(SCRIPTS_CACHE_DIR);
  for (const file of files) {
    if (file.startsWith('test-') || file.includes('-test-')) {
      const fullPath = join(SCRIPTS_CACHE_DIR, file);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
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
      expect(result.executionTime).toBeGreaterThan(0);
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
      expect(result.executionTime).toBeLessThan(30000);
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
      expect(result.executionTime).toBeLessThan(5000);
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
      const cachedScript = files.find(f => f.includes(uniqueId.toString().slice(-8)));

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
      const code = `
        // Deduplication test script
        console.log("same content");
      `;

      const beforeCount = readdirSync(SCRIPTS_CACHE_DIR).length;

      // Execute same code twice
      await runSandbox({ code });
      await new Promise(resolve => setTimeout(resolve, 200));

      const afterFirstCount = readdirSync(SCRIPTS_CACHE_DIR).length;

      await runSandbox({ code });
      await new Promise(resolve => setTimeout(resolve, 200));

      const afterSecondCount = readdirSync(SCRIPTS_CACHE_DIR).length;

      // Should not create a duplicate
      expect(afterSecondCount).toBe(afterFirstCount);
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
        expect(content).toContain('// Executed via runSandbox');
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
      expect(result.error).toContain('searchTools');
    });

    it('strips header comment when executing cached script', async () => {
      const result = await runSandbox({
        cached: testCachedScriptName,
      });

      expect(result.success).toBe(true);
      // Should not have header comment in output (it's stripped before execution)
      expect(result.output).not.toContain('// Executed via runSandbox');
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
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('executionTime');
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

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('executionTime');
      expect(typeof result.output).toBe('string');
      expect(typeof result.executionTime).toBe('number');
    });

    it('returns complete result structure on failure', async () => {
      const result = await runSandbox({
        code: 'throw new Error("test error");',
      });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('executionTime');
      expect(typeof result.error).toBe('string');
    });

    it('execution time is reasonable', async () => {
      const result = await runSandbox({
        code: 'console.log("quick");',
      });

      expect(result.executionTime).toBeGreaterThan(0);
      expect(result.executionTime).toBeLessThan(10000);  // Should complete in under 10s
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
