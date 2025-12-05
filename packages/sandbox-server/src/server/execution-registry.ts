import { randomUUID } from 'node:crypto';
import type { CacheEntry, ExecutionState } from '../generated/sandbox.js';

/**
 * Represents an active or recently completed execution.
 */
export interface Execution {
  id: string;
  state: ExecutionState;
  code: string;
  isCached: boolean;
  cachedName?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  timeoutMs: number;

  // Output buffers
  output: string;
  errorOutput: string;

  // Result (set when execution completes)
  result?: ExecutionResult;

  // Cancellation
  abortController: AbortController;

  // Streaming listeners
  outputListeners: Set<OutputListener>;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
  executionTimeMs: number;
  state: ExecutionState;
  cached?: CacheEntry;
}

export type OutputListener = (chunk: OutputChunk) => void;

export interface OutputChunk {
  type: 'output' | 'error' | 'result';
  data: string | ExecutionResult;
  timestampMs: number;
}

export interface ExecutionFilter {
  states?: ExecutionState[];
  limit?: number;
  includeCompletedWithinMs?: number;
}

/**
 * ExecutionRegistry manages active and recently completed executions.
 * It provides tracking, output buffering, and cancellation support.
 */
export class ExecutionRegistry {
  private executions = new Map<string, Execution>();

  // How long to keep completed executions (5 minutes)
  private readonly completedRetentionMs = 5 * 60 * 1000;

  // Periodic cleanup interval
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor() {
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Create a new execution entry.
   */
  create(params: {
    code: string;
    timeoutMs: number;
    isCached: boolean;
    cachedName?: string;
  }): Execution {
    const id = randomUUID();
    const execution: Execution = {
      id,
      state: 1, // EXECUTION_STATE_PENDING
      code: params.code,
      isCached: params.isCached,
      cachedName: params.cachedName,
      startedAtMs: Date.now(),
      timeoutMs: params.timeoutMs,
      output: '',
      errorOutput: '',
      abortController: new AbortController(),
      outputListeners: new Set(),
    };

    this.executions.set(id, execution);
    return execution;
  }

  /**
   * Get an execution by ID.
   */
  get(id: string): Execution | undefined {
    return this.executions.get(id);
  }

  /**
   * Update execution state.
   */
  setState(id: string, state: ExecutionState): void {
    const execution = this.executions.get(id);
    if (execution) {
      execution.state = state;
      if (this.isTerminalState(state)) {
        execution.finishedAtMs = Date.now();
      }
    }
  }

  /**
   * Append output to an execution.
   */
  appendOutput(id: string, output: string, isError = false): void {
    const execution = this.executions.get(id);
    if (!execution) return;

    const chunk: OutputChunk = {
      type: isError ? 'error' : 'output',
      data: output,
      timestampMs: Date.now(),
    };

    if (isError) {
      execution.errorOutput += output;
    } else {
      execution.output += output;
    }

    // Notify listeners
    for (const listener of execution.outputListeners) {
      try {
        listener(chunk);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Set the final result of an execution.
   */
  setResult(id: string, result: ExecutionResult): void {
    const execution = this.executions.get(id);
    if (!execution) return;

    execution.result = result;
    execution.state = result.state;
    execution.finishedAtMs = Date.now();

    const chunk: OutputChunk = {
      type: 'result',
      data: result,
      timestampMs: Date.now(),
    };

    // Notify listeners
    for (const listener of execution.outputListeners) {
      try {
        listener(chunk);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Add an output listener for streaming.
   */
  addOutputListener(id: string, listener: OutputListener): () => void {
    const execution = this.executions.get(id);
    if (!execution) {
      return () => {};
    }

    execution.outputListeners.add(listener);

    return () => {
      execution.outputListeners.delete(listener);
    };
  }

  /**
   * Cancel an execution.
   */
  cancel(id: string): boolean {
    const execution = this.executions.get(id);
    if (!execution) return false;

    if (this.isTerminalState(execution.state)) {
      return false; // Already finished
    }

    execution.abortController.abort();
    execution.state = 5; // EXECUTION_STATE_CANCELLED
    execution.finishedAtMs = Date.now();

    return true;
  }

  /**
   * List executions matching filter.
   */
  list(filter: ExecutionFilter = {}): Execution[] {
    const now = Date.now();
    const results: Execution[] = [];

    for (const execution of this.executions.values()) {
      // Filter by state
      if (filter.states && filter.states.length > 0) {
        if (!filter.states.includes(execution.state)) {
          continue;
        }
      }

      // Filter out old completed executions
      if (filter.includeCompletedWithinMs !== undefined &&
          this.isTerminalState(execution.state) &&
          execution.finishedAtMs) {
        if (now - execution.finishedAtMs > filter.includeCompletedWithinMs) {
          continue;
        }
      }

      results.push(execution);

      // Apply limit
      if (filter.limit && results.length >= filter.limit) {
        break;
      }
    }

    // Sort by started time (newest first)
    results.sort((a, b) => b.startedAtMs - a.startedAtMs);

    return results;
  }

  /**
   * Check if a state is terminal (execution finished).
   */
  isTerminalState(state: ExecutionState): boolean {
    return state === 3 || // COMPLETED
           state === 4 || // FAILED
           state === 5 || // CANCELLED
           state === 6;   // TIMEOUT
  }

  /**
   * Clean up old completed executions.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, execution] of this.executions) {
      if (this.isTerminalState(execution.state) && execution.finishedAtMs) {
        if (now - execution.finishedAtMs > this.completedRetentionMs) {
          this.executions.delete(id);
        }
      }
    }
  }

  /**
   * Stop the registry (cleanup interval).
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
}
