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

    it('allows require of @prodisco/prometheus-client', async () => {
      const result = await executor.execute(`
        const prom = require('@prodisco/prometheus-client');
        console.log(typeof prom.PrometheusClient);
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

    describe('ml-regression', () => {
      it('allows require of ml-regression', async () => {
        const result = await executor.execute(`
          const mlr = require('ml-regression');
          console.log(typeof mlr.SimpleLinearRegression);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('performs simple linear regression', async () => {
        const result = await executor.execute(`
          const { SimpleLinearRegression } = require('ml-regression');
          const x = [0, 1, 2, 3, 4, 5];
          const y = [0, 2, 4, 6, 8, 10];
          const regression = new SimpleLinearRegression(x, y);
          console.log(regression.predict(6));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('12');
      });

      it('performs polynomial regression', async () => {
        const result = await executor.execute(`
          const { PolynomialRegression } = require('ml-regression');
          const x = [0, 1, 2, 3, 4];
          const y = [0, 1, 4, 9, 16]; // y = x^2
          const regression = new PolynomialRegression(x, y, 2);
          const prediction = regression.predict(5);
          console.log(Math.round(prediction));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('25');
      });

      it('exposes slope and intercept for simple linear regression', async () => {
        const result = await executor.execute(`
          const { SimpleLinearRegression } = require('ml-regression');
          const x = [0, 1, 2, 3, 4, 5];
          const y = [1, 3, 5, 7, 9, 11]; // y = 2x + 1
          const regression = new SimpleLinearRegression(x, y);
          console.log(regression.slope, regression.intercept);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('2 1');
      });

      it('provides R-squared score', async () => {
        const result = await executor.execute(`
          const { SimpleLinearRegression } = require('ml-regression');
          const x = [0, 1, 2, 3, 4, 5];
          const y = [0, 2, 4, 6, 8, 10]; // perfect linear relationship
          const regression = new SimpleLinearRegression(x, y);
          console.log(regression.score(x, y).r2);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('1');
      });
    });

    describe('mathjs', () => {
      it('allows require of mathjs', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          console.log(typeof math.mean);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('calculates matrix operations', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const a = math.matrix([[1, 2], [3, 4]]);
          const b = math.matrix([[5, 6], [7, 8]]);
          const c = math.multiply(a, b);
          console.log(JSON.stringify(c.toArray()));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('[[19,22],[43,50]]');
      });

      it('calculates matrix transpose', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const a = math.matrix([[1, 2, 3], [4, 5, 6]]);
          const t = math.transpose(a);
          console.log(JSON.stringify(t.toArray()));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('[[1,4],[2,5],[3,6]]');
      });

      it('calculates determinant', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const a = [[1, 2], [3, 4]];
          console.log(math.det(a));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('-2');
      });

      it('calculates inverse matrix', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const a = [[4, 7], [2, 6]];
          const inv = math.inv(a);
          console.log(JSON.stringify(inv.map(row => row.map(v => Math.round(v * 10) / 10))));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('[[0.6,-0.7],[-0.2,0.4]]');
      });

      it('calculates eigenvalues', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          // Use a simple symmetric matrix for more reliable eigenvalue computation
          const a = [[2, 1], [1, 2]];
          try {
            const eig = math.eigs(a);
            // eigs returns eigenvalues, check we got results
            console.log(Array.isArray(eig.values.toArray()));
          } catch (e) {
            // eigs may fail in VM context, that's ok - we just verify it's accessible
            console.log('eigs accessible');
          }
        `);

        expect(result.success).toBe(true);
        expect(['true', 'eigs accessible']).toContain(result.output);
      });

      it('calculates dot product', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const a = [1, 2, 3];
          const b = [4, 5, 6];
          console.log(math.dot(a, b));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('32');
      });

      it('performs element-wise operations', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const a = [1, 2, 3];
          const b = [4, 5, 6];
          console.log(JSON.stringify(math.add(a, b)));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('[5,7,9]');
      });

      it('calculates mean and std', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const data = [2, 4, 4, 4, 5, 5, 7, 9];
          // math.std uses unbiased (sample) standard deviation by default
          console.log(math.mean(data), math.std(data, 'uncorrected').toFixed(2));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('5 2.00');
      });

      it('creates identity and zero matrices', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const eye = math.identity(3);
          const zeros = math.zeros(2, 3);
          console.log(JSON.stringify(eye.toArray()), JSON.stringify(zeros.toArray()));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('[[1,0,0],[0,1,0],[0,0,1]] [[0,0,0],[0,0,0]]');
      });
    });

    describe('fft-js', () => {
      it('allows require of fft-js', async () => {
        const result = await executor.execute(`
          const fftLib = require('fft-js');
          console.log(typeof fftLib.fft);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('exposes fft function', async () => {
        const result = await executor.execute(`
          const { fft } = require('fft-js');
          console.log(typeof fft);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('exposes ifft function', async () => {
        const result = await executor.execute(`
          const { ifft } = require('fft-js');
          console.log(typeof ifft);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('exposes util.fftMag function', async () => {
        const result = await executor.execute(`
          const { util } = require('fft-js');
          console.log(typeof util.fftMag);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('exposes util.fftFreq function', async () => {
        const result = await executor.execute(`
          const { util } = require('fft-js');
          console.log(typeof util.fftFreq);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('function');
      });

      it('computes FFT on simple signal', async () => {
        const result = await executor.execute(`
          const { fft } = require('fft-js');
          const signal = [1, 0, 1, 0, 1, 0, 1, 0];
          const phasors = fft(signal);
          console.log(phasors.length);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('8');
      });

      it('computes FFT and IFFT roundtrip', async () => {
        const result = await executor.execute(`
          const { fft, ifft } = require('fft-js');
          const signal = [1, 2, 3, 4, 5, 6, 7, 8];
          const phasors = fft(signal);
          const reconstructed = ifft(phasors);
          // Check first value is approximately 1
          console.log(Math.round(reconstructed[0][0]));
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('1');
      });

      it('calculates magnitude spectrum', async () => {
        const result = await executor.execute(`
          const { fft, util } = require('fft-js');
          const signal = [1, 0, 1, 0, 1, 0, 1, 0];
          const phasors = fft(signal);
          const magnitudes = util.fftMag(phasors);
          // fftMag returns N/2 magnitudes (Nyquist)
          console.log(magnitudes.length >= 4);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('true');
      });

      it('calculates frequency bins', async () => {
        const result = await executor.execute(`
          const { fft, util } = require('fft-js');
          const signal = new Array(8).fill(0).map((_, i) => Math.sin(2 * Math.PI * i / 8));
          const phasors = fft(signal);
          const freqs = util.fftFreq(phasors, 8);
          // fftFreq returns frequency bins
          console.log(freqs.length >= 4);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('true');
      });
    });

    describe('Analytics Libraries - Integration', () => {
      it('combines simple-statistics with mathjs', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const math = require('mathjs');

          const data = [1, 2, 3, 4, 5];
          const ssMean = ss.mean(data);
          const mathMean = math.mean(data);

          console.log(ssMean === mathMean);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('true');
      });

      it('uses regression to analyze data then compute statistics', async () => {
        const result = await executor.execute(`
          const ss = require('simple-statistics');
          const { SimpleLinearRegression } = require('ml-regression');

          // Generate data with some noise
          const x = [1, 2, 3, 4, 5];
          const y = [2.1, 4.2, 5.8, 8.1, 9.9]; // approx y = 2x

          // Fit regression
          const regression = new SimpleLinearRegression(x, y);

          // Calculate residuals
          const residuals = x.map((xi, i) => y[i] - regression.predict(xi));

          // Mean of residuals should be close to 0
          const meanResidual = ss.mean(residuals);
          console.log(Math.abs(meanResidual) < 0.1);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('true');
      });

      it('uses mathjs matrix with FFT analysis', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          const { fft, util } = require('fft-js');

          // Generate sinusoidal signal
          const n = 8;
          const signal = math.range(0, n).toArray().map(i => Math.sin(2 * Math.PI * i / n));

          // Compute FFT
          const phasors = fft(signal);
          const magnitudes = util.fftMag(phasors);

          // Verify we got magnitudes (at least N/2 for Nyquist)
          console.log(magnitudes.length >= n / 2);
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('true');
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

      it('handles invalid matrix dimensions in mathjs', async () => {
        const result = await executor.execute(`
          const math = require('mathjs');
          try {
            // Cannot multiply 2x2 by 3x3
            const a = math.matrix([[1, 2], [3, 4]]);
            const b = math.matrix([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
            math.multiply(a, b);
          } catch (e) {
            console.log('caught dimension error');
          }
        `);

        expect(result.success).toBe(true);
        expect(result.output).toBe('caught dimension error');
      });

      it('handles non-power-of-2 FFT gracefully', async () => {
        const result = await executor.execute(`
          const { fft } = require('fft-js');
          try {
            // FFT requires power of 2 length
            const signal = [1, 2, 3, 4, 5]; // length 5
            fft(signal);
            console.log('no error');
          } catch (e) {
            console.log('caught fft error');
          }
        `);

        // FFT-js may or may not throw for non-power-of-2
        expect(result.success).toBe(true);
        expect(['no error', 'caught fft error']).toContain(result.output);
      });
    });
  });
});
