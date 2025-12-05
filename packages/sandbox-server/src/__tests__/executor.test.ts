import { describe, expect, it, beforeEach } from 'vitest';
import { Executor, type ExecutionResult, type ExecutorConfig } from '../server/executor.js';

describe('Executor', () => {
  let executor: Executor;

  beforeEach(() => {
    executor = new Executor();
  });

  describe('Basic Execution', () => {
    it('executes simple console.log', async () => {
      const result = await executor.execute('console.log("hello world")');

      expect(result.success).toBe(true);
      expect(result.output).toBe('hello world');
      expect(result.error).toBeUndefined();
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('executes multiple console.log statements', async () => {
      const result = await executor.execute(`
        console.log("line 1");
        console.log("line 2");
        console.log("line 3");
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('line 1\nline 2\nline 3');
    });

    it('handles console.error', async () => {
      const result = await executor.execute('console.error("error message")');

      expect(result.success).toBe(true);
      expect(result.output).toBe('[ERROR] error message');
    });

    it('handles console.warn', async () => {
      const result = await executor.execute('console.warn("warning message")');

      expect(result.success).toBe(true);
      expect(result.output).toBe('[WARN] warning message');
    });

    it('handles console.info', async () => {
      const result = await executor.execute('console.info("info message")');

      expect(result.success).toBe(true);
      expect(result.output).toBe('[INFO] info message');
    });

    it('handles mixed console output', async () => {
      const result = await executor.execute(`
        console.log("log");
        console.error("error");
        console.warn("warn");
        console.info("info");
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('log\n[ERROR] error\n[WARN] warn\n[INFO] info');
    });
  });

  describe('TypeScript Support', () => {
    it('executes TypeScript code with type annotations', async () => {
      const result = await executor.execute(`
        const x: number = 42;
        const y: string = "hello";
        console.log(x, y);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('42 hello');
    });

    it('executes TypeScript interfaces', async () => {
      const result = await executor.execute(`
        interface Person {
          name: string;
          age: number;
        }
        const person: Person = { name: "Alice", age: 30 };
        console.log(person.name, person.age);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Alice 30');
    });

    it('executes TypeScript generics', async () => {
      const result = await executor.execute(`
        function identity<T>(arg: T): T {
          return arg;
        }
        console.log(identity<string>("test"));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('test');
    });

    it('executes TypeScript enums', async () => {
      const result = await executor.execute(`
        enum Color { Red = 1, Green = 2, Blue = 3 }
        console.log(Color.Green);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('2');
    });
  });

  describe('Async/Await Support', () => {
    it('executes async code with await', async () => {
      const result = await executor.execute(`
        const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
        await delay(10);
        console.log("done");
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('done');
    });

    it('executes multiple awaits', async () => {
      const result = await executor.execute(`
        const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
        console.log("start");
        await delay(5);
        console.log("middle");
        await delay(5);
        console.log("end");
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('start\nmiddle\nend');
    });

    it('handles Promise.all', async () => {
      const result = await executor.execute(`
        const results = await Promise.all([
          Promise.resolve(1),
          Promise.resolve(2),
          Promise.resolve(3)
        ]);
        console.log(results.join(","));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('1,2,3');
    });
  });

  describe('Error Handling', () => {
    it('catches thrown errors', async () => {
      const result = await executor.execute('throw new Error("test error")');

      expect(result.success).toBe(false);
      expect(result.error).toBe('test error');
    });

    it('catches type errors', async () => {
      const result = await executor.execute(`
        const x: any = null;
        x.foo.bar;
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot read properties of null");
    });

    it('catches syntax errors during transform', async () => {
      const result = await executor.execute('const x = {');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('catches reference errors', async () => {
      const result = await executor.execute('console.log(undefinedVariable)');

      expect(result.success).toBe(false);
      expect(result.error).toContain('undefinedVariable');
    });

    it('catches async rejection errors', async () => {
      const result = await executor.execute(`
        await Promise.reject(new Error("async error"));
      `);

      expect(result.success).toBe(false);
      expect(result.error).toBe('async error');
    });

    it('preserves output before error', async () => {
      const result = await executor.execute(`
        console.log("before error");
        throw new Error("test error");
      `);

      expect(result.success).toBe(false);
      expect(result.output).toBe('before error');
      expect(result.error).toBe('test error');
    });
  });

  describe('Timeout Handling', () => {
    it('times out long-running code', async () => {
      const result = await executor.execute(`
        await new Promise(r => setTimeout(r, 5000));
      `, 100);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Script execution timed out');
    });

    it('clamps timeout to minimum 1000ms', async () => {
      const startTime = Date.now();
      const result = await executor.execute(`
        console.log("quick");
      `, 1);

      // Even with timeout=1, it should execute (clamped to 1000ms minimum)
      expect(result.success).toBe(true);
      expect(result.output).toBe('quick');
    });

    it('clamps timeout to maximum 120000ms', async () => {
      // Just verify it doesn't throw with a large timeout
      const result = await executor.execute('console.log("test")', 999999);
      expect(result.success).toBe(true);
    });

    it('uses default 30000ms timeout', async () => {
      const result = await executor.execute('console.log("test")');
      expect(result.success).toBe(true);
    });
  });

  describe('Sandbox Context - Built-in Objects', () => {
    it('provides JSON object', async () => {
      const result = await executor.execute(`
        const obj = { a: 1, b: 2 };
        console.log(JSON.stringify(obj));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('{"a":1,"b":2}');
    });

    it('provides Math object', async () => {
      const result = await executor.execute(`
        console.log(Math.max(1, 2, 3));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('3');
    });

    it('provides Date object', async () => {
      const result = await executor.execute(`
        const d = new Date(2024, 0, 1);
        console.log(d.getFullYear());
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('2024');
    });

    it('provides Array methods', async () => {
      const result = await executor.execute(`
        const arr = [1, 2, 3];
        console.log(arr.map(x => x * 2).join(","));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('2,4,6');
    });

    it('provides Object methods', async () => {
      const result = await executor.execute(`
        const obj = { a: 1, b: 2 };
        console.log(Object.keys(obj).join(","));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('a,b');
    });

    it('provides Buffer object', async () => {
      const result = await executor.execute(`
        const buf = Buffer.from("hello");
        console.log(buf.toString("base64"));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('aGVsbG8=');
    });

    it('provides Promise', async () => {
      const result = await executor.execute(`
        const p = new Promise(resolve => resolve(42));
        const value = await p;
        console.log(value);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('42');
    });
  });

  describe('Sandbox Context - Timers', () => {
    it('provides setTimeout', async () => {
      const result = await executor.execute(`
        await new Promise(r => setTimeout(() => {
          console.log("delayed");
          r(undefined);
        }, 10));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('delayed');
    });

    it('provides clearTimeout', async () => {
      const result = await executor.execute(`
        const id = setTimeout(() => console.log("should not run"), 1000);
        clearTimeout(id);
        console.log("cleared");
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('cleared');
    });

    it('provides setInterval and clearInterval', async () => {
      const result = await executor.execute(`
        let count = 0;
        const id = setInterval(() => {
          count++;
          if (count >= 3) {
            clearInterval(id);
          }
        }, 10);
        await new Promise(r => setTimeout(r, 100));
        console.log(count);
      `);

      expect(result.success).toBe(true);
      expect(parseInt(result.output)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Sandbox Context - Require', () => {
    it('allows require of @kubernetes/client-node', async () => {
      const result = await executor.execute(`
        const k8s = require('@kubernetes/client-node');
        console.log(typeof k8s.KubeConfig);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('allows require of prometheus-query', async () => {
      const result = await executor.execute(`
        const prom = require('prometheus-query');
        console.log(typeof prom.PrometheusDriver);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('blocks require of unauthorized modules', async () => {
      const result = await executor.execute(`
        const fs = require('fs');
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Module 'fs' not available in sandbox");
    });

    it('blocks require of child_process', async () => {
      const result = await executor.execute(`
        const cp = require('child_process');
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Module 'child_process' not available in sandbox");
    });
  });

  describe('Sandbox Context - Kubernetes', () => {
    it('provides pre-configured KubeConfig (kc)', async () => {
      const result = await executor.execute(`
        console.log(typeof kc);
        console.log(typeof kc.getCurrentContext);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('object\nfunction');
    });

    it('provides k8s library', async () => {
      const result = await executor.execute(`
        console.log(typeof k8s);
        console.log(typeof k8s.KubeConfig);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('object\nfunction');
    });

    it('can create API clients from kc', async () => {
      const result = await executor.execute(`
        const api = kc.makeApiClient(k8s.CoreV1Api);
        console.log(typeof api);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('object');
    });
  });

  describe('Sandbox Context - Environment', () => {
    it('provides access to process.env', async () => {
      const result = await executor.execute(`
        console.log(typeof process.env);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('object');
    });

    it('can read environment variables', async () => {
      const result = await executor.execute(`
        // PATH should always be defined
        console.log(typeof process.env.PATH);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('string');
    });
  });

  describe('Kubernetes Context', () => {
    it('returns current kubernetes context name', () => {
      const context = executor.getKubernetesContext();
      expect(typeof context).toBe('string');
      // Context should be either a valid name or 'unknown'
      expect(context.length).toBeGreaterThan(0);
    });
  });

  describe('Executor Configuration', () => {
    it('accepts prometheus URL in config', () => {
      const configuredExecutor = new Executor({
        prometheusUrl: 'http://localhost:9090'
      });
      expect(configuredExecutor).toBeInstanceOf(Executor);
    });

    it('uses PROMETHEUS_URL from environment', () => {
      const originalUrl = process.env.PROMETHEUS_URL;
      process.env.PROMETHEUS_URL = 'http://test:9090';

      const configuredExecutor = new Executor();
      expect(configuredExecutor).toBeInstanceOf(Executor);

      // Restore
      if (originalUrl) {
        process.env.PROMETHEUS_URL = originalUrl;
      } else {
        delete process.env.PROMETHEUS_URL;
      }
    });
  });

  describe('Execution Result Structure', () => {
    it('returns correct result structure on success', async () => {
      const result = await executor.execute('console.log("test")');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('executionTimeMs');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.output).toBe('string');
      expect(typeof result.executionTimeMs).toBe('number');
    });

    it('returns correct result structure on failure', async () => {
      const result = await executor.execute('throw new Error("test")');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('executionTimeMs');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.output).toBe('string');
      expect(typeof result.error).toBe('string');
      expect(typeof result.executionTimeMs).toBe('number');
    });

    it('tracks execution time', async () => {
      const result = await executor.execute(`
        await new Promise(r => setTimeout(r, 50));
        console.log("done");
      `);

      expect(result.success).toBe(true);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(40);
      expect(result.executionTimeMs).toBeLessThan(5000);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty code', async () => {
      const result = await executor.execute('');

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('handles code with only whitespace', async () => {
      const result = await executor.execute('   \n\t  ');

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('handles code with only comments', async () => {
      const result = await executor.execute('// just a comment');

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('handles Unicode output', async () => {
      const result = await executor.execute('console.log("Hello 世界 🌍")');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello 世界 🌍');
    });

    it('handles large output', async () => {
      const result = await executor.execute(`
        for (let i = 0; i < 100; i++) {
          console.log("line " + i);
        }
      `);

      expect(result.success).toBe(true);
      expect(result.output.split('\n').length).toBe(100);
    });

    it('handles complex nested objects in console.log', async () => {
      const result = await executor.execute(`
        const obj = { a: { b: { c: 1 } } };
        console.log(JSON.stringify(obj));
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('{"a":{"b":{"c":1}}}');
    });
  });
});
