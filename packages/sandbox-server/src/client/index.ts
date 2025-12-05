import * as grpc from '@grpc/grpc-js';
import {
  SandboxServiceClient,
  type ExecuteRequest,
  type ExecuteResponse,
  type HealthCheckResponse,
} from '../generated/sandbox.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';

export interface SandboxClientOptions {
  socketPath?: string;
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
 * SandboxClient provides a high-level interface to the gRPC sandbox server.
 */
export class SandboxClient {
  private client: SandboxServiceClient;

  constructor(options: SandboxClientOptions = {}) {
    const socketPath = options.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;

    this.client = new SandboxServiceClient(
      `unix://${socketPath}`,
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
