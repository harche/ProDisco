#!/usr/bin/env node
import * as grpc from '@grpc/grpc-js';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SandboxServiceService } from '../generated/sandbox.js';
import { createSandboxService } from './sandbox-service.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';
const DEFAULT_TCP_HOST = '0.0.0.0';
const DEFAULT_TCP_PORT = 50051;

/**
 * Transport security modes for gRPC communication.
 *
 * - `insecure`: No encryption (Unix socket or TCP, for local development)
 * - `tls`: Server-side TLS (client verifies server identity)
 * - `mtls`: Mutual TLS (both client and server authenticate each other)
 */
export type TransportMode = 'insecure' | 'tls' | 'mtls';

export interface TlsConfig {
  /** Path to the server certificate file */
  certPath: string;
  /** Path to the server private key file */
  keyPath: string;
  /** Path to the CA certificate for verifying client certs (required for mTLS) */
  caPath?: string;
}

export interface ServerConfig {
  /** Unix socket path for local connections */
  socketPath?: string;
  /** TCP host to bind to (e.g., '0.0.0.0', 'localhost') */
  tcpHost?: string;
  /** TCP port to bind to */
  tcpPort?: number;
  /** Use TCP transport instead of Unix socket (legacy, prefer transportMode) */
  useTcp?: boolean;
  /** Transport security mode */
  transportMode?: TransportMode;
  /** TLS configuration (required for 'tls' and 'mtls' modes) */
  tls?: TlsConfig;
  prometheusUrl?: string;
  cacheDir?: string;
}

/**
 * Clean up existing socket file if present.
 */
function cleanupSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (error) {
      // Ignore ENOENT, throw others
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

const VALID_TRANSPORT_MODES: TransportMode[] = ['insecure', 'tls', 'mtls'];

/**
 * Get the transport mode from config or environment.
 * Defaults to 'insecure' for backward compatibility.
 */
function getTransportMode(config: ServerConfig): TransportMode {
  // Config takes precedence
  if (config.transportMode) {
    return config.transportMode;
  }

  // Check environment variable
  const envMode = process.env.SANDBOX_TRANSPORT_MODE;
  if (envMode && VALID_TRANSPORT_MODES.includes(envMode as TransportMode)) {
    return envMode as TransportMode;
  }

  return 'insecure';
}

/**
 * Get TLS configuration from config or environment.
 */
function getTlsConfig(config: ServerConfig): TlsConfig | undefined {
  if (config.tls) {
    return config.tls;
  }

  const certPath = process.env.SANDBOX_TLS_CERT_PATH;
  const keyPath = process.env.SANDBOX_TLS_KEY_PATH;
  const caPath = process.env.SANDBOX_TLS_CA_PATH;

  if (certPath && keyPath) {
    return { certPath, keyPath, caPath };
  }

  return undefined;
}

/**
 * Create server credentials based on transport mode.
 */
function createServerCredentials(mode: TransportMode, tls?: TlsConfig): grpc.ServerCredentials {
  if (mode === 'insecure') {
    return grpc.ServerCredentials.createInsecure();
  }

  if (!tls) {
    throw new Error(`TLS configuration required for transport mode: ${mode}`);
  }

  const certChain = readFileSync(tls.certPath);
  const privateKey = readFileSync(tls.keyPath);

  // For mTLS, load CA to verify client certificates
  const rootCerts = mode === 'mtls' && tls.caPath ? readFileSync(tls.caPath) : null;

  return grpc.ServerCredentials.createSsl(
    rootCerts,
    [{ cert_chain: certChain, private_key: privateKey }],
    mode === 'mtls' // checkClientCertificate
  );
}

/**
 * Determine if Unix socket should be used based on config and environment.
 */
function shouldUseUnixSocket(config: ServerConfig): boolean {
  // Explicit useTcp takes precedence
  if (config.useTcp !== undefined) {
    return !config.useTcp;
  }

  // Check environment variable
  const envUseTcp = process.env.SANDBOX_USE_TCP;
  if (envUseTcp === 'true' || envUseTcp === '1') {
    return false;
  }

  // Check if TCP host or port is specified
  if (config.tcpHost || config.tcpPort || process.env.SANDBOX_TCP_HOST || process.env.SANDBOX_TCP_PORT) {
    return false;
  }

  // Check if socket path is specified
  if (config.socketPath || process.env.SANDBOX_SOCKET_PATH) {
    return true;
  }

  // Default to Unix socket for local development
  return true;
}

/**
 * Get the binding address based on configuration.
 */
function getBindAddress(config: ServerConfig): { address: string; isUnixSocket: boolean } {
  if (shouldUseUnixSocket(config)) {
    const socketPath = config.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
    return { address: `unix://${socketPath}`, isUnixSocket: true };
  }

  const host = config.tcpHost || process.env.SANDBOX_TCP_HOST || DEFAULT_TCP_HOST;
  const port = config.tcpPort || parseInt(process.env.SANDBOX_TCP_PORT || '', 10) || DEFAULT_TCP_PORT;
  return { address: `${host}:${port}`, isUnixSocket: false };
}

/**
 * Start the gRPC sandbox server.
 *
 * Supports Unix socket (default) or TCP transport, with configurable security modes.
 *
 * Unix socket (default, insecure):
 *   startServer({ socketPath: '/tmp/sandbox.sock' })
 *
 * TCP (insecure):
 *   startServer({ useTcp: true, tcpHost: '0.0.0.0', tcpPort: 50051 })
 *
 * TCP with TLS (server-side TLS):
 *   startServer({
 *     useTcp: true,
 *     transportMode: 'tls',
 *     tls: { certPath: '/path/to/tls.crt', keyPath: '/path/to/tls.key' }
 *   })
 *
 * TCP with mTLS (mutual TLS):
 *   startServer({
 *     useTcp: true,
 *     transportMode: 'mtls',
 *     tls: { certPath: '/path/to/tls.crt', keyPath: '/path/to/tls.key', caPath: '/path/to/ca.crt' }
 *   })
 */
export async function startServer(config: ServerConfig = {}): Promise<grpc.Server> {
  const transportMode = getTransportMode(config);
  const tlsConfig = getTlsConfig(config);
  const { address, isUnixSocket } = getBindAddress(config);

  // Clean up existing socket file if using Unix socket
  if (isUnixSocket) {
    const socketPath = address.replace('unix://', '');
    cleanupSocket(socketPath);
  }

  const server = new grpc.Server();

  // Create service with k8s/prometheus context and LSP configuration
  console.log('[SandboxServer] SANDBOX_MODULES_BASE_PATH env:', process.env.SANDBOX_MODULES_BASE_PATH || '(not set)');
  const sandboxService = createSandboxService({
    prometheusUrl: config.prometheusUrl || process.env.PROMETHEUS_URL,
    cacheDir: config.cacheDir || process.env.SCRIPTS_CACHE_DIR,
    lspBasePath: process.env.SANDBOX_MODULES_BASE_PATH,
    scriptsCacheDir: process.env.SCRIPTS_CACHE_DIR,
  });

  server.addService(SandboxServiceService, sandboxService);

  // Create credentials based on transport mode
  const credentials = createServerCredentials(transportMode, tlsConfig);

  return new Promise((resolve, reject) => {
    server.bindAsync(address, credentials, (error) => {
      if (error) {
        reject(error);
        return;
      }
      const securityInfo =
        transportMode === 'insecure'
          ? '(insecure)'
          : transportMode === 'mtls'
            ? '(mTLS)'
            : '(TLS)';
      console.log(`Sandbox gRPC server listening on ${address} ${securityInfo}`);
      resolve(server);
    });
  });
}

/**
 * Graceful shutdown handler.
 */
function setupShutdown(server: grpc.Server, socketPath: string | null): void {
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);

    server.tryShutdown((err) => {
      if (err) {
        console.error('Error during shutdown', err);
        server.forceShutdown();
      }

      // Clean up socket file (only for Unix socket)
      if (socketPath) {
        cleanupSocket(socketPath);
      }

      console.log('Server shut down');
      process.exit(0);
    });

    // Set a deadline for graceful shutdown
    setTimeout(() => {
      console.warn('Forced shutdown after timeout');
      server.forceShutdown();
      if (socketPath) {
        cleanupSocket(socketPath);
      }
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// CLI entry point
const isMainModule =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('/sandbox-server/dist/server/index.js');

if (isMainModule) {
  const config: ServerConfig = {};
  const { address, isUnixSocket } = getBindAddress(config);
  const socketPath = isUnixSocket ? address.replace('unix://', '') : null;

  startServer(config)
    .then((server) => {
      setupShutdown(server, socketPath);
      console.log('Sandbox server started');
    })
    .catch((err) => {
      console.error('Failed to start sandbox server', err);
      process.exit(1);
    });
}
