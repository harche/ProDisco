import * as grpc from '@grpc/grpc-js';
import type { ClientReadableStream } from '@grpc/grpc-js';
import {
  SandboxServiceClient,
  type ExecuteRequest,
  type ExecuteResponse,
  type ExecuteChunk,
  type ExecuteAsyncResponse,
  type GetExecutionResponse,
  type CancelExecutionResponse,
  type ListExecutionsResponse,
  type ExecutionInfo,
  type HealthCheckResponse,
  type CacheEntry,
  type ListCacheResponse,
  type ClearCacheResponse,
  ExecutionState,
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
  /** Full cache entry if newly cached (not set if duplicate or failed) */
  cached?: {
    name: string;
    description: string;
    createdAtMs: number;
    contentHash: string;
  };
}

export interface StreamingExecuteResult extends ExecuteResult {
  executionId: string;
  state: ExecutionState;
}

export interface StreamChunk {
  executionId: string;
  type: 'output' | 'error' | 'result';
  data: string | StreamingExecuteResult;
  timestampMs: number;
}

export interface ExecutionStatus {
  executionId: string;
  state: ExecutionState;
  output: string;
  errorOutput: string;
  outputLength: number;
  errorOutputLength: number;
  result?: StreamingExecuteResult;
}

export interface ExecutionSummary {
  executionId: string;
  state: ExecutionState;
  startedAtMs: number;
  finishedAtMs?: number;
  codePreview: string;
  isCached: boolean;
  cachedName?: string;
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
            cached: response.cached ? {
              name: response.cached.name,
              description: response.cached.description,
              createdAtMs: Number(response.cached.createdAtMs),
              contentHash: response.cached.contentHash,
            } : undefined,
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
   * List all cached entries.
   * Optionally filter by name pattern.
   */
  async listCache(filter?: string): Promise<Array<{
    name: string;
    description: string;
    createdAtMs: number;
    contentHash: string;
  }>> {
    return new Promise((resolve, reject) => {
      this.client.listCache({ filter }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve(response.entries.map(entry => ({
            name: entry.name,
            description: entry.description,
            createdAtMs: Number(entry.createdAtMs),
            contentHash: entry.contentHash,
          })));
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Clear all cached entries.
   * Returns the number of entries deleted.
   */
  async clearCache(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.clearCache({}, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve(Number(response.deletedCount));
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  // ===========================================================================
  // Streaming Execution
  // ===========================================================================

  /**
   * Execute code with streaming output.
   * Returns an async generator that yields chunks as they arrive.
   *
   * @example
   * ```ts
   * for await (const chunk of client.executeStream({ code: 'console.log("hello")' })) {
   *   if (chunk.type === 'output') console.log(chunk.data);
   *   else if (chunk.type === 'result') console.log('Done:', chunk.data);
   * }
   * ```
   */
  async *executeStream(options: ExecuteOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const request: ExecuteRequest = {
      timeoutMs: options.timeoutMs,
      source: undefined,
    };

    if (options.code) {
      request.source = { $case: 'code', code: options.code };
    } else if (options.cached) {
      request.source = { $case: 'cached', cached: options.cached };
    }

    const stream: ClientReadableStream<ExecuteChunk> = this.client.executeStream(request);

    const chunks: StreamChunk[] = [];
    let resolveNext: ((value: StreamChunk | null) => void) | null = null;
    let streamError: Error | null = null;
    let streamEnded = false;

    stream.on('data', (chunk: ExecuteChunk) => {
      const mapped = this.mapChunk(chunk);
      if (resolveNext) {
        resolveNext(mapped);
        resolveNext = null;
      } else {
        chunks.push(mapped);
      }
    });

    stream.on('error', (error: Error) => {
      streamError = error;
      if (resolveNext) {
        resolveNext(null);
        resolveNext = null;
      }
    });

    stream.on('end', () => {
      streamEnded = true;
      if (resolveNext) {
        resolveNext(null);
        resolveNext = null;
      }
    });

    while (true) {
      // Check for buffered chunks first
      if (chunks.length > 0) {
        yield chunks.shift()!;
        continue;
      }

      // Check for stream end or error
      if (streamEnded || streamError) {
        if (streamError) throw streamError;
        return;
      }

      // Wait for next chunk
      const chunk = await new Promise<StreamChunk | null>((resolve) => {
        resolveNext = resolve;
      });

      if (chunk === null) {
        if (streamError) throw streamError;
        return;
      }

      yield chunk;
    }
  }

  /**
   * Execute code with streaming output and AbortSignal support.
   *
   * @param options - Execution options
   * @param signal - AbortSignal for cancellation
   *
   * @example
   * ```ts
   * const controller = new AbortController();
   * setTimeout(() => controller.abort(), 5000); // Cancel after 5 seconds
   *
   * try {
   *   for await (const chunk of client.executeStreamWithAbort({ code }, controller.signal)) {
   *     console.log(chunk);
   *   }
   * } catch (e) {
   *   if (e.name === 'AbortError') console.log('Cancelled');
   * }
   * ```
   */
  async *executeStreamWithAbort(
    options: ExecuteOptions,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const request: ExecuteRequest = {
      timeoutMs: options.timeoutMs,
      source: undefined,
    };

    if (options.code) {
      request.source = { $case: 'code', code: options.code };
    } else if (options.cached) {
      request.source = { $case: 'cached', cached: options.cached };
    }

    const stream: ClientReadableStream<ExecuteChunk> = this.client.executeStream(request);

    // Handle abort signal
    const abortHandler = () => {
      stream.cancel();
    };
    signal?.addEventListener('abort', abortHandler);

    try {
      const chunks: StreamChunk[] = [];
      let resolveNext: ((value: StreamChunk | null) => void) | null = null;
      let streamError: Error | null = null;
      let streamEnded = false;

      stream.on('data', (chunk: ExecuteChunk) => {
        const mapped = this.mapChunk(chunk);
        if (resolveNext) {
          resolveNext(mapped);
          resolveNext = null;
        } else {
          chunks.push(mapped);
        }
      });

      stream.on('error', (error: Error) => {
        streamError = error;
        if (resolveNext) {
          resolveNext(null);
          resolveNext = null;
        }
      });

      stream.on('end', () => {
        streamEnded = true;
        if (resolveNext) {
          resolveNext(null);
          resolveNext = null;
        }
      });

      while (true) {
        // Check abort signal
        if (signal?.aborted) {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          throw error;
        }

        // Check for buffered chunks first
        if (chunks.length > 0) {
          yield chunks.shift()!;
          continue;
        }

        // Check for stream end or error
        if (streamEnded || streamError) {
          if (streamError) throw streamError;
          return;
        }

        // Wait for next chunk
        const chunk = await new Promise<StreamChunk | null>((resolve) => {
          resolveNext = resolve;
        });

        if (chunk === null) {
          if (streamError) throw streamError;
          return;
        }

        yield chunk;
      }
    } finally {
      signal?.removeEventListener('abort', abortHandler);
    }
  }

  private mapChunk(chunk: ExecuteChunk): StreamChunk {
    const timestampMs = Number(chunk.timestampMs);

    if (chunk.chunk?.$case === 'output') {
      return {
        executionId: chunk.executionId,
        type: 'output',
        data: chunk.chunk.output,
        timestampMs,
      };
    } else if (chunk.chunk?.$case === 'errorOutput') {
      return {
        executionId: chunk.executionId,
        type: 'error',
        data: chunk.chunk.errorOutput,
        timestampMs,
      };
    } else if (chunk.chunk?.$case === 'result') {
      const result = chunk.chunk.result;
      return {
        executionId: chunk.executionId,
        type: 'result',
        data: {
          executionId: chunk.executionId,
          success: result.success,
          output: '',
          error: result.error,
          executionTimeMs: Number(result.executionTimeMs),
          state: result.state,
          cached: result.cached ? {
            name: result.cached.name,
            description: result.cached.description,
            createdAtMs: Number(result.cached.createdAtMs),
            contentHash: result.cached.contentHash,
          } : undefined,
        },
        timestampMs,
      };
    }

    // Fallback for unknown chunk type
    return {
      executionId: chunk.executionId,
      type: 'output',
      data: '',
      timestampMs,
    };
  }

  // ===========================================================================
  // Async Execution
  // ===========================================================================

  /**
   * Start execution asynchronously and return immediately with an execution ID.
   */
  async executeAsync(options: ExecuteOptions): Promise<{ executionId: string; state: ExecutionState }> {
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
      this.client.executeAsync(request, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            executionId: response.executionId,
            state: response.state,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Get the current status and output of an async execution.
   *
   * @param executionId - The execution ID from executeAsync
   * @param options - Optional parameters
   */
  async getExecution(
    executionId: string,
    options?: { wait?: boolean; outputOffset?: number }
  ): Promise<ExecutionStatus> {
    return new Promise((resolve, reject) => {
      this.client.getExecution({
        executionId,
        wait: options?.wait ?? false,
        outputOffset: String(options?.outputOffset ?? 0),
      }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            executionId: response.executionId,
            state: response.state,
            output: response.output,
            errorOutput: response.errorOutput,
            outputLength: Number(response.outputLength),
            errorOutputLength: Number(response.errorOutputLength),
            result: response.result ? {
              executionId: response.executionId,
              success: response.result.success,
              output: '',
              error: response.result.error,
              executionTimeMs: Number(response.result.executionTimeMs),
              state: response.result.state,
              cached: response.result.cached ? {
                name: response.result.cached.name,
                description: response.result.cached.description,
                createdAtMs: Number(response.result.cached.createdAtMs),
                contentHash: response.result.cached.contentHash,
              } : undefined,
            } : undefined,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Wait for an async execution to complete.
   *
   * @param executionId - The execution ID from executeAsync
   */
  async waitForExecution(executionId: string): Promise<ExecutionStatus> {
    return this.getExecution(executionId, { wait: true });
  }

  /**
   * Cancel a running execution.
   *
   * @param executionId - The execution ID to cancel
   */
  async cancelExecution(executionId: string): Promise<{ success: boolean; state: ExecutionState; message?: string }> {
    return new Promise((resolve, reject) => {
      this.client.cancelExecution({ executionId }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            success: response.success,
            state: response.state,
            message: response.message,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * List active and recent executions.
   */
  async listExecutions(options?: {
    states?: ExecutionState[];
    limit?: number;
    includeCompletedWithinMs?: number;
  }): Promise<ExecutionSummary[]> {
    return new Promise((resolve, reject) => {
      this.client.listExecutions({
        states: options?.states ?? [],
        limit: options?.limit ?? 100,
        includeCompletedWithinMs: String(options?.includeCompletedWithinMs ?? 0),
      }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve(response.executions.map(e => ({
            executionId: e.executionId,
            state: e.state,
            startedAtMs: Number(e.startedAtMs),
            finishedAtMs: e.finishedAtMs ? Number(e.finishedAtMs) : undefined,
            codePreview: e.codePreview,
            isCached: e.isCached,
            cachedName: e.cachedName,
          })));
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Close the client connection.
   */
  close(): void {
    this.client.close();
  }
}

// Re-export types for convenience
export type {
  ExecuteResponse,
  ExecuteChunk,
  ExecuteAsyncResponse,
  GetExecutionResponse,
  CancelExecutionResponse,
  ListExecutionsResponse,
  ExecutionInfo,
  HealthCheckResponse,
  CacheEntry,
  ListCacheResponse,
  ClearCacheResponse,
};

export { ExecutionState };

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
