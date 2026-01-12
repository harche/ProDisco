import * as grpc from '@grpc/grpc-js';
import type { ClientReadableStream } from '@grpc/grpc-js';
import { readFileSync } from 'node:fs';
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
  type ExecuteTestRequest,
  type ExecuteTestResponse,
  ExecutionState,
  // LSP types
  type LspWorkspaceSymbolResponse,
  type LspHoverResponse,
  type LspLocationsResponse,
  type LspDocumentSymbolResponse,
  LspSymbolKind,
} from '../generated/sandbox.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';
const DEFAULT_TCP_HOST = 'localhost';
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
  /** Path to CA certificate for verifying the server */
  caPath?: string;
  /** Path to client certificate (required for mTLS) */
  certPath?: string;
  /** Path to client private key (required for mTLS) */
  keyPath?: string;
  /** Override server name for TLS verification */
  serverName?: string;
}

export interface SandboxClientOptions {
  /** Unix socket path for local connections */
  socketPath?: string;
  /** TCP host to connect to (e.g., 'localhost', 'sandbox.example.com') */
  tcpHost?: string;
  /** TCP port to connect to */
  tcpPort?: number;
  /** Use TCP transport instead of Unix socket (legacy, prefer transportMode) */
  useTcp?: boolean;
  /** Transport security mode */
  transportMode?: TransportMode;
  /** TLS configuration (required for 'tls' and 'mtls' modes) */
  tls?: TlsConfig;
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

export interface ExecuteTestOptions {
  code?: string;
  tests: string;
  timeoutMs?: number;
}

export interface TestResultItem {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface TestExecutionResult {
  success: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  tests: TestResultItem[];
  output: string;
  executionTimeMs: number;
  error?: string;
}

// ===========================================================================
// LSP Types
// ===========================================================================

export interface LspRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspSymbolInfo {
  name: string;
  kind: LspSymbolKind;
  library: string;
  containerName: string;
  location: LspLocation;
}

export interface LspWorkspaceSymbolResult {
  symbols: LspSymbolInfo[];
  totalMatches: number;
}

export interface LspHoverResult {
  contents: string;
  range?: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  kind: LspSymbolKind;
  detail: string;
  range: LspRange;
  selectionRange: LspRange;
  children: LspDocumentSymbol[];
}

const VALID_TRANSPORT_MODES: TransportMode[] = ['insecure', 'tls', 'mtls'];

/**
 * Get the transport mode from options or environment.
 * Defaults to 'insecure' for backward compatibility.
 */
function getTransportMode(options: SandboxClientOptions): TransportMode {
  // Options take precedence
  if (options.transportMode) {
    return options.transportMode;
  }

  // Check environment variable
  const envMode = process.env.SANDBOX_TRANSPORT_MODE;
  if (envMode && VALID_TRANSPORT_MODES.includes(envMode as TransportMode)) {
    return envMode as TransportMode;
  }

  return 'insecure';
}

/**
 * Get TLS configuration from options or environment.
 */
function getTlsConfig(options: SandboxClientOptions): TlsConfig | undefined {
  if (options.tls) {
    return options.tls;
  }

  const caPath = process.env.SANDBOX_TLS_CA_PATH;
  const certPath = process.env.SANDBOX_TLS_CLIENT_CERT_PATH;
  const keyPath = process.env.SANDBOX_TLS_CLIENT_KEY_PATH;
  const serverName = process.env.SANDBOX_TLS_SERVER_NAME;

  if (caPath || certPath || keyPath || serverName) {
    return { caPath, certPath, keyPath, serverName };
  }

  return undefined;
}

/**
 * Create client credentials based on transport mode.
 */
function createClientCredentials(mode: TransportMode, tls?: TlsConfig): grpc.ChannelCredentials {
  if (mode === 'insecure') {
    return grpc.credentials.createInsecure();
  }

  // For TLS/mTLS, load CA certificate if provided
  const rootCerts = tls?.caPath ? readFileSync(tls.caPath) : null;

  if (mode === 'mtls') {
    if (!tls?.certPath || !tls?.keyPath) {
      throw new Error('Client certificate and key required for mTLS mode');
    }
    const privateKey = readFileSync(tls.keyPath);
    const certChain = readFileSync(tls.certPath);
    return grpc.credentials.createSsl(rootCerts, privateKey, certChain);
  }

  // TLS mode - server auth only
  return grpc.credentials.createSsl(rootCerts);
}

/**
 * Determine if Unix socket should be used based on options and environment.
 */
function shouldUseUnixSocket(options: SandboxClientOptions): boolean {
  // Explicit useTcp takes precedence
  if (options.useTcp !== undefined) {
    return !options.useTcp;
  }

  // Check environment variable
  const envUseTcp = process.env.SANDBOX_USE_TCP;
  if (envUseTcp === 'true' || envUseTcp === '1') {
    return false;
  }

  // Check if TCP host or port is specified
  if (options.tcpHost || options.tcpPort || process.env.SANDBOX_TCP_HOST || process.env.SANDBOX_TCP_PORT) {
    return false;
  }

  // Check if socket path is specified
  if (options.socketPath || process.env.SANDBOX_SOCKET_PATH) {
    return true;
  }

  // Default to Unix socket for local development
  return true;
}

/**
 * Get the connection address based on options.
 */
function getConnectionAddress(options: SandboxClientOptions): string {
  if (shouldUseUnixSocket(options)) {
    const socketPath = options.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
    return `unix://${socketPath}`;
  }

  const host = options.tcpHost || process.env.SANDBOX_TCP_HOST || DEFAULT_TCP_HOST;
  const port = options.tcpPort || parseInt(process.env.SANDBOX_TCP_PORT || '', 10) || DEFAULT_TCP_PORT;
  return `${host}:${port}`;
}

/**
 * SandboxClient provides a high-level interface to the gRPC sandbox server.
 *
 * Supports Unix socket (default) or TCP transport, with configurable security modes.
 *
 * Unix socket (default, insecure):
 *   new SandboxClient({ socketPath: '/tmp/sandbox.sock' })
 *
 * TCP (insecure):
 *   new SandboxClient({ useTcp: true, tcpHost: 'localhost', tcpPort: 50051 })
 *
 * TCP with TLS (server-side TLS):
 *   new SandboxClient({
 *     useTcp: true,
 *     transportMode: 'tls',
 *     tls: { caPath: '/path/to/ca.crt' }
 *   })
 *
 * TCP with mTLS (mutual TLS):
 *   new SandboxClient({
 *     useTcp: true,
 *     transportMode: 'mtls',
 *     tls: { caPath: '/path/to/ca.crt', certPath: '/path/to/tls.crt', keyPath: '/path/to/tls.key' }
 *   })
 */
export class SandboxClient {
  private client: SandboxServiceClient;

