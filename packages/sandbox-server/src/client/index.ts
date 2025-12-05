import * as grpc from '@grpc/grpc-js';
import {
  SandboxServiceClient,
  type ExecuteRequest,
  type ExecuteResponse,
  type HealthCheckResponse,
} from '../generated/sandbox.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';
const DEFAULT_TCP_HOST = 'localhost';
const DEFAULT_TCP_PORT = 50051;

export interface SandboxClientOptions {
  /** Unix socket path for local connections */
  socketPath?: string;
  /** TCP host to connect to (e.g., 'localhost', 'sandbox.example.com') */
  tcpHost?: string;
  /** TCP port to connect to */
  tcpPort?: number;
  /** Use TCP transport instead of Unix socket */
  useTcp?: boolean;
}

export interface ExecuteOptions {
  code?: string;
  cached?: string;
  timeoutMs?: number;
}

export interface ExecuteResult {
  success: boolean;
  output: string;
  error?: string;
  executionTimeMs: number;
  cachedAs?: string;
}

/**
 * Determine if TCP transport should be used based on options and environment.
 */
function shouldUseTcp(options: SandboxClientOptions): boolean {
  if (options.useTcp !== undefined) {
    return options.useTcp;
  }
  // Check environment variable
  const envUseTcp = process.env.SANDBOX_USE_TCP;
  if (envUseTcp !== undefined) {
    return envUseTcp === 'true' || envUseTcp === '1';
  }
  // Check if TCP host or port is specified
  if (options.tcpHost || options.tcpPort || process.env.SANDBOX_TCP_HOST || process.env.SANDBOX_TCP_PORT) {
    return true;
  }
  return false;
}

/**
 * Get the connection address based on options.
 */
function getConnectionAddress(options: SandboxClientOptions): string {
  if (shouldUseTcp(options)) {
    const host = options.tcpHost || process.env.SANDBOX_TCP_HOST || DEFAULT_TCP_HOST;
    const port = options.tcpPort || parseInt(process.env.SANDBOX_TCP_PORT || '', 10) || DEFAULT_TCP_PORT;
    return `${host}:${port}`;
  }

  const socketPath = options.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
  return `unix://${socketPath}`;
}

/**
 * SandboxClient provides a high-level interface to the gRPC sandbox server.
 *
 * Supports both Unix socket (default) and TCP transport.
 *
 * Unix socket (default):
 *   new SandboxClient({ socketPath: '/tmp/sandbox.sock' })
 *
 * TCP transport:
 *   new SandboxClient({ useTcp: true, tcpHost: 'localhost', tcpPort: 50051 })
 *   new SandboxClient({ tcpHost: 'sandbox.example.com', tcpPort: 50051 })
 */
export class SandboxClient {
  private client: SandboxServiceClient;

  constructor(options: SandboxClientOptions = {}) {
    const address = getConnectionAddress(options);

    this.client = new SandboxServiceClient(
      address,
      grpc.credentials.createInsecure(),
      {
        'grpc.keepalive_time_ms': 10000,
        'grpc.keepalive_timeout_ms': 5000,
      }
    );
  }

  /**
   * Execute code in the sandbox.
   */
  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const request: ExecuteRequest = {
      timeoutMs: options.timeoutMs,
      source: undefined,
    };

    if (options.code) {
      request.source = { $case: 'code', code: options.code };
    } else if (options.cached) {
      request.source = { $case: 'cached', cached: options.cached };
    }

    return new Promise((resolve, reject) => {
      this.client.execute(request, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            success: response.success,
            output: response.output,
            error: response.error ?? undefined,
            executionTimeMs: Number(response.executionTimeMs),
            cachedAs: response.cachedAs ?? undefined,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Check if the sandbox server is healthy.
   */
  async healthCheck(): Promise<{ healthy: boolean; kubernetesContext: string }> {
    return new Promise((resolve, reject) => {
      this.client.healthCheck({}, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            healthy: response.healthy,
            kubernetesContext: response.kubernetesContext,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Wait for the sandbox server to become healthy.
   * Useful for startup synchronization.
   */
  async waitForHealthy(timeoutMs: number = 10000, intervalMs: number = 100): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.healthCheck();
        if (result.healthy) {
          return true;
        }
      } catch {
        // Server not ready yet, continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return false;
  }

  /**
   * Close the client connection.
   */
  close(): void {
    this.client.close();
  }
}

// Re-export types for convenience
export type { ExecuteResponse, HealthCheckResponse };

// Singleton client instance
let globalClient: SandboxClient | null = null;

/**
 * Get a singleton client instance.
 */
export function getSandboxClient(options?: SandboxClientOptions): SandboxClient {
  if (!globalClient) {
    globalClient = new SandboxClient(options);
  }
  return globalClient;
}

/**
 * Close the singleton client instance.
 */
export function closeSandboxClient(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
