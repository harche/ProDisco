#!/usr/bin/env npx tsx
/**
 * Integration tests for the containerized sandbox-server.
 * Run with: npx tsx scripts/integration/container-tests.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxClient } from '../../packages/sandbox-server/dist/client/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

async function runTests(): Promise<void> {
  const port = parseInt(process.env.SANDBOX_PORT || '50052', 10);
  const host = process.env.SANDBOX_HOST || 'localhost';

  console.log(`Connecting to sandbox server at ${host}:${port}...\n`);

  const client = new SandboxClient({
    useTcp: true,
    tcpHost: host,
    tcpPort: port,
  });

  // Wait for server to be ready
  const healthy = await client.waitForHealthy(10000);
  if (!healthy) {
    console.error('ERROR: Server not healthy after 10 seconds');
    process.exit(1);
  }

  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => Promise<void>): TestCase {
    return { name, fn };
  }

  const tests: TestCase[] = [
    test('Health check returns healthy', async () => {
      const health = await client.healthCheck();
      if (!health.healthy) throw new Error('Server not healthy');
    }),

    test('Execute simple code', async () => {
      const result = await client.execute({
        code: 'console.log("test");',
        timeoutMs: 5000,
      });
      if (!result.success) throw new Error('Execution failed: ' + result.error);
      if (!result.output.includes('test')) throw new Error('Output mismatch');
    }),

    test('Execute TypeScript code', async () => {
      const result = await client.execute({
        code: 'const x: number = 42; console.log(x);',
        timeoutMs: 5000,
      });
      if (!result.success) throw new Error('Execution failed: ' + result.error);
      if (!result.output.includes('42')) throw new Error('Output mismatch');
    }),

    test('Kubernetes API access - list namespaces', async () => {
      const result = await client.execute({
        code: `
          const k8s = require('@kubernetes/client-node');
          const kc = new k8s.KubeConfig();
          kc.loadFromCluster();

          const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
          const res = await coreV1Api.listNamespace();
          const items = (res && res.body && res.body.items) ? res.body.items : (res.items || []);
          console.log('Namespace count:', items.length);
          console.log('Has prodisco:', items.some(ns => ns.metadata?.name === 'prodisco'));
        `,
        timeoutMs: 10000,
      });
      if (!result.success) throw new Error('Execution failed: ' + result.error);
      if (!result.output.includes('Has prodisco: true')) {
        throw new Error('Expected to find prodisco namespace. Output: ' + result.output);
      }
    }),

    test('Kubernetes API access - list pods in prodisco', async () => {
      const result = await client.execute({
        code: `
          const k8s = require('@kubernetes/client-node');
          const kc = new k8s.KubeConfig();
          kc.loadFromCluster();

          const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
          const res = await coreV1Api.listNamespacedPod({ namespace: 'prodisco' });
          const items = (res && res.body && res.body.items) ? res.body.items : (res.items || []);
          console.log('Pod count:', items.length);
          const sandboxPod = items.find(p => p.metadata?.name?.includes('sandbox-server'));
          console.log('Sandbox pod found:', !!sandboxPod);
          console.log('Sandbox pod status:', sandboxPod?.status?.phase);
        `,
        timeoutMs: 10000,
      });
      if (!result.success) throw new Error('Execution failed: ' + result.error);
      if (!result.output.includes('Sandbox pod found: true')) {
        throw new Error('Expected to find sandbox-server pod. Output: ' + result.output);
      }
    }),

    test('Script caching works', async () => {
      const scriptName = `cache-test-${Date.now()}`;
      const result = await client.execute({
        code: '// Cache test script\nconsole.log("cached!");',
        scriptName,
        timeoutMs: 5000,
      });
      if (!result.success) throw new Error('Execution failed: ' + result.error);
      if (!result.cached) throw new Error('Script was not cached');
      if (!result.cached.name) throw new Error('Cached entry missing name');
      if (result.cached.name !== `${scriptName}.ts`) {
        throw new Error(`Expected cached name "${scriptName}.ts", got "${result.cached.name}"`);
      }
    }),

    test('Error handling - syntax error', async () => {
      const result = await client.execute({
        code: 'const x = {;',
        timeoutMs: 5000,
      });
      if (result.success) throw new Error('Expected failure for syntax error');
      if (!result.error) throw new Error('Expected error message');
    }),

    test('Timeout handling', async () => {
      // This test verifies that infinite loops are handled.
      // The execution should either:
      // 1. Return with success=false (timeout handled gracefully)
      // 2. Throw a gRPC error (connection dropped due to timeout)
      // Both are acceptable - what matters is that it doesn't succeed.
      try {
        const result = await client.execute({
          code: 'while(true) {}',
          timeoutMs: 1000,
        });
        if (result.success) throw new Error('Expected timeout failure');
        // Got a failed result - this is correct behavior
      } catch (error) {
        // Connection dropped due to timeout - also acceptable
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('UNAVAILABLE') || message.includes('timeout') || message.includes('deadline')) {
          // This is expected behavior for a timeout
          return;
        }
        throw error;
      }
    }),

    test('MCP server uses TCP mode when configured', async () => {
      // This test verifies the MCP server correctly identifies TCP mode from env vars
      // and attempts to connect to remote sandbox instead of spawning a subprocess.
      // We run the server briefly and check the log messages.
      const serverPath = path.resolve(__dirname, '../../dist/server.js');

      const serverProcess: ChildProcess = spawn('node', [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SANDBOX_USE_TCP: 'true',
          SANDBOX_TCP_HOST: host,
          SANDBOX_TCP_PORT: String(port),
        },
      });

      let stderr = '';

      serverProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Wait for the initial log messages (give it 5 seconds to start)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          serverProcess.kill('SIGTERM');
          resolve();
        }, 5000);

        // Resolve early if we see the connection message
        const checkOutput = () => {
          if (stderr.includes('Connecting to remote sandbox server')) {
            clearTimeout(timeout);
            // Give it a moment then kill
            setTimeout(() => {
              serverProcess.kill('SIGTERM');
              resolve();
            }, 500);
          }
        };

        serverProcess.stderr?.on('data', checkOutput);
      });

      // The key assertions:
      // 1. Server should log that it's connecting to remote sandbox (TCP mode)
      if (!stderr.includes(`Connecting to remote sandbox server at ${host}:${port}`)) {
        throw new Error(`Expected TCP connection log. Got: ${stderr}`);
      }

      // 2. Server should NOT log subprocess spawn (local mode)
      if (stderr.includes('Starting sandbox gRPC server...')) {
        throw new Error('Should NOT spawn local subprocess in TCP mode');
      }
    }),
  ];

  console.log(`Running ${tests.length} tests...\n`);

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  \u2713 ' + name);
      passed++;
      results.push({ name, passed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log('  \u2717 ' + name + ': ' + message);
      failed++;
      results.push({ name, passed: false, error: message });
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);

  client.close();

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
