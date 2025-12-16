import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getSandboxClient, ExecutionState } from '@prodisco/sandbox-server/client';
import { searchToolsService } from './searchTools.js';
import { DEFAULT_LIBRARIES_CONFIG, type LibrarySpec } from '../../config/libraries.js';

// ============================================================================
// Schema Definition
// ============================================================================

const RunSandboxInputSchema = z.object({
  // Mode selection - determines which operation to perform
  mode: z
    .enum(['execute', 'stream', 'async', 'status', 'cancel', 'list'])
    .default('execute')
    .optional()
    .describe(
      'Execution mode: ' +
      '"execute" (default) - blocking execution, waits for completion; ' +
      '"stream" - real-time output streaming; ' +
      '"async" - start execution and return immediately with execution ID; ' +
      '"status" - get status and output of an async execution; ' +
      '"cancel" - cancel a running execution; ' +
      '"list" - list active and recent executions'
    ),

  // === Execute/Stream/Async mode parameters ===
  code: z.string().optional()
    .describe('(execute/stream/async mode) TypeScript code to execute'),
  cached: z.string().optional()
    .describe('(execute/stream/async mode) Name of a cached script to execute (from searchTools results)'),
  timeout: z.number().int().positive().max(120000).default(30000).optional()
    .describe('(execute/stream/async mode) Execution timeout in milliseconds (default: 30000, max: 120000)'),

  // === Status mode parameters ===
  executionId: z.string().optional()
    .describe('(status/cancel mode) Execution ID from async mode response'),
  wait: z.boolean().optional()
    .describe('(status mode) If true, wait for completion (long-poll)'),
  outputOffset: z.number().int().nonnegative().optional()
    .describe('(status mode) Offset in output buffer for incremental reads'),

  // === List mode parameters ===
  states: z.array(z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'timeout'])).optional()
    .describe('(list mode) Filter by execution states'),
  limit: z.number().int().positive().max(100).default(10).optional()
    .describe('(list mode) Maximum number of results'),
  includeCompletedWithinMs: z.number().int().nonnegative().optional()
    .describe('(list mode) Include completed executions from last N milliseconds'),
});

// ============================================================================
// Result Types
// ============================================================================

/** Helper to convert ExecutionState enum to string */
function stateToString(state: ExecutionState): string {
  switch (state) {
    case ExecutionState.EXECUTION_STATE_PENDING: return 'pending';
    case ExecutionState.EXECUTION_STATE_RUNNING: return 'running';
    case ExecutionState.EXECUTION_STATE_COMPLETED: return 'completed';
    case ExecutionState.EXECUTION_STATE_FAILED: return 'failed';
    case ExecutionState.EXECUTION_STATE_CANCELLED: return 'cancelled';
    case ExecutionState.EXECUTION_STATE_TIMEOUT: return 'timeout';
    default: return 'unknown';
  }
}

/** Helper to convert string state to ExecutionState enum */
function stringToState(state: string): ExecutionState {
  switch (state) {
    case 'pending': return ExecutionState.EXECUTION_STATE_PENDING;
    case 'running': return ExecutionState.EXECUTION_STATE_RUNNING;
    case 'completed': return ExecutionState.EXECUTION_STATE_COMPLETED;
    case 'failed': return ExecutionState.EXECUTION_STATE_FAILED;
    case 'cancelled': return ExecutionState.EXECUTION_STATE_CANCELLED;
    case 'timeout': return ExecutionState.EXECUTION_STATE_TIMEOUT;
    default: return ExecutionState.EXECUTION_STATE_UNSPECIFIED;
  }
}

// Result type for execute mode (blocking execution)
type ExecuteModeResult = {
  mode: 'execute';
  success: boolean;
  output: string;
  error?: string;
  executionTimeMs: number;
  cachedScript?: string;
  cached?: {
    name: string;
    description: string;
    createdAtMs: number;
    contentHash: string;
  };
};

