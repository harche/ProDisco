/**
 * Transport Security Integration Tests
 *
 * Tests all three transport security modes:
 * - insecure: No encryption (for local development)
 * - tls: Server-side TLS (client verifies server)
 * - mtls: Mutual TLS (both sides authenticate)
 *
 * These tests generate temporary self-signed certificates for testing.
 * For kind cluster testing, use the cluster-tls-integration.test.ts file.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer, type TransportMode, type TlsConfig } from '../server/index.js';
import { SandboxClient, type TransportMode as ClientTransportMode } from '../client/index.js';

// Helper to generate unique IDs for test isolation
const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Hardcoded ports for each test suite - src uses 52xxx, dist uses 54xxx
// Port allocation within this file:
//   - Insecure Mode: PORT_BASE + 1
//   - TLS Mode: PORT_BASE + 2
//   - TLS Validation: PORT_BASE + 3
//   - mTLS Mode: PORT_BASE + 4
//   - mTLS Validation: PORT_BASE + 5
//   - Env Var Config: PORT_BASE + 100-109
//   - Mode Transitions: PORT_BASE + 200-209
const isDistBuild = import.meta.url.includes('/dist/');
const PORT_BASE = isDistBuild ? 54000 : 52000;

/**
 * Generate self-signed certificates for testing.
 * Creates CA, server, and client certificates.
 */
function generateTestCertificates(dir: string): {
  caPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  clientCertPath: string;
  clientKeyPath: string;
} {
  mkdirSync(dir, { recursive: true });

  const caKeyPath = join(dir, 'ca.key');
  const caPath = join(dir, 'ca.crt');
  const serverKeyPath = join(dir, 'server.key');
  const serverCsrPath = join(dir, 'server.csr');
  const serverCertPath = join(dir, 'server.crt');
  const clientKeyPath = join(dir, 'client.key');
  const clientCsrPath = join(dir, 'client.csr');
  const clientCertPath = join(dir, 'client.crt');
  const serverExtPath = join(dir, 'server.ext');
  const clientExtPath = join(dir, 'client.ext');

  // Generate CA private key
  execSync(`openssl genrsa -out ${caKeyPath} 2048 2>/dev/null`);

  // Generate CA certificate
  execSync(`openssl req -x509 -new -nodes -key ${caKeyPath} -sha256 -days 1 -out ${caPath} \
    -subj "/C=US/ST=Test/L=Test/O=Test/OU=Test/CN=test-ca" 2>/dev/null`);

  // Generate server private key
  execSync(`openssl genrsa -out ${serverKeyPath} 2048 2>/dev/null`);

  // Generate server CSR
  execSync(`openssl req -new -key ${serverKeyPath} -out ${serverCsrPath} \
    -subj "/C=US/ST=Test/L=Test/O=Test/OU=Test/CN=localhost" 2>/dev/null`);

  // Create server extensions file for SAN
  writeFileSync(serverExtPath, `
subjectAltName = @alt_names
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
DNS.2 = 127.0.0.1
IP.1 = 127.0.0.1
`);

  // Generate server certificate signed by CA
  execSync(`openssl x509 -req -in ${serverCsrPath} -CA ${caPath} -CAkey ${caKeyPath} \
    -CAcreateserial -out ${serverCertPath} -days 1 -sha256 -extfile ${serverExtPath} 2>/dev/null`);

  // Generate client private key
  execSync(`openssl genrsa -out ${clientKeyPath} 2048 2>/dev/null`);

  // Generate client CSR
  execSync(`openssl req -new -key ${clientKeyPath} -out ${clientCsrPath} \
    -subj "/C=US/ST=Test/L=Test/O=Test/OU=Test/CN=test-client" 2>/dev/null`);

  // Create client extensions file
  writeFileSync(clientExtPath, `
extendedKeyUsage = clientAuth
`);

  // Generate client certificate signed by CA
  execSync(`openssl x509 -req -in ${clientCsrPath} -CA ${caPath} -CAkey ${caKeyPath} \
    -CAcreateserial -out ${clientCertPath} -days 1 -sha256 -extfile ${clientExtPath} 2>/dev/null`);

  return {
    caPath,
    serverCertPath,
    serverKeyPath,
    clientCertPath,
    clientKeyPath,
  };
}

