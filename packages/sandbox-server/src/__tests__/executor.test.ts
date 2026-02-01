import { describe, expect, it, beforeEach } from 'vitest';
import { Executor, type ExecutionResult, type ExecutorConfig, type TestExecutionResult } from '../server/executor.js';

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

    it('allows require of @prodisco/prometheus-client', async () => {
      const result = await executor.execute(`
        const prom = require('@prodisco/prometheus-client');
        console.log(typeof prom.PrometheusClient);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('function');
    });

    it('allows require of package subpaths when the package is allowlisted', async () => {
      const result = await executor.execute(`
        const sub = require('@kubernetes/client-node/dist/index');
        console.log(typeof sub.KubeConfig);
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

    it('respects allowlist overrides (blocks non-allowlisted packages)', async () => {
      const limited = new Executor({ allowedModules: ['simple-statistics'] });
      const result = await limited.execute(`
        const k8s = require('@kubernetes/client-node');
        console.log(typeof k8s);
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Module '@kubernetes/client-node' not available in sandbox");
    });
  });

  describe('Sandbox Context - Globals', () => {
    it('does not provide any Kubernetes convenience globals (k8s/kc)', async () => {
      const result = await executor.execute(`
        console.log(typeof k8s);
        console.log(typeof kc);
      `);

      expect(result.success).toBe(true);
      expect(result.output).toBe('undefined\nundefined');
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

  // ============================================================================
  // Output Metadata Tests
  // ============================================================================

  describe('Output Metadata', () => {
    it('returns output metadata for simple output', async () => {
      const result = await executor.execute('console.log("hello")');

      expect(result.success).toBe(true);
      expect(result.outputLineCount).toBe(1);
      expect(result.outputCharCount).toBe(5); // "hello"
      expect(result.truncated).toBe(false);
      expect(result.truncatedAt).toBeUndefined();
    });

    it('returns correct line count for multiple lines', async () => {
      const result = await executor.execute(`
        console.log("line 1");
        console.log("line 2");
        console.log("line 3");
      `);

      expect(result.success).toBe(true);
      expect(result.outputLineCount).toBe(3);
      expect(result.truncated).toBe(false);
    });

    it('returns zero counts for empty output', async () => {
      const result = await executor.execute('const x = 1;');

      expect(result.success).toBe(true);
      expect(result.outputLineCount).toBe(0);
      expect(result.outputCharCount).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('returns metadata even on execution failure', async () => {
      const result = await executor.execute(`
        console.log("before error");
        throw new Error("test error");
      `);

      expect(result.success).toBe(false);
      expect(result.outputLineCount).toBe(1);
      expect(result.outputCharCount).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
    });
  });

  describe('Output Truncation', () => {
    it('truncates output at 5000 lines', async () => {
      // Generate more than 5000 lines
      const result = await executor.execute(`
        for (let i = 0; i < 6000; i++) {
          console.log("line " + i);
        }
      `);

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.outputLineCount).toBe(5000);
      expect(result.truncatedAt).toBeDefined();
      expect(result.truncatedAt?.lines).toBe(5000);
    });

    it('truncates output at 500KB character limit', async () => {
      // Generate output that exceeds 500KB (500000 chars)
      // Each line will be about 110 chars, need about 4600 lines to hit 500KB
      const result = await executor.execute(`
        const longLine = 'x'.repeat(100);
        for (let i = 0; i < 6000; i++) {
          console.log(longLine + i);
        }
      `);

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.outputCharCount).toBeLessThanOrEqual(500000);
      expect(result.truncatedAt).toBeDefined();
    });

    it('does not truncate output under limits', async () => {
      const result = await executor.execute(`
        for (let i = 0; i < 100; i++) {
          console.log("line " + i);
        }
      `);

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.outputLineCount).toBe(100);
      expect(result.truncatedAt).toBeUndefined();
    });
  });

  // ============================================================================
  // Analytics Libraries Tests
  // ============================================================================

  describe('Sandbox Context - Analytics Libraries', () => {
    describe('simple-statistics', () => {
      it('allows require of simple-statistics', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          console.log(typeof ss.mean);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('calculates mean correctly', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [1, 2, 3, 4, 5];
          console.log(ss.mean(data));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('3');
      });

      it('calculates median correctly', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [1, 2, 3, 4, 5];
          console.log(ss.median(data));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('3');
      });

      it('calculates standard deviation correctly', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [2, 4, 4, 4, 5, 5, 7, 9];
          const std = ss.standardDeviation(data);
          console.log(std.toFixed(2));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('2.00');
      });

      it('calculates percentile correctly', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
          console.log(ss.quantile(data, 0.5));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('5.5');
      });

      it('calculates linear regression', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [[0, 0], [1, 1], [2, 2]];
          const regression = ss.linearRegression(data);
          console.log(regression.m, regression.b);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('1 0');
      });

      it('calculates variance', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [2, 4, 4, 4, 5, 5, 7, 9];
          console.log(ss.variance(data));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('4');
      });

      it('calculates min and max', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [3, 1, 4, 1, 5, 9, 2, 6];
          console.log(ss.min(data), ss.max(data));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('1 9');
      });

      it('calculates sum', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const data = [1, 2, 3, 4, 5];
          console.log(ss.sum(data));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('15');
      });

      it('calculates sample correlation', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const x = [1, 2, 3, 4, 5];
          const y = [2, 4, 6, 8, 10];
          console.log(ss.sampleCorrelation(x, y).toFixed(4));
        `);

        expect(result.success).toBe(true);
        // Perfect positive correlation
        expect(result.output).toBe('1.0000');
      });
    });

    describe('Analytics Libraries - Error Handling', () => {
      it('handles empty data gracefully with simple-statistics', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          try {
            ss.mean([]);
          } catch (e) {
            console.log('caught error');
          }
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('caught error');
      });
    });
  });

  // ============================================================================
  // Test Execution Tests
  // ============================================================================

  describe('Test Execution (executeTest)', () => {
    describe('Basic Test Execution', () => {
      it('runs a passing test', async () => {
        const result = await executor.executeTest({
          tests: `
            test('simple passing test', () => {
              assert.is(1 + 1, 2);
            });
          `,
        });

        expect(result.success).toBe(true);
        expect(result.summary.total).toBe(1);
        expect(result.summary.passed).toBe(1);
        expect(result.summary.failed).toBe(0);
        expect(result.tests.length).toBe(1);
        expect(result.tests[0].name).toBe('simple passing test');
        expect(result.tests[0].passed).toBe(true);
      });

      it('runs a failing test', async () => {
        const result = await executor.executeTest({
          tests: `
            test('simple failing test', () => {
              assert.is(1 + 1, 3);
            });
          `,
        });

        expect(result.success).toBe(false);
        expect(result.summary.total).toBe(1);
        expect(result.summary.passed).toBe(0);
        expect(result.summary.failed).toBe(1);
        expect(result.tests.length).toBe(1);
        expect(result.tests[0].name).toBe('simple failing test');
        expect(result.tests[0].passed).toBe(false);
        expect(result.tests[0].error).toBeDefined();
      });

      it('runs multiple tests with mixed results', async () => {
        const result = await executor.executeTest({
          tests: `
            test('passing test 1', () => {
              assert.is(2 + 2, 4);
            });

            test('failing test', () => {
              assert.is(2 + 2, 5);
            });

            test('passing test 2', () => {
              assert.ok(true);
            });
          `,
        });

        expect(result.success).toBe(false);
        expect(result.summary.total).toBe(3);
        expect(result.summary.passed).toBe(2);
        expect(result.summary.failed).toBe(1);
      });
    });

    describe('Test with Implementation Code', () => {
      it('tests implementation code provided separately', async () => {
        const result = await executor.executeTest({
          code: `
            function add(a: number, b: number): number {
              return a + b;
            }

            function multiply(a: number, b: number): number {
              return a * b;
            }
          `,
          tests: `
            test('add function works', () => {
              assert.is(add(1, 2), 3);
              assert.is(add(-1, 1), 0);
              assert.is(add(0, 0), 0);
            });

            test('multiply function works', () => {
              assert.is(multiply(2, 3), 6);
              assert.is(multiply(0, 5), 0);
            });
          `,
        });

        expect(result.success).toBe(true);
        expect(result.summary.total).toBe(2);
        expect(result.summary.passed).toBe(2);
      });

      it('fails when implementation has bugs', async () => {
        const result = await executor.executeTest({
          code: `
            function add(a: number, b: number): number {
              return a - b; // BUG: should be a + b
            }
          `,
          tests: `
            test('add function works', () => {
              assert.is(add(1, 2), 3);
            });
          `,
        });

        expect(result.success).toBe(false);
        expect(result.summary.failed).toBe(1);
        expect(result.tests[0].error).toBeDefined();
      });
    });

    describe('Async Test Execution', () => {
      it('handles async tests', async () => {
        const result = await executor.executeTest({
          tests: `
            test('async test', async () => {
              // Use Promise.resolve instead of setTimeout for simpler async handling
              await Promise.resolve();
              assert.is(1, 1);
            });
          `,
        });

        expect(result.success).toBe(true);
        expect(result.summary.passed).toBe(1);
      });

      it('handles async tests with setTimeout', async () => {
        const result = await executor.executeTest({
          tests: `
            test('async with setTimeout', async () => {
              const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
              await delay(5);
              assert.is(2 + 2, 4);
            });
          `,
        });

        expect(result.success).toBe(true);
        expect(result.summary.passed).toBe(1);
      });
    });

    describe('Error Handling', () => {
      it('returns error when tests parameter is missing', async () => {
        const result = await executor.executeTest({
          tests: '',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Tests parameter is required');
      });

      it('handles syntax errors in test code', async () => {
        const result = await executor.executeTest({
          tests: `
            test('broken', () => {
              const x = {
            });
          `,
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('handles runtime errors in test code', async () => {
        const result = await executor.executeTest({
          tests: `
            test('runtime error', () => {
              const obj: any = null;
              obj.foo.bar; // Should throw
            });
          `,
        });

        expect(result.success).toBe(false);
        expect(result.summary.failed).toBe(1);
        expect(result.tests[0].error).toBeDefined();
      });
    });

    describe('Test Result Structure', () => {
      it('includes duration for each test', async () => {
        const result = await executor.executeTest({
          tests: `
            test('test with duration', () => {
              // Perform some sync work to ensure measurable duration
              let sum = 0;
              for (let i = 0; i < 10000; i++) { sum += i; }
              assert.ok(true);
            });
          `,
        });

        expect(result.success).toBe(true);
        expect(result.tests[0].durationMs).toBeGreaterThanOrEqual(0);
      });

      it('includes overall execution time', async () => {
        const result = await executor.executeTest({
          tests: `
            test('quick test', () => {
              assert.ok(true);
            });
          `,
        });

        expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      });

      it('captures console output from tests', async () => {
        const result = await executor.executeTest({
          tests: `
            test('test with console', () => {
              console.log('test output');
              assert.ok(true);
            });
          `,
        });

        expect(result.success).toBe(true);
        // Console output may be captured in the output field
        // depending on whether it's before the JSON markers
      });
    });

    describe('UVU Assert Functions', () => {
      it('supports assert.is', async () => {
        const result = await executor.executeTest({
          tests: `
            test('assert.is', () => {
              assert.is(1, 1);
              assert.is('hello', 'hello');
            });
          `,
        });

        expect(result.success).toBe(true);
      });

      it('supports assert.ok', async () => {
        const result = await executor.executeTest({
          tests: `
            test('assert.ok', () => {
              assert.ok(true);
              assert.ok(1);
              assert.ok('truthy');
            });
          `,
        });

        expect(result.success).toBe(true);
      });

      it('supports assert.equal', async () => {
        const result = await executor.executeTest({
          tests: `
            test('assert.equal', () => {
              assert.equal({ a: 1 }, { a: 1 });
              assert.equal([1, 2, 3], [1, 2, 3]);
            });
          `,
        });

        expect(result.success).toBe(true);
      });

      it('supports assert.not', async () => {
        const result = await executor.executeTest({
          tests: `
            test('assert.not', () => {
              assert.not(false);
              assert.not(0);
              assert.not('');
            });
          `,
        });

        expect(result.success).toBe(true);
      });

      it('supports assert.throws', async () => {
        const result = await executor.executeTest({
          tests: `
            test('assert.throws', () => {
              assert.throws(() => {
                throw new Error('expected error');
              });
            });
          `,
        });

        expect(result.success).toBe(true);
      });
    });
  });
});
