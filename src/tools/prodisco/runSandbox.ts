import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from '../types.js';
import { getSandboxClient, ExecutionState, type SandboxClient } from '@prodisco/sandbox-server/client';
import { searchToolsService } from './searchTools.js';
import { DEFAULT_LIBRARIES_CONFIG, type LibrarySpec } from '../../config/libraries.js';

export type SandboxClientResolver = (sessionId?: string) => SandboxClient | Promise<SandboxClient>;

// ============================================================================
// Schema Definition
// ============================================================================

const RunSandboxInputSchema = z.object({
  // Mode selection - determines which operation to perform
  mode: z
    .enum(['execute', 'stream', 'async', 'status', 'cancel', 'list', 'test'])
    .default('execute')
    .optional()
    .describe(
      'Execution mode: ' +
      '"execute" (default) - blocking execution, waits for completion; ' +
      '"stream" - real-time output streaming; ' +
      '"async" - start execution and return immediately with execution ID; ' +
      '"status" - get status and output of an async execution; ' +
      '"cancel" - cancel a running execution; ' +
      '"list" - list active and recent executions; ' +
      '"test" - run tests using uvu framework with structured results'
    ),

  // === Execute/Stream/Async mode parameters ===
  code: z.string().optional()
    .describe('(execute/stream/async mode) TypeScript code to execute'),
  cached: z.string().optional()
    .describe('(execute/stream/async mode) Name of a cached script to execute (from searchTools results)'),
  scriptName: z.string().optional()
    .describe('(execute/stream/async mode) **REQUIRED for caching**. Name for the script (e.g., "list-pods", "get-etcd-details"). Use descriptive kebab-case names. Scripts without scriptName are NOT cached.'),
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

  // === Test mode parameters ===
  tests: z.string().optional()
    .describe('(test mode) Test code using pre-injected test() and assert. IMPORTANT: Do NOT import test/assert, do NOT call test.run() - they are already provided. Example: test("adds numbers", () => { assert.is(add(1,2), 3); }); Available: assert.is(a,b), assert.ok(val), assert.equal(obj1,obj2), assert.not(val), assert.throws(fn)'),
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
  // Output metadata
  outputLineCount: number;
  outputCharCount: number;
  truncated: boolean;
  truncatedMessage?: string;
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
  // Output metadata
  outputLineCount: number;
  outputCharCount: number;
  truncated: boolean;
  truncatedMessage?: string;
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
    // Output metadata
    outputLineCount: number;
    outputCharCount: number;
    truncated: boolean;
    truncatedMessage?: string;
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

// Result type for test mode (run tests)
type TestModeResult = {
  mode: 'test';
  success: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  tests: Array<{
    name: string;
    passed: boolean;
    error?: string;
    durationMs: number;
  }>;
  output: string;
  executionTimeMs: number;
  error?: string;
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
  | TestModeResult
  | ErrorResult;

// ============================================================================
// Mode Execution Functions
// ============================================================================

/**
 * Format a truncation message for user feedback.
 */
function formatTruncationMessage(truncatedAt?: { lines: number; chars: number }): string {
  if (truncatedAt) {
    const lines = truncatedAt.lines;
    const chars = truncatedAt.chars;
    const kbSize = Math.round(chars / 1024);
    return `Output truncated at ${lines} lines / ${kbSize}KB. Use streaming mode with outputOffset for incremental reads.`;
  }
  return 'Output truncated. Use streaming mode with outputOffset for incremental reads.';
}

/**
 * Execute mode - blocking execution, waits for completion
 */
async function executeExecuteMode(
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
): Promise<ExecuteModeResult | ErrorResult> {
  const { code, cached, scriptName, timeout = 30000 } = input;

  if (!code && !cached) {
    return {
      mode: 'execute',
      success: false,
      error: 'Either "code" or "cached" must be provided for execute mode',
    };
  }

  try {
    const client = await resolveClient(sessionId);

    const result = await client.execute({
      code,
      cached,
      scriptName,
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
      outputLineCount: result.outputLineCount,
      outputCharCount: result.outputCharCount,
      truncated: result.truncated,
      truncatedMessage: result.truncated ? formatTruncationMessage(result.truncatedAt) : undefined,
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
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
): Promise<StreamModeResult | ErrorResult> {
  const { code, cached, scriptName, timeout = 30000 } = input;

  if (!code && !cached) {
    return {
      mode: 'stream',
      success: false,
      error: 'Either "code" or "cached" must be provided for stream mode',
    };
  }

  try {
    const client = await resolveClient(sessionId);

    let output = '';
    let errorOutput = '';
    let executionId = '';
    let finalResult: StreamModeResult | null = null;

    for await (const chunk of client.executeStream({
      code,
      cached,
      scriptName,
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
          outputLineCount: number;
          outputCharCount: number;
          truncated: boolean;
          truncatedAt?: { lines: number; chars: number };
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
          outputLineCount: resultData.outputLineCount,
          outputCharCount: resultData.outputCharCount,
          truncated: resultData.truncated,
          truncatedMessage: resultData.truncated ? formatTruncationMessage(resultData.truncatedAt) : undefined,
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
      outputLineCount: 0,
      outputCharCount: 0,
      truncated: false,
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
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
): Promise<AsyncModeResult | ErrorResult> {
  const { code, cached, scriptName, timeout = 30000 } = input;

  if (!code && !cached) {
    return {
      mode: 'async',
      success: false,
      error: 'Either "code" or "cached" must be provided for async mode',
    };
  }

  try {
    const client = await resolveClient(sessionId);

    const result = await client.executeAsync({
      code,
      cached,
      scriptName,
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
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
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
    const client = await resolveClient(sessionId);

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
        outputLineCount: status.result.outputLineCount,
        outputCharCount: status.result.outputCharCount,
        truncated: status.result.truncated,
        truncatedMessage: status.result.truncated ? formatTruncationMessage(status.result.truncatedAt) : undefined,
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
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
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
    const client = await resolveClient(sessionId);

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
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
): Promise<ListModeResult | ErrorResult> {
  const { states, limit = 10, includeCompletedWithinMs } = input;

  try {
    const client = await resolveClient(sessionId);

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

/**
 * Test mode - run tests using uvu framework
 */
async function executeTestMode(
  input: z.infer<typeof RunSandboxInputSchema>,
  resolveClient: SandboxClientResolver,
  sessionId?: string,
): Promise<TestModeResult | ErrorResult> {
  const { code, tests, timeout = 30000 } = input;

  if (!tests) {
    return {
      mode: 'test',
      success: false,
      error: '"tests" parameter is required for test mode',
    };
  }

  try {
    const client = await resolveClient(sessionId);

    const result = await client.executeTest({
      code,
      tests,
      timeoutMs: timeout,
    });

    return {
      mode: 'test',
      success: result.success,
      summary: result.summary,
      tests: result.tests,
      output: result.output,
      executionTimeMs: result.executionTimeMs,
      error: result.error,
    };
  } catch (error) {
    return {
      mode: 'test',
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
  enableApps?: boolean;
  /** Function to resolve the SandboxClient for a given session. Falls back to getSandboxClient() singleton. */
  getClient?: SandboxClientResolver;
};

function formatAllowedImportsForDescription(libraries: LibrarySpec[]): string {
  const lines: string[] = [];
  for (const lib of libraries) {
    // Format: library name on first line, description indented below if multi-line
    const requireLine = `- require("${lib.name}")`;
    if (lib.description) {
      const descriptionLines = lib.description.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (descriptionLines.length === 1) {
        // Single line description - put inline
        lines.push(`${requireLine} - ${descriptionLines[0]}`);
      } else {
        // Multi-line description - put below with indentation
        lines.push(requireLine);
        for (const descLine of descriptionLines) {
          lines.push(`  ${descLine}`);
        }
      }
    } else {
      lines.push(requireLine);
    }
  }

  return lines.join('\n');
}

export function createRunSandboxTool(runtimeConfig: RunSandboxRuntimeConfig) {
  const allowedImports = formatAllowedImportsForDescription(runtimeConfig.libraries);

  const appsOutputGuidance = runtimeConfig.enableApps
    ? '\n\n' +
      '**OUTPUT FORMAT (UI rendering)**: Results are rendered in a rich UI. The format is auto-detected from stdout:\n' +
      '• **Table**: Output a JSON array of flat objects → rendered as a sortable, interactive table. Example: `console.log(JSON.stringify([{ name: "pod-a", status: "Running", restarts: 0 }, ...]))`\n' +
      '• **Chart**: Output a JSON array (3+ items) where objects have a timestamp key (`timestamp`, `time`, `date`, `ts`, `datetime`, `created_at`, `updated_at`) and numeric value fields → rendered as an interactive line chart with zoom (mouse wheel/pinch), pan (click-drag), and a query input for requesting new metrics. Example: `console.log(JSON.stringify([{ timestamp: 1700000000, cpu: 45.2, memory: 72.1 }, ...]))`\n' +
      '• **Terminal**: Any non-JSON output renders as plain text in a terminal.\n' +
      'To get table/chart rendering, the ENTIRE stdout must be a single valid JSON array — do not mix `console.log` text with JSON. ' +
      'Prefer structured JSON output over verbose formatted text whenever the data is tabular or time-series.\n' +
      '• **Interactive Table**: Output a JSON object with `_interactive` metadata and `rows` array → rendered as a clickable table. ' +
      'Clicking an identifier cell sends a message to the agent to show available actions. ' +
      'Example: `console.log(JSON.stringify({ _interactive: { type: "table", kind: "Pod", identifiers: ["name"] }, rows: [{ name: "api-xyz", namespace: "default", status: "Running" }] }))`\n' +
      '• **Interactive Actions**: Output a JSON object with `_interactive` metadata and `actions` array → rendered as an action button panel. ' +
      'Clicking a button sends a message to the agent to execute the action. ' +
      'Example: `console.log(JSON.stringify({ _interactive: { type: "actions", kind: "Pod", resource: { name: "api-xyz", namespace: "default" } }, actions: [{ id: "describe", label: "Describe", description: "Show full spec" }, { id: "delete", label: "Delete", destructive: true }] }))`'
    : '';

  return {
    name: 'prodisco_runSandbox',
    description:
      '**PREREQUISITE: Call searchTools first** to discover correct API methods and parameters. ' +
      'Do NOT guess - search to find available APIs before writing code. ' +
      '\n\n' +
      'Execute TypeScript code in a sandboxed environment. ' +
      '\n\n' +
      '**IMPORTANT**: When executing new code, ALWAYS provide a `scriptName` to cache the script for future reuse. ' +
      'Use descriptive kebab-case names (e.g., "list-pods", "get-etcd-details", "check-node-resources"). ' +
      'Scripts are only cached when scriptName is provided.' +
      '\n\n' +
      '**BEST PRACTICE**: When writing complex logic, data transformations, or code you are uncertain about, ' +
      'use `mode: "test"` first to validate your implementation with unit tests before running in production. ' +
      'This helps catch bugs early and ensures correctness. ' +
      '\n\n' +
      'MODES: ' +
      '• execute (default): Blocking execution, waits for completion. Params: code OR cached (required), scriptName (required for caching), timeout. ' +
      '• stream: Real-time output streaming. Params: code OR cached (required), scriptName (required for caching), timeout. ' +
      '• async: Start execution and return immediately with execution ID. Params: code OR cached (required), scriptName (required for caching), timeout. ' +
      '• status: Get status of async execution. Params: executionId (required), wait (optional). ' +
      '• cancel: Cancel a running execution. Params: executionId (required). ' +
      '• list: List active/recent executions. Params: states (optional), limit (optional). ' +
      '• test: Run unit tests with structured results. Params: tests (required), code (optional implementation to test), timeout. ' +
      'CRITICAL: test() and assert are pre-injected globals - do NOT import them, do NOT call test.run(). ' +
      'Just write: test("name", () => { assert.is(actual, expected); }); ' +
      'Available assertions: assert.is(a,b), assert.ok(val), assert.equal(obj1,obj2), assert.not(val), assert.throws(fn). ' +
      '\n\n' +
      'Sandbox provides console + process.env and restricts require() to an allowlist.\n' +
      'ALLOWED IMPORTS:\n' +
      allowedImports +
      appsOutputGuidance,
    schema: RunSandboxInputSchema,

    async execute(input: z.infer<typeof RunSandboxInputSchema>, context?: ToolExecutionContext) {
      const { mode = 'execute' } = input;
      const resolveClient: SandboxClientResolver = runtimeConfig.getClient ?? (() => getSandboxClient());
      const sessionId = context?.sessionId;

      switch (mode) {
        case 'execute':
          return executeExecuteMode(input, resolveClient, sessionId);
        case 'stream':
          return executeStreamMode(input, resolveClient, sessionId);
        case 'async':
          return executeAsyncMode(input, resolveClient, sessionId);
        case 'status':
          return executeStatusMode(input, resolveClient, sessionId);
        case 'cancel':
          return executeCancelMode(input, resolveClient, sessionId);
        case 'list':
          return executeListMode(input, resolveClient, sessionId);
        case 'test':
          return executeTestMode(input, resolveClient, sessionId);
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
