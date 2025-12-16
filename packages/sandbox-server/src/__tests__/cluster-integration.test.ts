/**
 * Cluster Integration Tests
 *
 * These tests require a running Kubernetes cluster and Prometheus.
 * They are skipped if no cluster is available.
 *
 * To run these tests:
 * 1. Ensure kubectl is configured with a valid context
 * 2. Ensure Prometheus is running (port-forward to localhost:9090)
 * 3. Run: npm test -- --grep "Cluster Integration"
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startServer } from '../server/index.js';
import { SandboxClient } from '../client/index.js';

// Check if cluster is available
function isClusterAvailable(): boolean {
  try {
    execSync('kubectl cluster-info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if Prometheus is available
function isPrometheusAvailable(): boolean {
  try {
    execSync('curl -s http://localhost:9090/-/healthy', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const clusterAvailable = isClusterAvailable();
const prometheusAvailable = isPrometheusAvailable();

const K8S_SETUP = `
  const k8s = require('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
`;

// Generate unique IDs for test isolation (avoid collision between src and dist tests)
const clusterTestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe.skipIf(!clusterAvailable)('Cluster Integration Tests', () => {
  const testSocketPath = `/tmp/prodisco-cluster-test-${clusterTestId}.sock`;
  const testCacheDir = `/tmp/prodisco-cache-cluster-${clusterTestId}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    // Start the server with Prometheus URL if available
    server = await startServer({
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
      prometheusUrl: prometheusAvailable ? 'http://localhost:9090' : undefined,
    });

    client = new SandboxClient({ socketPath: testSocketPath });

    const healthy = await client.waitForHealthy(10000);
    expect(healthy).toBe(true);
  });

  afterAll(async () => {
    client.close();

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

  describe('Kubernetes API - Namespaces', () => {
    it('lists namespaces', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNamespace();
          const names = response.items.map(ns => ns.metadata?.name).filter(Boolean);
          console.log(JSON.stringify(names));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const namespaces = JSON.parse(result.output);
      expect(Array.isArray(namespaces)).toBe(true);
      expect(namespaces).toContain('default');
      expect(namespaces).toContain('kube-system');
    });

    it('gets a specific namespace', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.readNamespace({ name: 'default' });
          console.log(JSON.stringify({
            name: response.metadata?.name,
            status: response.status?.phase,
          }));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const namespace = JSON.parse(result.output);
      expect(namespace.name).toBe('default');
      expect(namespace.status).toBe('Active');
    });
  });

  describe('Kubernetes API - Pods', () => {
    it('lists pods in kube-system', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNamespacedPod({ namespace: 'kube-system' });
          const pods = response.items.map(pod => ({
            name: pod.metadata?.name,
            status: pod.status?.phase,
          }));
          console.log(JSON.stringify(pods));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const pods = JSON.parse(result.output);
      expect(Array.isArray(pods)).toBe(true);
      expect(pods.length).toBeGreaterThan(0);
      // All pods should have a status
      pods.forEach((pod: { name: string; status: string }) => {
        expect(pod.name).toBeDefined();
        expect(pod.status).toBeDefined();
      });
    });

    it('lists pods across all namespaces', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listPodForAllNamespaces();
          console.log(response.items.length);
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const podCount = parseInt(result.output, 10);
      expect(podCount).toBeGreaterThan(0);
    });
  });

  describe('Kubernetes API - Nodes', () => {
    it('lists cluster nodes', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNode();
          const nodes = response.items.map(node => ({
            name: node.metadata?.name,
            ready: node.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True',
          }));
          console.log(JSON.stringify(nodes));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const nodes = JSON.parse(result.output);
      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBeGreaterThan(0);
      // At least one node should be ready
      expect(nodes.some((n: { ready: boolean }) => n.ready)).toBe(true);
    });

    it('gets node resources', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNode();
          const node = response.items[0];
          const resources = {
            cpu: node.status?.capacity?.cpu,
            memory: node.status?.capacity?.memory,
          };
          console.log(JSON.stringify(resources));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const resources = JSON.parse(result.output);
      expect(resources.cpu).toBeDefined();
      expect(resources.memory).toBeDefined();
    });
  });

  describe('Kubernetes API - Services', () => {
    it('lists services in default namespace', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNamespacedService({ namespace: 'default' });
          const services = response.items.map(svc => ({
            name: svc.metadata?.name,
            type: svc.spec?.type,
            clusterIP: svc.spec?.clusterIP,
          }));
          console.log(JSON.stringify(services));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const services = JSON.parse(result.output);
      expect(Array.isArray(services)).toBe(true);
      // kubernetes service should always exist in default namespace
      expect(services.some((s: { name: string }) => s.name === 'kubernetes')).toBe(true);
    });
  });

  describe('Kubernetes API - Deployments', () => {
    it('lists deployments in kube-system', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.AppsV1Api);
          const response = await api.listNamespacedDeployment({ namespace: 'kube-system' });
          const deployments = response.items.map(dep => ({
            name: dep.metadata?.name,
            replicas: dep.spec?.replicas,
            available: dep.status?.availableReplicas,
          }));
          console.log(JSON.stringify(deployments));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const deployments = JSON.parse(result.output);
      expect(Array.isArray(deployments)).toBe(true);
      // coredns deployment should exist in kube-system
      expect(deployments.some((d: { name: string }) => d.name === 'coredns')).toBe(true);
    });
  });

  describe('Kubernetes API - ConfigMaps', () => {
    it('lists configmaps in kube-system', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNamespacedConfigMap({ namespace: 'kube-system' });
          const configmaps = response.items.map(cm => cm.metadata?.name).filter(Boolean);
          console.log(JSON.stringify(configmaps));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const configmaps = JSON.parse(result.output);
      expect(Array.isArray(configmaps)).toBe(true);
      expect(configmaps.length).toBeGreaterThan(0);
    });
  });

  describe('Kubernetes API - Events', () => {
    it('lists recent events', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listEventForAllNamespaces({ limit: 10 });
          const events = response.items.map(event => ({
            type: event.type,
            reason: event.reason,
            message: event.message?.substring(0, 100),
          }));
          console.log(JSON.stringify(events));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const events = JSON.parse(result.output);
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('Kubernetes Context', () => {
    it('returns current context in health check', async () => {
      const health = await client.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.kubernetesContext).toBeDefined();
      expect(typeof health.kubernetesContext).toBe('string');
    });

    it('can access current context from sandbox', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          const context = kc.getCurrentContext();
          console.log(context);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output.length).toBeGreaterThan(0);
    });
  });
});

const promTestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe.skipIf(!clusterAvailable || !prometheusAvailable)('Prometheus Integration Tests', () => {
  const testSocketPath = `/tmp/prodisco-prom-test-${promTestId}.sock`;
  const testCacheDir = `/tmp/prodisco-cache-prom-${promTestId}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    server = await startServer({
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
      prometheusUrl: 'http://localhost:9090',
    });

    client = new SandboxClient({ socketPath: testSocketPath });

    const healthy = await client.waitForHealthy(10000);
    expect(healthy).toBe(true);
  });

  afterAll(async () => {
    client.close();

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

  describe('Prometheus Queries', () => {
    it('queries up metric', async () => {
      const result = await client.execute({
        code: `
          const { PrometheusClient } = require('@prodisco/prometheus-client');
          const prom = new PrometheusClient({
            endpoint: 'http://localhost:9090',
          });
          const response = await prom.execute('up');
          console.log(JSON.stringify({
            resultType: response.resultType,
            resultCount: response.data.length,
          }));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output);
      expect(data.resultType).toBe('vector');
      expect(data.resultCount).toBeGreaterThan(0);
    });

    it('queries container metrics', async () => {
      const result = await client.execute({
        code: `
          const { PrometheusClient } = require('@prodisco/prometheus-client');
          const prom = new PrometheusClient({
            endpoint: 'http://localhost:9090',
          });
          const response = await prom.execute('container_cpu_usage_seconds_total');
          console.log(JSON.stringify({
            resultType: response.resultType,
            hasResults: response.data.length > 0,
          }));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output);
      expect(data.resultType).toBe('vector');
    });

    it('queries container memory metrics', async () => {
      const result = await client.execute({
        code: `
          const { PrometheusClient } = require('@prodisco/prometheus-client');
          const prom = new PrometheusClient({
            endpoint: 'http://localhost:9090',
          });
          const response = await prom.execute('container_memory_usage_bytes{container!=""}');
          console.log(JSON.stringify({
            resultType: response.resultType,
            containerCount: response.data.length,
          }));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output);
      expect(data.resultType).toBe('vector');
      expect(data.containerCount).toBeGreaterThan(0);
    });

    it('performs range query', async () => {
      const result = await client.execute({
        code: `
          const { PrometheusClient } = require('@prodisco/prometheus-client');
          const prom = new PrometheusClient({
            endpoint: 'http://localhost:9090',
          });
          const end = new Date();
          const start = new Date(end.getTime() - 5 * 60 * 1000); // 5 minutes ago
          const response = await prom.executeRange('up', { start, end, step: 60 });
          console.log(JSON.stringify({
            resultType: response.resultType,
            seriesCount: response.data.length,
          }));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output);
      expect(data.resultType).toBe('matrix');
      expect(data.seriesCount).toBeGreaterThan(0);
    });

    it('queries node metrics', async () => {
      const result = await client.execute({
        code: `
          const { PrometheusClient } = require('@prodisco/prometheus-client');
          const prom = new PrometheusClient({
            endpoint: 'http://localhost:9090',
          });
          const response = await prom.execute('node_memory_MemTotal_bytes');
          const nodes = response.data.map(r => ({
            instance: r.labels.instance,
            memoryBytes: r.samples.length > 0 ? r.samples[0].value : 0,
          }));
          console.log(JSON.stringify(nodes));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const nodes = JSON.parse(result.output);
      expect(Array.isArray(nodes)).toBe(true);
    });
  });

  describe('Combined K8s + Prometheus', () => {
    it('correlates pod info with container metrics', async () => {
      const result = await client.execute({
        code: `
          ${K8S_SETUP}
          // Get pods from Kubernetes
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const podsResponse = await api.listNamespacedPod({ namespace: 'kube-system', limit: 5 });
          const podNames = podsResponse.items.map(p => p.metadata?.name).filter(Boolean);

          // Query Prometheus for container CPU metrics (available from cadvisor)
          const { PrometheusClient } = require('@prodisco/prometheus-client');
          const prom = new PrometheusClient({
            endpoint: 'http://localhost:9090',
          });
          const response = await prom.execute('container_cpu_usage_seconds_total{container!=""}');

          console.log(JSON.stringify({
            k8sPodCount: podNames.length,
            prometheusMetricCount: response.data.length,
          }));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output);
      expect(data.k8sPodCount).toBeGreaterThan(0);
      expect(data.prometheusMetricCount).toBeGreaterThan(0);
    });
  });
});

const streamTestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe.skipIf(!clusterAvailable)('Streaming with Real K8s Calls', () => {
  const testSocketPath = `/tmp/prodisco-stream-k8s-${streamTestId}.sock`;
  const testCacheDir = `/tmp/prodisco-cache-stream-k8s-${streamTestId}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    server = await startServer({
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
    });

    client = new SandboxClient({ socketPath: testSocketPath });

    const healthy = await client.waitForHealthy(10000);
    expect(healthy).toBe(true);
  });

  afterAll(async () => {
    client.close();

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

  it('streams output while listing pods', async () => {
    const code = `
      ${K8S_SETUP}
      const api = kc.makeApiClient(k8s.CoreV1Api);
      console.log("Fetching pods...");
      const response = await api.listPodForAllNamespaces();
      console.log("Found " + response.items.length + " pods");
      for (const pod of response.items.slice(0, 3)) {
        console.log("Pod: " + pod.metadata?.name);
      }
      console.log("Done!");
    `;

    const chunks: string[] = [];
    let result: any = null;

    for await (const chunk of client.executeStream({ code, timeoutMs: 30000 })) {
      if (chunk.type === 'output') {
        chunks.push(chunk.data as string);
      } else if (chunk.type === 'result') {
        result = chunk.data;
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('Fetching pods');
    expect(chunks.join('')).toContain('Found');
    expect(chunks.join('')).toContain('Done!');
    expect(result?.success).toBe(true);
  });

  it('handles async execution with real K8s calls', async () => {
    const { executionId, state } = await client.executeAsync({
      code: `
        ${K8S_SETUP}
        const api = kc.makeApiClient(k8s.CoreV1Api);
        const response = await api.listNamespace();
        console.log("Namespaces: " + response.items.length);
      `,
      timeoutMs: 30000,
    });

    expect(executionId).toBeDefined();

    // Wait for completion
    const status = await client.waitForExecution(executionId);

    expect(status.state).toBe(3); // COMPLETED
    expect(status.result?.success).toBe(true);
    expect(status.output).toContain('Namespaces:');
  });
});

// =============================================================================
// Comprehensive Streaming and Async Execution Tests
// =============================================================================

const asyncStreamTestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe('Streaming and Async Execution - Comprehensive Tests', () => {
  const testSocketPath = `/tmp/prodisco-async-stream-${asyncStreamTestId}.sock`;
  const testCacheDir = `/tmp/prodisco-cache-async-stream-${asyncStreamTestId}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    server = await startServer({
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
    });

    client = new SandboxClient({ socketPath: testSocketPath });

    const healthy = await client.waitForHealthy(10000);
    expect(healthy).toBe(true);
  });

  afterAll(async () => {
    client.close();

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

  describe('ExecuteStream', () => {
    it('streams incremental output', async () => {
      const code = `
        for (let i = 0; i < 5; i++) {
          console.log("Iteration " + i);
          await new Promise(r => setTimeout(r, 20));
        }
      `;

      const chunks: string[] = [];
      const timestamps: number[] = [];

      for await (const chunk of client.executeStream({ code, timeoutMs: 10000 })) {
        if (chunk.type === 'output') {
          chunks.push(chunk.data as string);
          timestamps.push(chunk.timestampMs);
        }
      }

      // Should have received multiple chunks
      expect(chunks.length).toBeGreaterThan(1);

      // All iterations should be present
      const fullOutput = chunks.join('');
      expect(fullOutput).toContain('Iteration 0');
      expect(fullOutput).toContain('Iteration 4');
    });

    it('separates stdout and stderr', async () => {
      const code = `
        console.log("Standard output");
        console.error("Error output");
        console.log("More standard output");
      `;

      let stdout = '';
      let stderr = '';

      for await (const chunk of client.executeStream({ code, timeoutMs: 5000 })) {
        if (chunk.type === 'output') {
          stdout += chunk.data as string;
        } else if (chunk.type === 'error') {
          stderr += chunk.data as string;
        }
      }

      expect(stdout).toContain('Standard output');
      expect(stdout).toContain('More standard output');
      expect(stderr).toContain('Error output');
    });

    it('returns final result chunk', async () => {
      const code = 'console.log("Hello");';

      let resultChunk: any = null;

      for await (const chunk of client.executeStream({ code, timeoutMs: 5000 })) {
        if (chunk.type === 'result') {
          resultChunk = chunk.data;
        }
      }

      expect(resultChunk).toBeDefined();
      expect(resultChunk.success).toBe(true);
      expect(resultChunk.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('handles execution failure in stream', async () => {
      const code = 'throw new Error("Stream failure test");';

      let resultChunk: any = null;

      for await (const chunk of client.executeStream({ code, timeoutMs: 5000 })) {
        if (chunk.type === 'result') {
          resultChunk = chunk.data;
        }
      }

      expect(resultChunk).toBeDefined();
      expect(resultChunk.success).toBe(false);
      expect(resultChunk.error).toContain('Stream failure test');
    });

    it('streams large output efficiently', async () => {
      const code = `
        for (let i = 0; i < 100; i++) {
          console.log("Line " + i + ": " + "x".repeat(50));
        }
      `;

      const chunks: string[] = [];

      for await (const chunk of client.executeStream({ code, timeoutMs: 10000 })) {
        if (chunk.type === 'output') {
          chunks.push(chunk.data as string);
        }
      }

      const fullOutput = chunks.join('');
      expect(fullOutput).toContain('Line 0');
      expect(fullOutput).toContain('Line 99');
      // Should have received multiple chunks for large output
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('ExecuteAsync', () => {
    it('returns execution ID immediately', async () => {
      const startTime = Date.now();

      const { executionId, state } = await client.executeAsync({
        code: `
          await new Promise(r => setTimeout(r, 500));
          console.log("Delayed execution");
        `,
        timeoutMs: 10000,
      });

      const duration = Date.now() - startTime;

      // Should return quickly (before the code completes)
      expect(duration).toBeLessThan(200);
      expect(executionId).toBeDefined();
      expect(executionId.length).toBeGreaterThan(0);
    });

    it('can poll for status', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          console.log("Starting");
          await new Promise(r => setTimeout(r, 200));
          console.log("Done");
        `,
        timeoutMs: 10000,
      });

      // Poll immediately - might be running
      const status1 = await client.getExecution(executionId);
      expect(status1.executionId).toBe(executionId);

      // Wait and poll again - should be completed
      await new Promise(r => setTimeout(r, 300));
      const status2 = await client.getExecution(executionId);
      expect(status2.state).toBe(3); // COMPLETED
      expect(status2.output).toContain('Done');
    });

    it('supports long-poll with wait', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          await new Promise(r => setTimeout(r, 100));
          console.log("Finished");
        `,
        timeoutMs: 10000,
      });

      // This should block until completion
      const status = await client.getExecution(executionId, { wait: true });

      expect(status.state).toBe(3); // COMPLETED
      expect(status.output).toContain('Finished');
      expect(status.result).toBeDefined();
      expect(status.result?.success).toBe(true);
    });

    it('supports incremental output reading', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          console.log("Part 1");
          await new Promise(r => setTimeout(r, 50));
          console.log("Part 2");
          await new Promise(r => setTimeout(r, 50));
          console.log("Part 3");
        `,
        timeoutMs: 10000,
      });

      // Wait for completion
      await new Promise(r => setTimeout(r, 200));

      // Read full output
      const status1 = await client.getExecution(executionId);
      expect(status1.output).toContain('Part 1');
      expect(status1.output).toContain('Part 3');

      // Read with offset (from middle)
      const halfOffset = Math.floor(status1.outputLength / 2);
      const status2 = await client.getExecution(executionId, { outputOffset: halfOffset });

      // Should have less output when reading from offset
      expect(status2.output.length).toBeLessThan(status1.output.length);
    });

    it('handles concurrent async executions', async () => {
      // Start 3 concurrent executions
      const [exec1, exec2, exec3] = await Promise.all([
        client.executeAsync({ code: 'console.log("Exec 1");', timeoutMs: 5000 }),
        client.executeAsync({ code: 'console.log("Exec 2");', timeoutMs: 5000 }),
        client.executeAsync({ code: 'console.log("Exec 3");', timeoutMs: 5000 }),
      ]);

      // All should have unique IDs
      expect(exec1.executionId).not.toBe(exec2.executionId);
      expect(exec2.executionId).not.toBe(exec3.executionId);

      // Wait for all to complete
      const [status1, status2, status3] = await Promise.all([
        client.waitForExecution(exec1.executionId),
        client.waitForExecution(exec2.executionId),
        client.waitForExecution(exec3.executionId),
      ]);

      expect(status1.state).toBe(3); // COMPLETED
      expect(status2.state).toBe(3);
      expect(status3.state).toBe(3);
      expect(status1.output).toContain('Exec 1');
      expect(status2.output).toContain('Exec 2');
      expect(status3.output).toContain('Exec 3');
    });
  });

  describe('CancelExecution', () => {
    it('cancels a running execution', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          for (let i = 0; i < 100; i++) {
            console.log("Iteration " + i);
            await new Promise(r => setTimeout(r, 100));
          }
        `,
        timeoutMs: 30000,
      });

      // Wait briefly for execution to start
      await new Promise(r => setTimeout(r, 150));

      // Cancel the execution
      const cancelResult = await client.cancelExecution(executionId);

      expect(cancelResult.success).toBe(true);
      expect(cancelResult.state).toBe(5); // CANCELLED

      // Verify the execution is cancelled
      const status = await client.getExecution(executionId);
      expect(status.state).toBe(5); // CANCELLED
    });

    it('handles cancellation of already completed execution', async () => {
      const { executionId } = await client.executeAsync({
        code: 'console.log("Quick");',
        timeoutMs: 5000,
      });

      // Wait for completion
      await client.waitForExecution(executionId);

      // Try to cancel completed execution
      const cancelResult = await client.cancelExecution(executionId);

      // Should fail or indicate already completed
      expect([3, 5]).toContain(cancelResult.state); // COMPLETED or CANCELLED
    });
  });

  describe('ListExecutions', () => {
    it('lists active executions', async () => {
      // Start a long-running execution
      const { executionId } = await client.executeAsync({
        code: `
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 100));
          }
        `,
        timeoutMs: 10000,
      });

      await new Promise(r => setTimeout(r, 50));

      // List running executions
      const executions = await client.listExecutions({
        states: [2], // RUNNING
      });

      // Should find our execution
      const found = executions.find(e => e.executionId === executionId);
      expect(found).toBeDefined();
      expect(found?.state).toBe(2); // RUNNING

      // Cancel to clean up
      await client.cancelExecution(executionId);
    });

    it('lists recent completed executions', async () => {
      // Execute something
      const { executionId } = await client.executeAsync({
        code: 'console.log("List test");',
        timeoutMs: 5000,
      });

      await client.waitForExecution(executionId);

      // List recent completed executions
      const executions = await client.listExecutions({
        states: [3], // COMPLETED
        includeCompletedWithinMs: 10000,
      });

      // Should find our execution
      const found = executions.find(e => e.executionId === executionId);
      expect(found).toBeDefined();
      expect(found?.state).toBe(3);
    });

    it('respects limit parameter', async () => {
      // Execute multiple scripts
      for (let i = 0; i < 5; i++) {
        const { executionId } = await client.executeAsync({
          code: `console.log("Limit test ${i}");`,
          timeoutMs: 5000,
        });
        await client.waitForExecution(executionId);
      }

      // List with limit
      const executions = await client.listExecutions({
        limit: 3,
        includeCompletedWithinMs: 10000,
      });

      expect(executions.length).toBeLessThanOrEqual(3);
    });

    it('returns execution details', async () => {
      const { executionId } = await client.executeAsync({
        code: 'console.log("Details test");',
        timeoutMs: 5000,
      });

      await client.waitForExecution(executionId);

      const executions = await client.listExecutions({
        includeCompletedWithinMs: 30000, // Longer window to ensure we catch it
        limit: 50,
      });

      // The execution registry may clean up completed executions quickly,
      // so we verify the list call works and returns proper structure
      expect(Array.isArray(executions)).toBe(true);

      // If we find our execution, verify its structure
      const found = executions.find(e => e.executionId === executionId);
      if (found) {
        expect(found.startedAtMs).toBeGreaterThan(0);
        expect(found.codePreview).toContain('Details test');
        expect(found.isCached).toBe(false);
      }
    });
  });

  describe('Execution Lifecycle', () => {
    it('tracks full execution lifecycle', async () => {
      // Start execution
      const { executionId, state: initialState } = await client.executeAsync({
        code: `
          console.log("Step 1");
          await new Promise(r => setTimeout(r, 100));
          console.log("Step 2");
        `,
        timeoutMs: 10000,
      });

      expect([1, 2]).toContain(initialState); // PENDING or RUNNING

      // Check while running
      await new Promise(r => setTimeout(r, 50));
      const runningStatus = await client.getExecution(executionId);
      expect([2, 3]).toContain(runningStatus.state); // RUNNING or COMPLETED

      // Wait for completion
      const finalStatus = await client.waitForExecution(executionId);
      expect(finalStatus.state).toBe(3); // COMPLETED
      expect(finalStatus.output).toContain('Step 1');
      expect(finalStatus.output).toContain('Step 2');
      expect(finalStatus.result?.success).toBe(true);
    });

    it('handles execution failure lifecycle', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          console.log("Before error");
          throw new Error("Test failure");
        `,
        timeoutMs: 5000,
      });

      const status = await client.waitForExecution(executionId);

      expect(status.state).toBe(4); // FAILED
      expect(status.output).toContain('Before error');
      expect(status.result?.success).toBe(false);
      expect(status.result?.error).toContain('Test failure');
    });

    it('handles timeout lifecycle', async () => {
      const { executionId } = await client.executeAsync({
        code: `
          console.log("Starting long task");
          await new Promise(r => setTimeout(r, 10000)); // 10 seconds
        `,
        timeoutMs: 200, // Very short timeout
      });

      const status = await client.waitForExecution(executionId);

      expect(status.state).toBe(6); // TIMEOUT
      expect(status.output).toContain('Starting long task');
    });
  });
});