  constructor(options: SandboxClientOptions = {}) {
    const transportMode = getTransportMode(options);
    const tlsConfig = getTlsConfig(options);
    const address = getConnectionAddress(options);

    // Create credentials based on transport mode
    const credentials = createClientCredentials(transportMode, tlsConfig);

    // Configure channel options
    const channelOptions: grpc.ChannelOptions = {
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
    };

    // Override server name for TLS verification if specified
    if (tlsConfig?.serverName && (transportMode === 'tls' || transportMode === 'mtls')) {
      channelOptions['grpc.ssl_target_name_override'] = tlsConfig.serverName;
    }

    this.client = new SandboxServiceClient(address, credentials, channelOptions);
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
   * Execute tests in the sandbox.
   * Returns structured test results.
   */
  async executeTest(options: ExecuteTestOptions): Promise<TestExecutionResult> {
    const request: ExecuteTestRequest = {
      tests: options.tests,
      code: options.code,
      timeoutMs: options.timeoutMs,
    };

    return new Promise((resolve, reject) => {
      this.client.executeTest(request, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            success: response.success,
            summary: response.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0 },
            tests: response.tests.map(t => ({
              name: t.name,
              passed: t.passed,
              error: t.error ?? undefined,
              durationMs: Number(t.durationMs),
            })),
            output: response.output,
            executionTimeMs: Number(response.executionTimeMs),
            error: response.error ?? undefined,
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

  // ===========================================================================
  // LSP Operations
  // ===========================================================================

  /**
   * Search for symbols by name across the workspace.
   *
   * @param query - The search query (partial match supported)
   * @param limit - Maximum number of results to return
   */
  async lspWorkspaceSymbol(query: string, limit?: number): Promise<LspWorkspaceSymbolResult> {
    return new Promise((resolve, reject) => {
      this.client.lspWorkspaceSymbol({ query, limit }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            symbols: response.symbols.map(s => ({
              name: s.name,
              kind: s.kind,
              library: s.library,
              containerName: s.containerName,
              location: {
                uri: s.location?.uri ?? '',
                range: {
                  startLine: s.location?.range?.startLine ?? 0,
                  startCharacter: s.location?.range?.startCharacter ?? 0,
                  endLine: s.location?.range?.endLine ?? 0,
                  endCharacter: s.location?.range?.endCharacter ?? 0,
                },
              },
            })),
            totalMatches: response.totalMatches,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Get hover information (type info and documentation) at a position.
   *
   * @param filePath - Absolute path to the file
   * @param line - Line number (1-based)
   * @param character - Character offset (0-based)
   */
  async lspHover(filePath: string, line: number, character: number): Promise<LspHoverResult> {
    return new Promise((resolve, reject) => {
      this.client.lspHover({ filePath, line, character }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve({
            contents: response.contents,
            range: response.range ? {
              startLine: response.range.startLine,
              startCharacter: response.range.startCharacter,
              endLine: response.range.endLine,
              endCharacter: response.range.endCharacter,
            } : undefined,
          });
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Find where a symbol is defined.
   *
   * @param filePath - Absolute path to the file
   * @param line - Line number (1-based)
   * @param character - Character offset (0-based)
   */
  async lspGoToDefinition(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    return new Promise((resolve, reject) => {
      this.client.lspGoToDefinition({ filePath, line, character }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve(response.locations.map(loc => ({
            uri: loc.uri,
            range: {
              startLine: loc.range?.startLine ?? 0,
              startCharacter: loc.range?.startCharacter ?? 0,
              endLine: loc.range?.endLine ?? 0,
              endCharacter: loc.range?.endCharacter ?? 0,
            },
          })));
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * Find all references to a symbol.
   *
   * @param filePath - Absolute path to the file
   * @param line - Line number (1-based)
   * @param character - Character offset (0-based)
   * @param includeDeclaration - Include the declaration in results (default: true)
   */
  async lspFindReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration: boolean = true
  ): Promise<LspLocation[]> {
    return new Promise((resolve, reject) => {
      this.client.lspFindReferences({ filePath, line, character, includeDeclaration }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          resolve(response.locations.map(loc => ({
            uri: loc.uri,
            range: {
              startLine: loc.range?.startLine ?? 0,
              startCharacter: loc.range?.startCharacter ?? 0,
              endLine: loc.range?.endLine ?? 0,
              endCharacter: loc.range?.endCharacter ?? 0,
            },
          })));
        } else {
          reject(new Error('No response received'));
        }
      });
    });
  }

  /**
   * List all symbols in a document.
   *
   * @param filePath - Absolute path to the file
   */
  async lspDocumentSymbol(filePath: string): Promise<LspDocumentSymbol[]> {
    return new Promise((resolve, reject) => {
      this.client.lspDocumentSymbol({ filePath }, (error, response) => {
        if (error) {
          reject(error);
        } else if (response) {
          // Convert proto symbols to client types (recursive)
          function convertSymbol(s: {
            name: string;
            kind: LspSymbolKind;
            detail: string;
            range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
            selectionRange?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
            children: unknown[];
          }): LspDocumentSymbol {
            return {
              name: s.name,
              kind: s.kind,
              detail: s.detail,
              range: {
                startLine: s.range?.startLine ?? 0,
                startCharacter: s.range?.startCharacter ?? 0,
                endLine: s.range?.endLine ?? 0,
                endCharacter: s.range?.endCharacter ?? 0,
              },
              selectionRange: {
                startLine: s.selectionRange?.startLine ?? 0,
                startCharacter: s.selectionRange?.startCharacter ?? 0,
                endLine: s.selectionRange?.endLine ?? 0,
                endCharacter: s.selectionRange?.endCharacter ?? 0,
              },
              children: s.children.map(c => convertSymbol(c as typeof s)),
            };
          }

          resolve(response.symbols.map(convertSymbol));
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
  ExecuteTestRequest,
  ExecuteTestResponse,
};

export { ExecutionState, LspSymbolKind };

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
