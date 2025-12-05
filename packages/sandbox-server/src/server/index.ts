#!/usr/bin/env node
import * as grpc from '@grpc/grpc-js';
import { unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SandboxServiceService } from '../generated/sandbox.js';
import { createSandboxService } from './sandbox-service.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';

export interface ServerConfig {
  socketPath?: string;
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
 * Start the gRPC sandbox server.
 */
export async function startServer(config: ServerConfig = {}): Promise<grpc.Server> {
  const socketPath = config.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;

  // Clean up existing socket
  cleanupSocket(socketPath);

  const server = new grpc.Server();

  // Create service with k8s/prometheus context
  const sandboxService = createSandboxService({
    prometheusUrl: config.prometheusUrl || process.env.PROMETHEUS_URL,
    cacheDir: config.cacheDir || process.env.SCRIPTS_CACHE_DIR,
  });

  server.addService(SandboxServiceService, sandboxService);

  return new Promise((resolve, reject) => {
    server.bindAsync(
      `unix://${socketPath}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        console.log(`Sandbox gRPC server listening on unix://${socketPath}`);
        resolve(server);
      }
    );
  });
}

/**
 * Graceful shutdown handler.
 */
function setupShutdown(server: grpc.Server, socketPath: string): void {
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);

    server.tryShutdown((err) => {
      if (err) {
        console.error('Error during shutdown', err);
        server.forceShutdown();
      }

      // Clean up socket file
      cleanupSocket(socketPath);

      console.log('Server shut down');
      process.exit(0);
    });

    // Set a deadline for graceful shutdown
    setTimeout(() => {
      console.warn('Forced shutdown after timeout');
      server.forceShutdown();
      cleanupSocket(socketPath);
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
  const socketPath = process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;

  startServer({ socketPath })
    .then((server) => {
      setupShutdown(server, socketPath);
      console.log('Sandbox server started');
    })
    .catch((err) => {
      console.error('Failed to start sandbox server', err);
      process.exit(1);
    });
}
