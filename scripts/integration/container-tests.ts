#!/usr/bin/env npx tsx
/**
 * Integration tests for the containerized sandbox-server.
 * Run with: npx tsx scripts/integration/container-tests.ts
 */

import { SandboxClient } from '../../packages/sandbox-server/dist/client/index.js';

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
      if (health.kubernetesContext !== 'inClusterContext') {
        throw new Error('Expected inClusterContext, got: ' + health.kubernetesContext);
      }
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
          const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
          const namespaces = await coreV1Api.listNamespace();
          console.log('Namespace count:', namespaces.items.length);
          console.log('Has prodisco:', namespaces.items.some(ns => ns.metadata?.name === 'prodisco'));
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
          const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
          const pods = await coreV1Api.listNamespacedPod({ namespace: 'prodisco' });
          console.log('Pod count:', pods.items.length);
          const sandboxPod = pods.items.find(p => p.metadata?.name?.includes('sandbox-server'));
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
      const result = await client.execute({
        code: '// Cache test script\nconsole.log("cached!");',
        timeoutMs: 5000,
      });
      if (!result.success) throw new Error('Execution failed: ' + result.error);
      if (!result.cachedAs) throw new Error('Script was not cached');
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
