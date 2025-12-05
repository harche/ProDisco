import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ExecutionRegistry } from '../server/execution-registry.js';
import { ExecutionState } from '../generated/sandbox.js';

describe('ExecutionRegistry', () => {
  let registry: ExecutionRegistry;

  beforeEach(() => {
    registry = new ExecutionRegistry();
  });

  afterEach(() => {
    registry.stop();
  });

  describe('create()', () => {
    it('creates new execution with unique ID', () => {
      const exec1 = registry.create({
        code: 'console.log("test");',
        timeoutMs: 30000,
        isCached: false,
      });

      const exec2 = registry.create({
        code: 'console.log("test2");',
        timeoutMs: 30000,
        isCached: false,
      });

      expect(exec1.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(exec2.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(exec1.id).not.toBe(exec2.id);
    });

    it('initializes with PENDING state', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      expect(exec.state).toBe(ExecutionState.EXECUTION_STATE_PENDING);
    });

    it('initializes with empty output buffers', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      expect(exec.output).toBe('');
      expect(exec.errorOutput).toBe('');
    });

    it('provides AbortController for cancellation', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      expect(exec.abortController).toBeInstanceOf(AbortController);
      expect(exec.abortController.signal.aborted).toBe(false);
    });

    it('tracks cached script info', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: true,
        cachedName: 'my-script.ts',
      });

      expect(exec.isCached).toBe(true);
      expect(exec.cachedName).toBe('my-script.ts');
    });
  });

  describe('get()', () => {
    it('returns execution by ID', () => {
      const created = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      const found = registry.get(created.id);

      expect(found).toBe(created);
    });

    it('returns undefined for unknown ID', () => {
      const found = registry.get('unknown-id');
      expect(found).toBeUndefined();
    });
  });

  describe('setState()', () => {
    it('updates execution state', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.setState(exec.id, ExecutionState.EXECUTION_STATE_RUNNING);

      expect(exec.state).toBe(ExecutionState.EXECUTION_STATE_RUNNING);
    });

    it('sets finishedAtMs for terminal states', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      expect(exec.finishedAtMs).toBeUndefined();

      registry.setState(exec.id, ExecutionState.EXECUTION_STATE_COMPLETED);

      expect(exec.finishedAtMs).toBeDefined();
      expect(exec.finishedAtMs).toBeGreaterThan(0);
    });
  });

  describe('appendOutput()', () => {
    it('appends to output buffer', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.appendOutput(exec.id, 'line 1\n');
      registry.appendOutput(exec.id, 'line 2\n');

      expect(exec.output).toBe('line 1\nline 2\n');
    });

    it('appends to error buffer when isError=true', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.appendOutput(exec.id, 'error message\n', true);

      expect(exec.errorOutput).toBe('error message\n');
      expect(exec.output).toBe('');
    });

    it('notifies listeners', async () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      const chunks: Array<{ type: string; data: string }> = [];

      registry.addOutputListener(exec.id, (chunk) => {
        if (chunk.type === 'output' || chunk.type === 'error') {
          chunks.push({ type: chunk.type, data: chunk.data as string });
        }
      });

      registry.appendOutput(exec.id, 'test output');
      registry.appendOutput(exec.id, 'test error', true);

      expect(chunks.length).toBe(2);
      expect(chunks[0]).toEqual({ type: 'output', data: 'test output' });
      expect(chunks[1]).toEqual({ type: 'error', data: 'test error' });
    });
  });

  describe('setResult()', () => {
    it('sets the final result', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.setResult(exec.id, {
        success: true,
        executionTimeMs: 100,
        state: ExecutionState.EXECUTION_STATE_COMPLETED,
      });

      expect(exec.result).toBeDefined();
      expect(exec.result?.success).toBe(true);
      expect(exec.result?.executionTimeMs).toBe(100);
    });

    it('updates state from result', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.setResult(exec.id, {
        success: false,
        error: 'test error',
        executionTimeMs: 50,
        state: ExecutionState.EXECUTION_STATE_FAILED,
      });

      expect(exec.state).toBe(ExecutionState.EXECUTION_STATE_FAILED);
    });

    it('notifies listeners with result chunk', async () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      let resultChunk: any = null;

      registry.addOutputListener(exec.id, (chunk) => {
        if (chunk.type === 'result') {
          resultChunk = chunk;
        }
      });

      registry.setResult(exec.id, {
        success: true,
        executionTimeMs: 100,
        state: ExecutionState.EXECUTION_STATE_COMPLETED,
      });

      expect(resultChunk).not.toBeNull();
      expect(resultChunk.type).toBe('result');
    });
  });

  describe('addOutputListener()', () => {
    it('returns unsubscribe function', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      let callCount = 0;
      const unsubscribe = registry.addOutputListener(exec.id, () => {
        callCount++;
      });

      registry.appendOutput(exec.id, 'test');
      expect(callCount).toBe(1);

      unsubscribe();

      registry.appendOutput(exec.id, 'test2');
      expect(callCount).toBe(1); // Should not increase
    });

    it('returns no-op for unknown ID', () => {
      const unsubscribe = registry.addOutputListener('unknown', () => {});
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('cancel()', () => {
    it('aborts the execution', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.setState(exec.id, ExecutionState.EXECUTION_STATE_RUNNING);

      const result = registry.cancel(exec.id);

      expect(result).toBe(true);
      expect(exec.abortController.signal.aborted).toBe(true);
      expect(exec.state).toBe(ExecutionState.EXECUTION_STATE_CANCELLED);
    });

    it('returns false for already finished execution', () => {
      const exec = registry.create({
        code: 'test',
        timeoutMs: 30000,
        isCached: false,
      });

      registry.setState(exec.id, ExecutionState.EXECUTION_STATE_COMPLETED);

      const result = registry.cancel(exec.id);

      expect(result).toBe(false);
      expect(exec.state).toBe(ExecutionState.EXECUTION_STATE_COMPLETED);
    });

    it('returns false for unknown ID', () => {
      const result = registry.cancel('unknown');
      expect(result).toBe(false);
    });
  });

  describe('list()', () => {
    it('returns all executions', () => {
      registry.create({ code: 'test1', timeoutMs: 30000, isCached: false });
      registry.create({ code: 'test2', timeoutMs: 30000, isCached: false });
      registry.create({ code: 'test3', timeoutMs: 30000, isCached: false });

      const list = registry.list();

      expect(list.length).toBe(3);
    });

    it('filters by state', () => {
      const exec1 = registry.create({ code: 'test1', timeoutMs: 30000, isCached: false });
      const exec2 = registry.create({ code: 'test2', timeoutMs: 30000, isCached: false });
      const exec3 = registry.create({ code: 'test3', timeoutMs: 30000, isCached: false });

      registry.setState(exec1.id, ExecutionState.EXECUTION_STATE_RUNNING);
      registry.setState(exec2.id, ExecutionState.EXECUTION_STATE_COMPLETED);
      registry.setState(exec3.id, ExecutionState.EXECUTION_STATE_RUNNING);

      const running = registry.list({
        states: [ExecutionState.EXECUTION_STATE_RUNNING],
      });

      expect(running.length).toBe(2);
      expect(running.every(e => e.state === ExecutionState.EXECUTION_STATE_RUNNING)).toBe(true);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        registry.create({ code: `test${i}`, timeoutMs: 30000, isCached: false });
      }

      const limited = registry.list({ limit: 5 });

      expect(limited.length).toBe(5);
    });

    it('filters completed by time', async () => {
      const exec1 = registry.create({ code: 'test1', timeoutMs: 30000, isCached: false });
      registry.setResult(exec1.id, {
        success: true,
        executionTimeMs: 10,
        state: ExecutionState.EXECUTION_STATE_COMPLETED,
      });

      // Wait a bit
      await new Promise(r => setTimeout(r, 100));

      const exec2 = registry.create({ code: 'test2', timeoutMs: 30000, isCached: false });
      registry.setResult(exec2.id, {
        success: true,
        executionTimeMs: 10,
        state: ExecutionState.EXECUTION_STATE_COMPLETED,
      });

      // Filter to only include recently completed
      const recent = registry.list({
        includeCompletedWithinMs: 50,
      });

      // Only exec2 should be included (exec1 is too old)
      expect(recent.length).toBe(1);
      expect(recent[0].id).toBe(exec2.id);
    });

    it('sorts by started time (newest first)', async () => {
      const exec1 = registry.create({ code: 'test1', timeoutMs: 30000, isCached: false });

      // Need actual delays to get different timestamps
      await new Promise(r => setTimeout(r, 5));
      const exec2 = registry.create({ code: 'test2', timeoutMs: 30000, isCached: false });

      await new Promise(r => setTimeout(r, 5));
      const exec3 = registry.create({ code: 'test3', timeoutMs: 30000, isCached: false });

      const list = registry.list();

      expect(list[0].id).toBe(exec3.id);
      expect(list[1].id).toBe(exec2.id);
      expect(list[2].id).toBe(exec1.id);
    });
  });

  describe('isTerminalState()', () => {
    it('returns true for COMPLETED', () => {
      expect(registry.isTerminalState(ExecutionState.EXECUTION_STATE_COMPLETED)).toBe(true);
    });

    it('returns true for FAILED', () => {
      expect(registry.isTerminalState(ExecutionState.EXECUTION_STATE_FAILED)).toBe(true);
    });

    it('returns true for CANCELLED', () => {
      expect(registry.isTerminalState(ExecutionState.EXECUTION_STATE_CANCELLED)).toBe(true);
    });

    it('returns true for TIMEOUT', () => {
      expect(registry.isTerminalState(ExecutionState.EXECUTION_STATE_TIMEOUT)).toBe(true);
    });

    it('returns false for PENDING', () => {
      expect(registry.isTerminalState(ExecutionState.EXECUTION_STATE_PENDING)).toBe(false);
    });

    it('returns false for RUNNING', () => {
      expect(registry.isTerminalState(ExecutionState.EXECUTION_STATE_RUNNING)).toBe(false);
    });
  });
});