/**
 * Verify openssl is available - fail immediately if not.
 * Security tests MUST NOT be silently skipped.
 */
function verifyOpenSslAvailable(): void {
  try {
    execSync('openssl version', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'OpenSSL is required for transport security tests but was not found. ' +
      'Install OpenSSL and ensure it is in your PATH. ' +
      'Security tests must not be skipped.'
    );
  }
}

// Fail fast if OpenSSL is not available
verifyOpenSslAvailable();

// =============================================================================
// Insecure Mode Tests (TCP)
// =============================================================================

describe('Transport Security - Insecure Mode', () => {
  const testId = uniqueId();
  const testPort = PORT_BASE + 1;
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-insecure-${testId}`;
  let server: grpc.Server;
  let client: SandboxClient;

  beforeAll(async () => {
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'insecure',
      cacheDir: testCacheDir,
    });

    client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'insecure',
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);
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

  it('connects and executes code in insecure mode', async () => {
    const result = await client.execute({
      code: 'console.log("insecure mode test")',
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('insecure mode test');
  });

  it('returns healthy status in insecure mode', async () => {
    const health = await client.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.kubernetesContext).toBeDefined();
  });

  it('handles concurrent requests in insecure mode', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      client.execute({ code: `console.log("concurrent ${i}")` })
    );

    const results = await Promise.all(requests);

    expect(results.every(r => r.success)).toBe(true);
    results.forEach((result, i) => {
      expect(result.output).toBe(`concurrent ${i}`);
    });
  });

  it('handles streaming execution in insecure mode', async () => {
    const chunks: string[] = [];

    for await (const chunk of client.executeStream({
      code: `
        console.log("line 1");
        console.log("line 2");
      `,
    })) {
      if (chunk.type === 'output') {
        chunks.push(chunk.data as string);
      }
    }

    const fullOutput = chunks.join('');
    expect(fullOutput).toContain('line 1');
    expect(fullOutput).toContain('line 2');
  });

  it('handles async execution in insecure mode', async () => {
    const { executionId } = await client.executeAsync({
      code: 'console.log("async insecure")',
      timeoutMs: 5000,
    });

    expect(executionId).toBeDefined();

    const status = await client.waitForExecution(executionId);
    expect(status.state).toBe(3); // COMPLETED
    expect(status.output).toContain('async insecure');
  });
});

// =============================================================================
// TLS Mode Tests
// =============================================================================

describe('Transport Security - TLS Mode', () => {
  const testId = uniqueId();
  const testPort = PORT_BASE + 2;
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-tls-${testId}`;
  const certDir = `/tmp/prodisco-certs-tls-${testId}`;
  let server: grpc.Server;
  let client: SandboxClient;
  let certs: ReturnType<typeof generateTestCertificates>;

  beforeAll(async () => {
    // Generate test certificates
    certs = generateTestCertificates(certDir);

    // Start server with TLS
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'tls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
      },
      cacheDir: testCacheDir,
    });

    // Create client with TLS (verifies server)
    client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'tls',
      tls: {
        caPath: certs.caPath,
        serverName: 'localhost', // Override for certificate verification
      },
    });

    const healthy = await client.waitForHealthy(10000);
    expect(healthy).toBe(true);
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
    if (existsSync(certDir)) {
      rmSync(certDir, { recursive: true });
    }
  });

  it('connects and executes code in TLS mode', async () => {
    const result = await client.execute({
      code: 'console.log("TLS mode test")',
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('TLS mode test');
  });

  it('returns healthy status in TLS mode', async () => {
    const health = await client.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.kubernetesContext).toBeDefined();
  });

  it('handles TypeScript code in TLS mode', async () => {
    const result = await client.execute({
      code: `
        interface Message { text: string; }
        const msg: Message = { text: "TLS TypeScript" };
        console.log(msg.text);
      `,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('TLS TypeScript');
  });

  it('handles async code in TLS mode', async () => {
    const result = await client.execute({
      code: `
        await new Promise(r => setTimeout(r, 10));
        console.log("TLS async complete");
      `,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('TLS async complete');
  });

  it('handles concurrent requests in TLS mode', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      client.execute({ code: `console.log("tls concurrent ${i}")` })
    );

    const results = await Promise.all(requests);

    expect(results.every(r => r.success)).toBe(true);
    results.forEach((result, i) => {
      expect(result.output).toBe(`tls concurrent ${i}`);
    });
  });

  it('handles execution errors in TLS mode', async () => {
    const result = await client.execute({
      code: 'throw new Error("TLS error test")',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('TLS error test');
  });

  it('handles streaming execution in TLS mode', async () => {
    const chunks: string[] = [];

    for await (const chunk of client.executeStream({
      code: `
        console.log("tls line 1");
        await new Promise(r => setTimeout(r, 10));
        console.log("tls line 2");
      `,
    })) {
      if (chunk.type === 'output') {
        chunks.push(chunk.data as string);
      }
    }

    const fullOutput = chunks.join('');
    expect(fullOutput).toContain('tls line 1');
    expect(fullOutput).toContain('tls line 2');
  });

  it('handles async execution in TLS mode', async () => {
    const { executionId } = await client.executeAsync({
      code: 'console.log("async TLS")',
      timeoutMs: 5000,
    });

    expect(executionId).toBeDefined();

    const status = await client.waitForExecution(executionId);
    expect(status.state).toBe(3); // COMPLETED
    expect(status.output).toContain('async TLS');
  });

  it('caches scripts in TLS mode', async () => {
    const code = `console.log("tls cache ${uniqueId()}")`;
    const result = await client.execute({ code });

    expect(result.success).toBe(true);
    expect(result.cached).toBeDefined();
    expect(result.cached!.name).toMatch(/^script-.*\.ts$/);
  });
});

// =============================================================================
// TLS Mode - Certificate Validation Tests
// =============================================================================

describe('Transport Security - TLS Certificate Validation', () => {
  const testId = uniqueId();
  const testPort = PORT_BASE + 3;
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-tls-validation-${testId}`;
  const certDir = `/tmp/prodisco-certs-tls-validation-${testId}`;
  const wrongCertDir = `/tmp/prodisco-certs-wrong-${testId}`;
  let server: grpc.Server;
  let certs: ReturnType<typeof generateTestCertificates>;
  let wrongCerts: ReturnType<typeof generateTestCertificates>;

  beforeAll(async () => {
    // Generate correct certificates
    certs = generateTestCertificates(certDir);

    // Generate different (wrong) CA for testing validation failure
    wrongCerts = generateTestCertificates(wrongCertDir);

    // Start server with TLS
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'tls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
      },
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
    if (existsSync(certDir)) {
      rmSync(certDir, { recursive: true });
    }
    if (existsSync(wrongCertDir)) {
      rmSync(wrongCertDir, { recursive: true });
    }
  });

  it('connects successfully with correct CA', async () => {
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'tls',
      tls: {
        caPath: certs.caPath,
        serverName: 'localhost',
      },
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("correct CA")' });
    expect(result.success).toBe(true);

    client.close();
  });

  it('fails to connect with wrong CA', async () => {
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'tls',
      tls: {
        caPath: wrongCerts.caPath, // Wrong CA
        serverName: 'localhost',
      },
    });

    // Should fail to connect
    const healthy = await client.waitForHealthy(2000, 100);
    expect(healthy).toBe(false);

    client.close();
  });
});

// =============================================================================
// mTLS Mode Tests
// =============================================================================

describe('Transport Security - mTLS Mode', () => {
  const testId = uniqueId();
  const testPort = PORT_BASE + 4;
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-mtls-${testId}`;
  const certDir = `/tmp/prodisco-certs-mtls-${testId}`;
  let server: grpc.Server;
  let client: SandboxClient;
  let certs: ReturnType<typeof generateTestCertificates>;

  beforeAll(async () => {
    // Generate test certificates
    certs = generateTestCertificates(certDir);

    // Start server with mTLS (requires client certificate)
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'mtls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
        caPath: certs.caPath, // CA to verify client certificates
      },
      cacheDir: testCacheDir,
    });

    // Create client with mTLS (provides client certificate)
    client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'mtls',
      tls: {
        caPath: certs.caPath,
        certPath: certs.clientCertPath,
        keyPath: certs.clientKeyPath,
        serverName: 'localhost',
      },
    });

    const healthy = await client.waitForHealthy(10000);
    expect(healthy).toBe(true);
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
    if (existsSync(certDir)) {
      rmSync(certDir, { recursive: true });
    }
  });

  it('connects and executes code in mTLS mode', async () => {
    const result = await client.execute({
      code: 'console.log("mTLS mode test")',
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('mTLS mode test');
  });

  it('returns healthy status in mTLS mode', async () => {
    const health = await client.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.kubernetesContext).toBeDefined();
  });

  it('handles TypeScript code in mTLS mode', async () => {
    const result = await client.execute({
      code: `
        interface Secure { verified: boolean; }
        const sec: Secure = { verified: true };
        console.log("mTLS verified:", sec.verified);
      `,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('mTLS verified: true');
  });

  it('handles concurrent requests in mTLS mode', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      client.execute({ code: `console.log("mtls concurrent ${i}")` })
    );

    const results = await Promise.all(requests);

    expect(results.every(r => r.success)).toBe(true);
    results.forEach((result, i) => {
      expect(result.output).toBe(`mtls concurrent ${i}`);
    });
  });

  it('handles streaming execution in mTLS mode', async () => {
    const chunks: string[] = [];

    for await (const chunk of client.executeStream({
      code: `
        console.log("mtls stream 1");
        await new Promise(r => setTimeout(r, 10));
        console.log("mtls stream 2");
      `,
    })) {
      if (chunk.type === 'output') {
        chunks.push(chunk.data as string);
      }
    }

    const fullOutput = chunks.join('');
    expect(fullOutput).toContain('mtls stream 1');
    expect(fullOutput).toContain('mtls stream 2');
  });

  it('handles async execution in mTLS mode', async () => {
    const { executionId } = await client.executeAsync({
      code: 'console.log("async mTLS")',
      timeoutMs: 5000,
    });

    expect(executionId).toBeDefined();

    const status = await client.waitForExecution(executionId);
    expect(status.state).toBe(3); // COMPLETED
    expect(status.output).toContain('async mTLS');
  });

  it('handles cancellation in mTLS mode', async () => {
    const { executionId } = await client.executeAsync({
      code: `
        for (let i = 0; i < 100; i++) {
          console.log("iteration", i);
          await new Promise(r => setTimeout(r, 100));
        }
      `,
      timeoutMs: 30000,
    });

    // Wait briefly for execution to start
    await new Promise(r => setTimeout(r, 150));

    const cancelResult = await client.cancelExecution(executionId);
    expect(cancelResult.success).toBe(true);
    expect(cancelResult.state).toBe(5); // CANCELLED
  });
});