// Result type for stream mode (streaming execution)
type StreamModeResult = {
  mode: 'stream';
  success: boolean;
  output: string;
  errorOutput: string;
  error?: string;
  executionTimeMs: number;
  executionId: string;
  state: string;
  cached?: {
    name: string;
    description: string;
    createdAtMs: number;
    contentHash: string;
  };
};

// Result type for async mode (start async execution)
type AsyncModeResult = {
  mode: 'async';
  executionId: string;
  state: string;
  message: string;
};

// Result type for status mode (get execution status)
type StatusModeResult = {
  mode: 'status';
  executionId: string;
  state: string;
  output: string;
  errorOutput: string;
  outputLength: number;
  errorOutputLength: number;
  result?: {
    success: boolean;
    error?: string;
    executionTimeMs: number;
    cached?: {
      name: string;
      description: string;
      createdAtMs: number;
      contentHash: string;
    };
  };
};

// Result type for cancel mode (cancel execution)
type CancelModeResult = {
  mode: 'cancel';
  success: boolean;
  executionId: string;
  state: string;
  message?: string;
};

// Result type for list mode (list executions)
type ListModeResult = {
  mode: 'list';
  executions: Array<{
    executionId: string;
    state: string;
    startedAtMs: number;
    finishedAtMs?: number;
    codePreview: string;
    isCached: boolean;
    cachedName?: string;
  }>;
  totalCount: number;
};

// Error result type
type ErrorResult = {
  mode: string;
  success: false;
  error: string;
};

// Union type for all modes
type RunSandboxResult =
  | ExecuteModeResult
  | StreamModeResult
  | AsyncModeResult
  | StatusModeResult
  | CancelModeResult
  | ListModeResult
  | ErrorResult;

// ============================================================================
// Mode Execution Functions
// ============================================================================

/**
 * Execute mode - blocking execution, waits for completion
 */
