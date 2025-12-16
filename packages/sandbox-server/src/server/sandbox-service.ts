import * as grpc from '@grpc/grpc-js';
import type {
  SandboxServiceServer,
  ExecuteRequest,
  ExecuteResponse,
  ExecuteChunk,
  ExecuteAsyncResponse,
  GetExecutionRequest,
  GetExecutionResponse,
  CancelExecutionRequest,
  CancelExecutionResponse,
  ListExecutionsRequest,
  ListExecutionsResponse,
  HealthCheckRequest,
  HealthCheckResponse,
  ListCacheRequest,
  ListCacheResponse,
  ClearCacheRequest,
  ClearCacheResponse,
  ExecutionState,
} from '../generated/sandbox.js';
import { Executor } from './executor.js';
import { CacheManager } from './cache-manager.js';
import { ExecutionRegistry } from './execution-registry.js';

export interface SandboxServiceConfig {
  prometheusUrl?: string;
  cacheDir?: string;
}

/**
 * Map internal execution state to proto ExecutionState.
 */
function toProtoState(state: ExecutionState): ExecutionState {
  return state;
}

/**
 * Map streaming execution result to proto ExecutionState.
 */
function resultToState(result: { success: boolean; cancelled: boolean; timedOut: boolean }): ExecutionState {
  if (result.cancelled) return 5; // EXECUTION_STATE_CANCELLED
  if (result.timedOut) return 6;  // EXECUTION_STATE_TIMEOUT
  if (result.success) return 3;   // EXECUTION_STATE_COMPLETED
  return 4;                       // EXECUTION_STATE_FAILED
}

/**
 * Create the gRPC service handlers for SandboxService.
 */
