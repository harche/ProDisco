#!/usr/bin/env node
import * as grpc from '@grpc/grpc-js';
import { unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SandboxServiceService } from '../generated/sandbox.js';
import { createSandboxService } from './sandbox-service.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';
const DEFAULT_TCP_HOST = '0.0.0.0';
const DEFAULT_TCP_PORT = 50051;

export interface ServerConfig {
  /** Unix socket path for local connections */
  socketPath?: string;
  /** TCP host to bind to (e.g., '0.0.0.0', 'localhost') */
  tcpHost?: string;
  /** TCP port to bind to */
  tcpPort?: number;
  /** Use TCP transport instead of Unix socket */
  useTcp?: boolean;
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

/**
 * Determine if TCP transport should be used based on config and environment.
 */
function shouldUseTcp(config: ServerConfig): boolean {
  if (config.useTcp !== undefined) {
    return config.useTcp;
  }
  // Check environment variable
  const envUseTcp = process.env.SANDBOX_USE_TCP;
  if (envUseTcp !== undefined) {
    return envUseTcp === 'true' || envUseTcp === '1';
  }
  // Check if TCP host or port is specified
  if (config.tcpHost || config.tcpPort || process.env.SANDBOX_TCP_HOST || process.env.SANDBOX_TCP_PORT) {
    return true;
  }
  return false;
}

/**
 * Get the binding address based on configuration.
 */
function getBindAddress(config: ServerConfig): { address: string; isUnixSocket: boolean } {
  if (shouldUseTcp(config)) {
    const host = config.tcpHost || process.env.SANDBOX_TCP_HOST || DEFAULT_TCP_HOST;
    const port = config.tcpPort || parseInt(process.env.SANDBOX_TCP_PORT || '', 10) || DEFAULT_TCP_PORT;
    return { address: `${host}:${port}`, isUnixSocket: false };
  }

  const socketPath = config.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
  return { address: `unix://${socketPath}`, isUnixSocket: true };
}

/**
 * Start the gRPC sandbox server.
 *
 * Supports both Unix socket (default) and TCP transport.
 *
 * Unix socket (default):
 *   startServer({ socketPath: '/tmp/sandbox.sock' })
 *
 * TCP transport:
 *   startServer({ useTcp: true, tcpHost: '0.0.0.0', tcpPort: 50051 })
 */
export async function startServer(config: ServerConfig = {}): Promise<grpc.Server> {
  const { address, isUnixSocket } = getBindAddress(config);

  // Clean up existing socket file if using Unix socket
  if (isUnixSocket) {
    const socketPath = address.replace('unix://', '');
    cleanupSocket(socketPath);
  }

  const server = new grpc.Server();

  // Create service with k8s/prometheus context
  const sandboxService = createSandboxService({
    prometheusUrl: config.prometheusUrl || process.env.PROMETHEUS_URL,
    cacheDir: config.cacheDir || process.env.SCRIPTS_CACHE_DIR,
  });

  server.addService(SandboxServiceService, sandboxService);

  return new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        console.log(`Sandbox gRPC server listening on ${address}`);
        resolve(server);
      }
    );
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
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url) ||
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