// =============================================================================
// mTLS Mode - Client Certificate Validation Tests
// =============================================================================

describe('Transport Security - mTLS Client Certificate Validation', () => {
  const testId = uniqueId();
  const testPort = PORT_BASE + 5;
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-mtls-validation-${testId}`;
  const certDir = `/tmp/prodisco-certs-mtls-validation-${testId}`;
  const wrongCertDir = `/tmp/prodisco-certs-wrong-client-${testId}`;
  let server: grpc.Server;
  let certs: ReturnType<typeof generateTestCertificates>;
  let wrongCerts: ReturnType<typeof generateTestCertificates>;

  beforeAll(async () => {
    // Generate correct certificates
    certs = generateTestCertificates(certDir);

    // Generate different (wrong) certificates for testing validation failure
    wrongCerts = generateTestCertificates(wrongCertDir);

    // Start server with mTLS
    server = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'mtls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
        caPath: certs.caPath,
      },
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
    if (existsSync(certDir)) {
      rmSync(certDir, { recursive: true });
    }
    if (existsSync(wrongCertDir)) {
      rmSync(wrongCertDir, { recursive: true });
    }
  });

  it('connects successfully with correct client certificate', async () => {
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'mtls',
      tls: {
        caPath: certs.caPath,
        certPath: certs.clientCertPath,
        keyPath: certs.clientKeyPath,
        serverName: 'localhost',
      },
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("correct client cert")' });
    expect(result.success).toBe(true);

    client.close();
  });

  it('fails to connect with wrong client certificate', async () => {
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'mtls',
      tls: {
        caPath: certs.caPath, // Correct CA for server verification
        certPath: wrongCerts.clientCertPath, // Wrong client cert
        keyPath: wrongCerts.clientKeyPath, // Wrong client key
        serverName: 'localhost',
      },
    });

    // Should fail to connect because server rejects client cert
    const healthy = await client.waitForHealthy(2000, 100);
    expect(healthy).toBe(false);

    client.close();
  });

  it('fails to connect without client certificate in mTLS mode', async () => {
    const client = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: testPort,
      transportMode: 'tls', // Using TLS instead of mTLS (no client cert)
      tls: {
        caPath: certs.caPath,
        serverName: 'localhost',
      },
    });

    // Should fail because server requires client certificate
    const healthy = await client.waitForHealthy(2000, 100);
    expect(healthy).toBe(false);

    client.close();
  });
});

// =============================================================================
// Environment Variable Configuration Tests
// =============================================================================

describe('Transport Security - Environment Variable Configuration', () => {
  const testId = uniqueId();
  // Use ports 100-109 to avoid collision with other test suites
  const testPort = PORT_BASE + 100;
  const testHost = '127.0.0.1';
  const testCacheDir = `/tmp/prodisco-cache-env-${testId}`;
  const certDir = `/tmp/prodisco-certs-env-${testId}`;
  let certs: ReturnType<typeof generateTestCertificates>;

  // Original environment variables
  let origTransportMode: string | undefined;
  let origTlsCertPath: string | undefined;
  let origTlsKeyPath: string | undefined;
  let origTlsCaPath: string | undefined;
  let origTlsClientCertPath: string | undefined;
  let origTlsClientKeyPath: string | undefined;
  let origUseTcp: string | undefined;
  let origTcpHost: string | undefined;
  let origTcpPort: string | undefined;

  beforeAll(() => {
    // Save original env vars
    origTransportMode = process.env.SANDBOX_TRANSPORT_MODE;
    origTlsCertPath = process.env.SANDBOX_TLS_CERT_PATH;
    origTlsKeyPath = process.env.SANDBOX_TLS_KEY_PATH;
    origTlsCaPath = process.env.SANDBOX_TLS_CA_PATH;
    origTlsClientCertPath = process.env.SANDBOX_TLS_CLIENT_CERT_PATH;
    origTlsClientKeyPath = process.env.SANDBOX_TLS_CLIENT_KEY_PATH;
    origUseTcp = process.env.SANDBOX_USE_TCP;
    origTcpHost = process.env.SANDBOX_TCP_HOST;
    origTcpPort = process.env.SANDBOX_TCP_PORT;

    // Generate certificates
    certs = generateTestCertificates(certDir);
  });

  afterAll(() => {
    // Restore original env vars
    const restore = (key: string, value: string | undefined) => {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    };

    restore('SANDBOX_TRANSPORT_MODE', origTransportMode);
    restore('SANDBOX_TLS_CERT_PATH', origTlsCertPath);
    restore('SANDBOX_TLS_KEY_PATH', origTlsKeyPath);
    restore('SANDBOX_TLS_CA_PATH', origTlsCaPath);
    restore('SANDBOX_TLS_CLIENT_CERT_PATH', origTlsClientCertPath);
    restore('SANDBOX_TLS_CLIENT_KEY_PATH', origTlsClientKeyPath);
    restore('SANDBOX_USE_TCP', origUseTcp);
    restore('SANDBOX_TCP_HOST', origTcpHost);
    restore('SANDBOX_TCP_PORT', origTcpPort);

    if (existsSync(certDir)) {
      rmSync(certDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up env vars after each test
    delete process.env.SANDBOX_TRANSPORT_MODE;
    delete process.env.SANDBOX_TLS_CERT_PATH;
    delete process.env.SANDBOX_TLS_KEY_PATH;
    delete process.env.SANDBOX_TLS_CA_PATH;
    delete process.env.SANDBOX_TLS_CLIENT_CERT_PATH;
    delete process.env.SANDBOX_TLS_CLIENT_KEY_PATH;
    delete process.env.SANDBOX_USE_TCP;
    delete process.env.SANDBOX_TCP_HOST;
    delete process.env.SANDBOX_TCP_PORT;
  });

  it('uses TLS mode from environment variable', async () => {
    const port = testPort + 1;
    const cacheDir = `${testCacheDir}-tls-env`;

    // Set environment variables for server
    process.env.SANDBOX_TRANSPORT_MODE = 'tls';
    process.env.SANDBOX_TLS_CERT_PATH = certs.serverCertPath;
    process.env.SANDBOX_TLS_KEY_PATH = certs.serverKeyPath;
    process.env.SANDBOX_USE_TCP = 'true';
    process.env.SANDBOX_TCP_HOST = testHost;
    process.env.SANDBOX_TCP_PORT = String(port);

    // Start server using env vars
    const server = await startServer({ cacheDir });

    // Set client environment variables (CA path for TLS verification)
    process.env.SANDBOX_TLS_CA_PATH = certs.caPath;
    process.env.SANDBOX_TLS_SERVER_NAME = 'localhost';

    // Create client using env vars only
    const client = new SandboxClient();

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("env TLS")' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('env TLS');

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true });
    }
  });

  it('uses mTLS mode from environment variable', async () => {
    const port = testPort + 2;
    const cacheDir = `${testCacheDir}-mtls-env`;

    // Set server environment variables
    process.env.SANDBOX_TRANSPORT_MODE = 'mtls';
    process.env.SANDBOX_TLS_CERT_PATH = certs.serverCertPath;
    process.env.SANDBOX_TLS_KEY_PATH = certs.serverKeyPath;
    process.env.SANDBOX_TLS_CA_PATH = certs.caPath;
    process.env.SANDBOX_USE_TCP = 'true';
    process.env.SANDBOX_TCP_HOST = testHost;
    process.env.SANDBOX_TCP_PORT = String(port);

    // Start server using env vars
    const server = await startServer({ cacheDir });

    // Set client environment variables (client cert for mTLS)
    process.env.SANDBOX_TLS_CLIENT_CERT_PATH = certs.clientCertPath;
    process.env.SANDBOX_TLS_CLIENT_KEY_PATH = certs.clientKeyPath;
    process.env.SANDBOX_TLS_SERVER_NAME = 'localhost';

    // Create client using env vars only
    const client = new SandboxClient();

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("env mTLS")' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('env mTLS');

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true });
    }
  });

  it('defaults to insecure mode when SANDBOX_TRANSPORT_MODE is not set', async () => {
    const port = testPort + 3;
    const cacheDir = `${testCacheDir}-insecure-env`;

    // Only set transport env vars, no TLS
    process.env.SANDBOX_USE_TCP = 'true';
    process.env.SANDBOX_TCP_HOST = testHost;
    process.env.SANDBOX_TCP_PORT = String(port);

    // Start server (should default to insecure)
    const server = await startServer({ cacheDir });

    // Create client (should default to insecure)
    const client = new SandboxClient();

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("default insecure")' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('default insecure');

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true });
    }
  });

  it('programmatic options override environment variables', async () => {
    const port = testPort + 4;
    const cacheDir = `${testCacheDir}-override-env`;

    // Set env vars to insecure
    process.env.SANDBOX_TRANSPORT_MODE = 'insecure';
    process.env.SANDBOX_USE_TCP = 'true';
    process.env.SANDBOX_TCP_HOST = testHost;
    process.env.SANDBOX_TCP_PORT = String(port);

    // But start server with TLS (programmatic override)
    const server = await startServer({
      transportMode: 'tls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
      },
      cacheDir,
    });

    // Client with TLS (programmatic override)
    const client = new SandboxClient({
      transportMode: 'tls',
      tls: {
        caPath: certs.caPath,
        serverName: 'localhost',
      },
    });

    const healthy = await client.waitForHealthy(5000);
    expect(healthy).toBe(true);

    const result = await client.execute({ code: 'console.log("override to TLS")' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('override to TLS');

    client.close();
    await new Promise<void>((resolve) => {
      server.tryShutdown((err) => {
        if (err) server.forceShutdown();
        resolve();
      });
    });

    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true });
    }
  });
});

// =============================================================================
// Mode Transition Tests
// =============================================================================

describe('Transport Security - Mode Transitions', () => {
  const testId = uniqueId();
  const certDir = `/tmp/prodisco-certs-transition-${testId}`;
  let certs: ReturnType<typeof generateTestCertificates>;

  beforeAll(() => {
    certs = generateTestCertificates(certDir);
  });

  afterAll(() => {
    if (existsSync(certDir)) {
      rmSync(certDir, { recursive: true });
    }
  });

  it('can run multiple servers with different security modes', async () => {
    // Use ports 200-209 for multi-mode tests
    const insecurePort = PORT_BASE + 200;
    const tlsPort = PORT_BASE + 201;
    const mtlsPort = PORT_BASE + 202;
    const testHost = '127.0.0.1';

    const insecureCacheDir = `/tmp/prodisco-cache-multi-insecure-${testId}`;
    const tlsCacheDir = `/tmp/prodisco-cache-multi-tls-${testId}`;
    const mtlsCacheDir = `/tmp/prodisco-cache-multi-mtls-${testId}`;

    // Start insecure server
    const insecureServer = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: insecurePort,
      transportMode: 'insecure',
      cacheDir: insecureCacheDir,
    });

    // Start TLS server
    const tlsServer = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: tlsPort,
      transportMode: 'tls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
      },
      cacheDir: tlsCacheDir,
    });

    // Start mTLS server
    const mtlsServer = await startServer({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: mtlsPort,
      transportMode: 'mtls',
      tls: {
        certPath: certs.serverCertPath,
        keyPath: certs.serverKeyPath,
        caPath: certs.caPath,
      },
      cacheDir: mtlsCacheDir,
    });

    // Create clients for each server
    const insecureClient = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: insecurePort,
      transportMode: 'insecure',
    });

    const tlsClient = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: tlsPort,
      transportMode: 'tls',
      tls: {
        caPath: certs.caPath,
        serverName: 'localhost',
      },
    });

    const mtlsClient = new SandboxClient({
      useTcp: true,
      tcpHost: testHost,
      tcpPort: mtlsPort,
      transportMode: 'mtls',
      tls: {
        caPath: certs.caPath,
        certPath: certs.clientCertPath,
        keyPath: certs.clientKeyPath,
        serverName: 'localhost',
      },
    });

    // Wait for all servers to be healthy
    const [insecureHealthy, tlsHealthy, mtlsHealthy] = await Promise.all([
      insecureClient.waitForHealthy(5000),
      tlsClient.waitForHealthy(5000),
      mtlsClient.waitForHealthy(5000),
    ]);

    expect(insecureHealthy).toBe(true);
    expect(tlsHealthy).toBe(true);
    expect(mtlsHealthy).toBe(true);

    // Execute code on all servers concurrently
    const [insecureResult, tlsResult, mtlsResult] = await Promise.all([
      insecureClient.execute({ code: 'console.log("insecure")' }),
      tlsClient.execute({ code: 'console.log("tls")' }),
      mtlsClient.execute({ code: 'console.log("mtls")' }),
    ]);

    expect(insecureResult.success).toBe(true);
    expect(insecureResult.output).toBe('insecure');
    expect(tlsResult.success).toBe(true);
    expect(tlsResult.output).toBe('tls');
    expect(mtlsResult.success).toBe(true);
    expect(mtlsResult.output).toBe('mtls');

    // Cleanup
    insecureClient.close();
    tlsClient.close();
    mtlsClient.close();

    await Promise.all([
      new Promise<void>((resolve) => {
        insecureServer.tryShutdown((err) => {
          if (err) insecureServer.forceShutdown();
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        tlsServer.tryShutdown((err) => {
          if (err) tlsServer.forceShutdown();
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        mtlsServer.tryShutdown((err) => {
          if (err) mtlsServer.forceShutdown();
          resolve();
        });
      }),
    ]);

    // Cleanup cache directories
    for (const dir of [insecureCacheDir, tlsCacheDir, mtlsCacheDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true });
      }
    }
  });
});