export function createSandboxService(config: SandboxServiceConfig = {}): SandboxServiceServer {
  const executor = new Executor({ prometheusUrl: config.prometheusUrl });
  const cacheManager = new CacheManager({ cacheDir: config.cacheDir });
  const executionRegistry = new ExecutionRegistry();

  /**
   * Resolve code from request (either direct code or cached script).
   */
  function resolveCode(request: ExecuteRequest): { code: string; isCached: boolean; cachedName?: string } | { error: string } {
    if (request.source?.$case === 'code') {
      return { code: request.source.code, isCached: false };
    } else if (request.source?.$case === 'cached') {
      const cached = cacheManager.find(request.source.cached);
      if (!cached) {
        return { error: `Cached "${request.source.cached}" not found` };
      }
      return { code: cached.code, isCached: true, cachedName: cached.filename };
    }
    return { error: 'Either code or cached must be provided' };
  }

  return {
    // =========================================================================
    // Execute (blocking, waits for completion)
    // =========================================================================
    execute: async (
      call: grpc.ServerUnaryCall<ExecuteRequest, ExecuteResponse>,
      callback: grpc.sendUnaryData<ExecuteResponse>
    ) => {
      const request = call.request;
      const timeoutMs = request.timeoutMs ?? 30000;

      const resolved = resolveCode(request);
      if ('error' in resolved) {
        callback(null, {
          success: false,
          output: '',
          error: resolved.error,
          executionTimeMs: '0',
          cached: undefined,
        });
        return;
      }

      const { code, isCached, cachedName } = resolved;

      // Execute the code
      const result = await executor.execute(code, timeoutMs);

      // Cache successful new executions
      let cacheEntry = undefined;
      if (result.success && !isCached) {
        cacheEntry = await cacheManager.cache(code);
      }

      callback(null, {
        success: result.success,
        output: result.output,
        error: result.error,
        executionTimeMs: String(result.executionTimeMs),
        cached: cacheEntry,
      });
    },

    // =========================================================================
    // ExecuteStream (streaming output)
    // =========================================================================
    executeStream: async (
      call: grpc.ServerWritableStream<ExecuteRequest, ExecuteChunk>
    ) => {
      const request = call.request;
      const timeoutMs = request.timeoutMs ?? 30000;

      const resolved = resolveCode(request);
      if ('error' in resolved) {
        // Send error result and end
        const chunk: ExecuteChunk = {
          executionId: '',
          chunk: {
            $case: 'result',
            result: {
              success: false,
              error: resolved.error,
              executionTimeMs: '0',
              state: 4, // FAILED
              cached: undefined,
            },
          },
          timestampMs: String(Date.now()),
        };
        call.write(chunk);
        call.end();
        return;
      }

      const { code, isCached, cachedName } = resolved;

      // Create execution entry for tracking
      const execution = executionRegistry.create({
        code,
        timeoutMs,
        isCached,
        cachedName,
      });

      // Set to running
      executionRegistry.setState(execution.id, 2); // RUNNING

      // Execute with streaming output
      const result = await executor.executeStreaming({
        code,
        timeoutMs,
        signal: execution.abortController.signal,
        onOutput: (output, isError) => {
          const chunk: ExecuteChunk = {
            executionId: execution.id,
            chunk: isError
              ? { $case: 'errorOutput', errorOutput: output }
              : { $case: 'output', output },
            timestampMs: String(Date.now()),
          };
          call.write(chunk);
        },
      });

      // Cache successful new executions
      let cacheEntry = undefined;
      if (result.success && !isCached) {
        cacheEntry = await cacheManager.cache(code);
      }

      // Send final result
      const finalState = resultToState(result);
      const resultChunk: ExecuteChunk = {
        executionId: execution.id,
        chunk: {
          $case: 'result',
          result: {
            success: result.success,
            error: result.error,
            executionTimeMs: String(result.executionTimeMs),
            state: finalState,
            cached: cacheEntry,
          },
        },
        timestampMs: String(Date.now()),
      };

      // Update registry
      executionRegistry.setResult(execution.id, {
        success: result.success,
        error: result.error,
        executionTimeMs: result.executionTimeMs,
        state: finalState,
        cached: cacheEntry,
      });

      call.write(resultChunk);
      call.end();
    },

    // =========================================================================
    // ExecuteAsync (start and return immediately)
    // =========================================================================
    executeAsync: async (
      call: grpc.ServerUnaryCall<ExecuteRequest, ExecuteAsyncResponse>,
      callback: grpc.sendUnaryData<ExecuteAsyncResponse>
    ) => {
      const request = call.request;
      const timeoutMs = request.timeoutMs ?? 30000;

      const resolved = resolveCode(request);
      if ('error' in resolved) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: resolved.error,
        });
        return;
      }

      const { code, isCached, cachedName } = resolved;

      // Create execution entry
      const execution = executionRegistry.create({
        code,
        timeoutMs,
        isCached,
        cachedName,
      });

      // Return immediately with execution ID
      callback(null, {
        executionId: execution.id,
        state: 1, // PENDING
      });

      // Start execution in background
      executionRegistry.setState(execution.id, 2); // RUNNING

      // Defer actual execution to a later turn of the event loop so the gRPC response
      // can be flushed before any expensive work (TypeScript transform, module preload, etc).
      setTimeout(() => {
        executor.executeStreaming({
          code,
          timeoutMs,
          signal: execution.abortController.signal,
          onOutput: (output, isError) => {
            executionRegistry.appendOutput(execution.id, output, isError);
          },
        }).then(async (result) => {
          // Cache successful new executions
          let cacheEntry = undefined;
          if (result.success && !isCached) {
            cacheEntry = await cacheManager.cache(code);
          }

          const finalState = resultToState(result);
          executionRegistry.setResult(execution.id, {
            success: result.success,
            error: result.error,
            executionTimeMs: result.executionTimeMs,
            state: finalState,
            cached: cacheEntry,
          });
        });
      }, 0);
    },

    // =========================================================================
    // GetExecution (get status and output)
    // =========================================================================
    getExecution: async (
      call: grpc.ServerUnaryCall<GetExecutionRequest, GetExecutionResponse>,
      callback: grpc.sendUnaryData<GetExecutionResponse>
    ) => {
      const { executionId, wait, outputOffset } = call.request;

      const execution = executionRegistry.get(executionId);
      if (!execution) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: `Execution "${executionId}" not found`,
        });
        return;
      }

      // If wait is requested and not finished, wait for completion
      if (wait && !executionRegistry.isTerminalState(execution.state)) {
        await new Promise<void>((resolve) => {
          const removeListener = executionRegistry.addOutputListener(executionId, (chunk) => {
            if (chunk.type === 'result') {
              removeListener();
              resolve();
            }
          });
        });
      }

      // Get output from offset
      const offset = Number(outputOffset) || 0;
      const output = execution.output.slice(offset);
      const errorOutput = execution.errorOutput.slice(offset);

      callback(null, {
        executionId,
        state: toProtoState(execution.state),
        output,
        errorOutput,
        outputLength: String(execution.output.length),
        errorOutputLength: String(execution.errorOutput.length),
        result: execution.result ? {
          success: execution.result.success,
          error: execution.result.error,
          executionTimeMs: String(execution.result.executionTimeMs),
          state: execution.result.state,
          cached: execution.result.cached,
        } : undefined,
      });
    },

    // =========================================================================
    // CancelExecution
    // =========================================================================
    cancelExecution: async (
      call: grpc.ServerUnaryCall<CancelExecutionRequest, CancelExecutionResponse>,
      callback: grpc.sendUnaryData<CancelExecutionResponse>
    ) => {
      const { executionId } = call.request;

      const execution = executionRegistry.get(executionId);
      if (!execution) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: `Execution "${executionId}" not found`,
        });
        return;
      }

      if (executionRegistry.isTerminalState(execution.state)) {
        callback(null, {
          success: false,
          state: toProtoState(execution.state),
          message: 'Execution already finished',
        });
        return;
      }

      const cancelled = executionRegistry.cancel(executionId);

      callback(null, {
        success: cancelled,
        state: 5, // CANCELLED
        message: cancelled ? undefined : 'Failed to cancel execution',
      });
    },

    // =========================================================================
    // ListExecutions
    // =========================================================================
    listExecutions: async (
      call: grpc.ServerUnaryCall<ListExecutionsRequest, ListExecutionsResponse>,
      callback: grpc.sendUnaryData<ListExecutionsResponse>
    ) => {
      const { states, limit, includeCompletedWithinMs } = call.request;

      const executions = executionRegistry.list({
        states: states.length > 0 ? states : undefined,
        limit: limit || 100,
        includeCompletedWithinMs: Number(includeCompletedWithinMs) || undefined,
      });

      callback(null, {
        executions: executions.map((e) => ({
          executionId: e.id,
          state: toProtoState(e.state),
          startedAtMs: String(e.startedAtMs),
          finishedAtMs: e.finishedAtMs ? String(e.finishedAtMs) : undefined,
          codePreview: e.code.slice(0, 100),
          isCached: e.isCached,
          cachedName: e.cachedName,
        })),
      });
    },

    // =========================================================================
    // HealthCheck
    // =========================================================================
    healthCheck: async (
      _call: grpc.ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
      callback: grpc.sendUnaryData<HealthCheckResponse>
    ) => {
      callback(null, {
        healthy: true,
        kubernetesContext: executor.getKubernetesContext(),
      });
    },

    // =========================================================================
    // ListCache
    // =========================================================================
    listCache: async (
      call: grpc.ServerUnaryCall<ListCacheRequest, ListCacheResponse>,
      callback: grpc.sendUnaryData<ListCacheResponse>
    ) => {
      const entries = cacheManager.list(call.request.filter);
      callback(null, { entries });
    },

    // =========================================================================
    // ClearCache
    // =========================================================================
    clearCache: async (
      _call: grpc.ServerUnaryCall<ClearCacheRequest, ClearCacheResponse>,
      callback: grpc.sendUnaryData<ClearCacheResponse>
    ) => {
      const deleted = cacheManager.clear();
      callback(null, { deletedCount: String(deleted) });
    },
  };
}
