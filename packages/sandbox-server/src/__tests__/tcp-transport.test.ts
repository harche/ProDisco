import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { rmSync, existsSync } from 'node:fs';
import { startServer } from '../server/index.js';
import { SandboxClient } from '../client/index.js';

// Helper to generate unique IDs for test isolation
const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('TCP Transport', () => {
  const testPort = 50052 + Math.floor(Math.random() * 1000);
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-tcp-${uniqueId()}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    // Start server with TCP transport
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      cacheDir: testCacheDir,
    });

    // Create client with TCP transport
    client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
    });

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
  });

  describe('Health Check over TCP', () => {
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

  describe('Code Execution over TCP', () => {
    it('executes simple code', async () => {
      const result = await client.execute({
        code: 'console.log("hello from TCP")',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('hello from TCP');
      expect(result.error).toBeUndefined();
    });

    it('handles TypeScript code', async () => {
      const result = await client.execute({
        code: `
          interface User { name: string; }
          const user: User = { name: "TCP Test" };
          console.log(user.name);
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('TCP Test');
    });

    it('handles async code', async () => {
      const result = await client.execute({
        code: `
          await new Promise(r => setTimeout(r, 10));
          console.log("async TCP complete");
        `,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('async TCP complete');
    });

    it('handles execution errors', async () => {
      const result = await client.execute({
        code: 'throw new Error("TCP error")',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('TCP error');
    });

    it('respects timeout', async () => {
      const result = await client.execute({
        code: 'await new Promise(r => setTimeout(r, 10000))',
        timeoutMs: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Script execution timed out');
    });
  });

  describe('Concurrent Requests over TCP', () => {
    it('handles multiple concurrent executions', async () => {
      const requests = Array.from({ length: 10 }, (_, i) => ({
        code: `console.log("tcp concurrent ${i}")`,
      }));

      const results = await Promise.all(
        requests.map(req => client.execute(req))
      );

      expect(results.every(r => r.success)).toBe(true);
      results.forEach((result, i) => {
        expect(result.output).toBe(`tcp concurrent ${i}`);
      });
    });
  });
});

describe('TCP Transport with Environment Variables', () => {
  const testPort = 50053 + Math.floor(Math.random() * 1000);
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-tcp-env-${uniqueId()}`;
  let server: grpc.Server;
  let client: SandboxClient;

  let originalTcpHost: string | undefined;
  let originalTcpPort: string | undefined;
  let originalUseTcp: string | undefined;

  beforeAll(async () => {
    // Save original env vars
    originalTcpHost = process.env.SANDBOX_TCP_HOST;
    originalTcpPort = process.env.SANDBOX_TCP_PORT;
    originalUseTcp = process.env.SANDBOX_USE_TCP;

    // Set env vars
    process.env.SANDBOX_TCP_HOST = testHost;
    process.env.SANDBOX_TCP_PORT = String(testPort);
    process.env.SANDBOX_USE_TCP = 'true';

    // Start server using env vars
    server = await startServer({
      cacheDir: testCacheDir,
    });

    // Create client using env vars
    client = new SandboxClient();

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

    // Restore original env vars
    if (originalTcpHost !== undefined) {
      process.env.SANDBOX_TCP_HOST = originalTcpHost;
    } else {
      delete process.env.SANDBOX_TCP_HOST;
    }
    if (originalTcpPort !== undefined) {
      process.env.SANDBOX_TCP_PORT = originalTcpPort;
    } else {
      delete process.env.SANDBOX_TCP_PORT;
    }
    if (originalUseTcp !== undefined) {
      process.env.SANDBOX_USE_TCP = originalUseTcp;
    } else {
      delete process.env.SANDBOX_USE_TCP;
    }
  });

  it('connects using environment variables', async () => {
    const result = await client.healthCheck();
    expect(result.healthy).toBe(true);
  });

  it('executes code over TCP configured by env vars', async () => {
    const result = await client.execute({
      code: 'console.log("env var TCP")',
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('env var TCP');
  });
});

describe('SandboxClient TCP Options', () => {
  it('uses TCP when useTcp is true', () => {
    const client = new SandboxClient({ useTcp: true });
    expect(client).toBeInstanceOf(SandboxClient);
    client.close();
  });

  it('uses TCP when tcpHost is specified', () => {
    const client = new SandboxClient({ tcpHost: 'localhost' });
    expect(client).toBeInstanceOf(SandboxClient);
    client.close();
  });

  it('uses TCP when tcpPort is specified', () => {
    const client = new SandboxClient({ tcpPort: 50051 });
    expect(client).toBeInstanceOf(SandboxClient);
    client.close();
  });

  it('uses Unix socket by default', () => {
    const client = new SandboxClient({ socketPath: '/tmp/test.sock' });
    expect(client).toBeInstanceOf(SandboxClient);
    client.close();
  });

  it('waitForHealthy returns false for non-existent TCP server', async () => {
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: 'localhost',
      tcpPort: 59999, // Unlikely to be in use
    });

    const result = await client.waitForHealthy(100, 50);
    expect(result).toBe(false);

    client.close();
  });
});

describe('TCP Transport - Script Caching', () => {
  const testPort = 50054 + Math.floor(Math.random() * 1000);
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-tcp-caching-${uniqueId()}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      cacheDir: testCacheDir,
    });

    client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
    });

    await client.waitForHealthy(5000);
  });

  afterAll(async () => {
    client.close();

    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  it('caches successful executions over TCP', async () => {
    const code = `console.log("tcp cache test ${uniqueId()}")`;
    const result = await client.execute({ code });

    expect(result.success).toBe(true);
    expect(result.cached).toBeDefined();
    expect(result.cached!.name).toMatch(/^script-.*\.ts$/);
  });

  it('can execute cached scripts over TCP', async () => {
    const uniqueValue = `tcp-cached-${uniqueId()}`;
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
  });

  it('returns error for non-existent cached script over TCP', async () => {
    const result = await client.execute({
      cached: 'non-existent-tcp-script-12345',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('TCP Transport - Server Binding Options', () => {
  it('binds to localhost', async () => {
    const testPort = 50055 + Math.floor(Math.random() * 1000);
    const testCacheDir = `/tmp/prodisco-cache-tcp-localhost-${uniqueId()}`;

    const server = await startServer({
      useTcp: true,
      tcpHost: 'localhost',
      tcpPort: testPort,
      cacheDir: testCacheDir,
    });

    const client = new SandboxClient({
      useTcp: true,
      tcpHost: 'localhost',
      tcpPort: testPort,
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("localhost test")' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('localhost test');

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  it('binds to 0.0.0.0', async () => {
    const testPort = 50056 + Math.floor(Math.random() * 1000);
    const testCacheDir = `/tmp/prodisco-cache-tcp-allif-${uniqueId()}`;

    const server = await startServer({
      useTcp: true,
      tcpHost: '0.0.0.0',
      tcpPort: testPort,
      cacheDir: testCacheDir,
    });

    // Connect via 127.0.0.1 (should work since server binds to all interfaces)
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: '127.0.0.1',
      tcpPort: testPort,
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("0.0.0.0 test")' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('0.0.0.0 test');

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });
});

describe('TCP Transport - Environment Variable Priority', () => {
  let originalSocketPath: string | undefined;
  let originalTcpHost: string | undefined;
  let originalTcpPort: string | undefined;
  let originalUseTcp: string | undefined;

  beforeEach(() => {
    // Save original env vars
    originalSocketPath = process.env.SANDBOX_SOCKET_PATH;
    originalTcpHost = process.env.SANDBOX_TCP_HOST;
    originalTcpPort = process.env.SANDBOX_TCP_PORT;
    originalUseTcp = process.env.SANDBOX_USE_TCP;

    // Clear all env vars
    delete process.env.SANDBOX_SOCKET_PATH;
    delete process.env.SANDBOX_TCP_HOST;
    delete process.env.SANDBOX_TCP_PORT;
    delete process.env.SANDBOX_USE_TCP;
  });

  afterEach(() => {
    // Restore original env vars
    if (originalSocketPath !== undefined) {
      process.env.SANDBOX_SOCKET_PATH = originalSocketPath;
    } else {
      delete process.env.SANDBOX_SOCKET_PATH;
    }
    if (originalTcpHost !== undefined) {
      process.env.SANDBOX_TCP_HOST = originalTcpHost;
    } else {
      delete process.env.SANDBOX_TCP_HOST;
    }
    if (originalTcpPort !== undefined) {
      process.env.SANDBOX_TCP_PORT = originalTcpPort;
    } else {
      delete process.env.SANDBOX_TCP_PORT;
    }
    if (originalUseTcp !== undefined) {
      process.env.SANDBOX_USE_TCP = originalUseTcp;
    } else {
      delete process.env.SANDBOX_USE_TCP;
    }
  });

  it('explicit useTcp=false overrides env vars', async () => {
    const testPort = 50057 + Math.floor(Math.random() * 1000);
    const id = uniqueId();
    const testSocketPath = `/tmp/prodisco-test-priority-${id}.sock`;
    const testCacheDir = `/tmp/prodisco-cache-priority-${id}`;

    // Set env vars to use TCP
    process.env.SANDBOX_USE_TCP = 'true';
    process.env.SANDBOX_TCP_HOST = '127.0.0.1';
    process.env.SANDBOX_TCP_PORT = String(testPort);

    // But explicitly set useTcp=false - should use Unix socket
    const server = await startServer({
      useTcp: false,
      socketPath: testSocketPath,
      cacheDir: testCacheDir,
    });

    const client = new SandboxClient({
      useTcp: false,
      socketPath: testSocketPath,
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    // Clean up socket file
    if (existsSync(testSocketPath)) {
      rmSync(testSocketPath);
    }
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  it('SANDBOX_USE_TCP=1 enables TCP', async () => {
    const testPort = 50058 + Math.floor(Math.random() * 1000);
    const testCacheDir = `/tmp/prodisco-cache-usetcp1-${uniqueId()}`;

    process.env.SANDBOX_USE_TCP = '1';
    process.env.SANDBOX_TCP_HOST = '127.0.0.1';
    process.env.SANDBOX_TCP_PORT = String(testPort);

    const server = await startServer({ cacheDir: testCacheDir });
    const client = new SandboxClient();

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("USE_TCP=1")' });
    expect(result.success).toBe(true);

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  it('setting only SANDBOX_TCP_HOST implies TCP', async () => {
    const testPort = 50059 + Math.floor(Math.random() * 1000);
    const testCacheDir = `/tmp/prodisco-cache-hostimplies-${uniqueId()}`;

    // Only set host, not USE_TCP
    process.env.SANDBOX_TCP_HOST = '127.0.0.1';
    process.env.SANDBOX_TCP_PORT = String(testPort);

    const server = await startServer({ cacheDir: testCacheDir });
    const client = new SandboxClient();

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  it('setting only SANDBOX_TCP_PORT implies TCP', async () => {
    const testPort = 50060 + Math.floor(Math.random() * 1000);
    const testCacheDir = `/tmp/prodisco-cache-portimplies-${uniqueId()}`;

    // Only set port, not USE_TCP or HOST
    process.env.SANDBOX_TCP_PORT = String(testPort);

    const server = await startServer({ cacheDir: testCacheDir });

    // Client needs to know the port too
    const client = new SandboxClient();

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });
});

describe('TCP Transport - Multiple Clients', () => {
  const testPort = 50061 + Math.floor(Math.random() * 1000);
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-tcp-multiclient-${uniqueId()}`;
  let server: grpc.Server;

  beforeAll(async () => {
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      cacheDir: testCacheDir,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  it('handles multiple independent clients', async () => {
    const clients = Array.from({ length: 3 }, () =>
      new SandboxClient({
        useTcp: true,
        tcpHost: testHost,
        tcpPort: testPort,
      })
    );

    // Wait for all clients to be healthy
    const healthChecks = await Promise.all(
      clients.map(client => client.waitForHealthy(5000))
    );
    expect(healthChecks.every(h => h)).toBe(true);

    // Execute code from each client concurrently
    const results = await Promise.all(
      clients.map((client, i) =>
        client.execute({ code: `console.log("client ${i}")` })
      )
    );

    expect(results.every(r => r.success)).toBe(true);
    results.forEach((result, i) => {
      expect(result.output).toBe(`client ${i}`);
    });

    // Close all clients
    clients.forEach(client => client.close());
  });

  it('handles client reconnection after close', async () => {
    const client1 = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
    });

    await client1.waitForHealthy(5000);
    const result1 = await client1.execute({ code: 'console.log("first")' });
    expect(result1.success).toBe(true);

    client1.close();

    // Create new client after closing the first one
    const client2 = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
    });

    await client2.waitForHealthy(5000);
    const result2 = await client2.execute({ code: 'console.log("second")' });
    expect(result2.success).toBe(true);
    expect(result2.output).toBe('second');

    client2.close();
  });
});