async function executeExecuteMode(
  input: z.infer<typeof RunSandboxInputSchema>
): Promise<ExecuteModeResult | ErrorResult> {
  const { code, cached, timeout = 30000 } = input;

  if (!code && !cached) {
    return {
      mode: 'execute',
      success: false,
      error: 'Either "code" or "cached" must be provided for execute mode',
    };
  }

  try {
    const client = getSandboxClient();

    const result = await client.execute({
      code,
      cached,
      timeoutMs: timeout,
    });

    // Index newly cached scripts for searchability using CacheEntry metadata
    if (result.success && result.cached) {
      try {
        await searchToolsService.indexCacheEntry({
          name: result.cached.name,
          description: result.cached.description,
          createdAtMs: result.cached.createdAtMs,
          contentHash: result.cached.contentHash,
        });
      } catch {
        // Silently ignore indexing errors
      }
    }

    return {
      mode: 'execute',
      success: result.success,
      output: result.output,
      error: result.error,
      executionTimeMs: result.executionTimeMs,
      cachedScript: result.cached?.name ?? (cached ? cached : undefined),
      cached: result.cached,
    };
  } catch (error) {
    return {
      mode: 'execute',
      success: false,
      error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Stream mode - real-time output streaming
 * Collects all chunks and returns complete output
 */
async function executeStreamMode(
  input: z.infer<typeof RunSandboxInputSchema>
): Promise<StreamModeResult | ErrorResult> {
  const { code, cached, timeout = 30000 } = input;

  if (!code && !cached) {
    return {
      mode: 'stream',
      success: false,
      error: 'Either "code" or "cached" must be provided for stream mode',
    };
  }

  try {
    const client = getSandboxClient();

    let output = '';
    let errorOutput = '';
    let executionId = '';
    let finalResult: StreamModeResult | null = null;

    for await (const chunk of client.executeStream({
      code,
      cached,
      timeoutMs: timeout,
    })) {
      executionId = chunk.executionId;

      if (chunk.type === 'output') {
        output += chunk.data as string;
      } else if (chunk.type === 'error') {
        errorOutput += chunk.data as string;
      } else if (chunk.type === 'result') {
        const resultData = chunk.data as {
          success: boolean;
          error?: string;
          executionTimeMs: number;
          state: ExecutionState;
          cached?: {
            name: string;
            description: string;
            createdAtMs: number;
            contentHash: string;
          };
        };

        // Index newly cached scripts
        if (resultData.success && resultData.cached) {
          try {
            await searchToolsService.indexCacheEntry({
              name: resultData.cached.name,
              description: resultData.cached.description,
              createdAtMs: resultData.cached.createdAtMs,
              contentHash: resultData.cached.contentHash,
            });
          } catch {
            // Silently ignore indexing errors
          }
        }

        finalResult = {
          mode: 'stream',
          success: resultData.success,
          output,
          errorOutput,
          error: resultData.error,
          executionTimeMs: resultData.executionTimeMs,
          executionId,
          state: stateToString(resultData.state),
          cached: resultData.cached,
        };
      }
    }

    if (finalResult) {
      return finalResult;
    }

    return {
      mode: 'stream',
      success: false,
      output,
      errorOutput,
      error: 'Stream ended without final result',
      executionTimeMs: 0,
      executionId,
      state: 'unknown',
    };
  } catch (error) {
    return {
      mode: 'stream',
      success: false,
      error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Async mode - start execution and return immediately with execution ID
 */
async function executeAsyncMode(
  input: z.infer<typeof RunSandboxInputSchema>
): Promise<AsyncModeResult | ErrorResult> {
  const { code, cached, timeout = 30000 } = input;

  if (!code && !cached) {
    return {
      mode: 'async',
      success: false,
      error: 'Either "code" or "cached" must be provided for async mode',
    };
  }

  try {
    const client = getSandboxClient();

    const result = await client.executeAsync({
      code,
      cached,
      timeoutMs: timeout,
    });

    return {
      mode: 'async',
      executionId: result.executionId,
      state: stateToString(result.state),
      message: `Execution started. Use mode: "status" with executionId: "${result.executionId}" to check progress.`,
    };
  } catch (error) {
    return {
      mode: 'async',
      success: false,
      error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Status mode - get status and output of an async execution
 */
async function executeStatusMode(
  input: z.infer<typeof RunSandboxInputSchema>
): Promise<StatusModeResult | ErrorResult> {
  const { executionId, wait, outputOffset } = input;

  if (!executionId) {
    return {
      mode: 'status',
      success: false,
      error: 'executionId is required for status mode',
    };
  }

  try {
    const client = getSandboxClient();

    const status = await client.getExecution(executionId, {
      wait,
      outputOffset,
    });

    // Index newly cached scripts if execution completed
    if (status.result?.cached) {
      try {
        await searchToolsService.indexCacheEntry({
          name: status.result.cached.name,
          description: status.result.cached.description,
          createdAtMs: status.result.cached.createdAtMs,
          contentHash: status.result.cached.contentHash,
        });
      } catch {
        // Silently ignore indexing errors
      }
    }

    return {
      mode: 'status',
      executionId: status.executionId,
      state: stateToString(status.state),
      output: status.output,
      errorOutput: status.errorOutput,
      outputLength: status.outputLength,
      errorOutputLength: status.errorOutputLength,
      result: status.result ? {
        success: status.result.success,
        error: status.result.error,
        executionTimeMs: status.result.executionTimeMs,
        cached: status.result.cached,
      } : undefined,
    };
  } catch (error) {
    return {
      mode: 'status',
      success: false,
      error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Cancel mode - cancel a running execution
 */
async function executeCancelMode(
  input: z.infer<typeof RunSandboxInputSchema>
): Promise<CancelModeResult | ErrorResult> {
  const { executionId } = input;

  if (!executionId) {
    return {
      mode: 'cancel',
      success: false,
      error: 'executionId is required for cancel mode',
    };
  }

  try {
    const client = getSandboxClient();

    const result = await client.cancelExecution(executionId);

    return {
      mode: 'cancel',
      success: result.success,
      executionId,
      state: stateToString(result.state),
      message: result.message,
    };
  } catch (error) {
    return {
      mode: 'cancel',
      success: false,
      error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * List mode - list active and recent executions
 */
async function executeListMode(
  input: z.infer<typeof RunSandboxInputSchema>
): Promise<ListModeResult | ErrorResult> {
  const { states, limit = 10, includeCompletedWithinMs } = input;

  try {
    const client = getSandboxClient();

    const executions = await client.listExecutions({
      states: states?.map(stringToState),
      limit,
      includeCompletedWithinMs,
    });

    return {
      mode: 'list',
      executions: executions.map(e => ({
        executionId: e.executionId,
        state: stateToString(e.state),
        startedAtMs: e.startedAtMs,
        finishedAtMs: e.finishedAtMs,
        codePreview: e.codePreview,
        isCached: e.isCached,
        cachedName: e.cachedName,
      })),
      totalCount: executions.length,
    };
  } catch (error) {
    return {
      mode: 'list',
      success: false,
      error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export type RunSandboxRuntimeConfig = {
  libraries: LibrarySpec[];
};

function formatAllowedImportsForDescription(libraries: LibrarySpec[]): string {
  const lines: string[] = [];
  for (const lib of libraries) {
    if (lib.name === '@kubernetes/client-node') {
      lines.push(`- require("@kubernetes/client-node")${lib.description ? ` // ${lib.description}` : ''}`);
      continue;
    }
    if (lib.name === '@prodisco/prometheus-client') {
      lines.push(`- require("@prodisco/prometheus-client")${lib.description ? ` // ${lib.description}` : ''}`);
      continue;
    }
    if (lib.name === '@prodisco/loki-client') {
      lines.push(`- require("@prodisco/loki-client")${lib.description ? ` // ${lib.description}` : ''}`);
      continue;
    }
    lines.push(`- require("${lib.name}")${lib.description ? ` // ${lib.description}` : ''}`);
  }

  return lines.join('\n');
}

export function createRunSandboxTool(runtimeConfig: RunSandboxRuntimeConfig) {
  const allowedImports = formatAllowedImportsForDescription(runtimeConfig.libraries);

  return {
    name: 'prodisco.runSandbox',
    description:
      '**PREREQUISITE: Call searchTools first** to discover correct API methods and parameters. ' +
      'Do NOT guess - search to find available APIs before writing code. ' +
      '\n\n' +
      'Execute TypeScript code in a sandboxed environment. ' +
      'MODES: ' +
      '• execute (default): Blocking execution, waits for completion. Params: code OR cached (required), timeout. ' +
      '• stream: Real-time output streaming. Params: code OR cached (required), timeout. ' +
      '• async: Start execution and return immediately with execution ID. Params: code OR cached (required), timeout. ' +
      '• status: Get status of async execution. Params: executionId (required), wait (optional). ' +
      '• cancel: Cancel a running execution. Params: executionId (required). ' +
      '• list: List active/recent executions. Params: states (optional), limit (optional). ' +
      '\n\n' +
      'Sandbox provides console + process.env and restricts require() to an allowlist.\n' +
      'ALLOWED IMPORTS:\n' +
      allowedImports,
    schema: RunSandboxInputSchema,

    async execute(input: z.infer<typeof RunSandboxInputSchema>) {
      const { mode = 'execute' } = input;

      switch (mode) {
        case 'execute':
          return executeExecuteMode(input);
        case 'stream':
          return executeStreamMode(input);
        case 'async':
          return executeAsyncMode(input);
        case 'status':
          return executeStatusMode(input);
        case 'cancel':
          return executeCancelMode(input);
        case 'list':
          return executeListMode(input);
        default:
          return {
            mode: mode as string,
            success: false,
            error: `Unknown mode: ${mode}`,
          };
      }
    },
  } satisfies ToolDefinition<RunSandboxResult, typeof RunSandboxInputSchema>;
}

// Backward-compatible default export (used by tooling/metadata); runtime server should call createRunSandboxTool()
export const runSandboxTool = createRunSandboxTool({
  libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
});
