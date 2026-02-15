import { describe, expect, it } from 'vitest';
import { buildRunSandboxText } from '../util/format-sandbox-result.js';

/**
 * Tests for MCP tool response shapes — verifies that tool handlers return
 * correctly structured responses for both app and non-app clients, avoiding
 * duplicate output.
 */

// ---------------------------------------------------------------------------
// buildRunSandboxText — pure function that formats tool results as text
// ---------------------------------------------------------------------------

describe('buildRunSandboxText', () => {
  describe('execute mode', () => {
    it('formats successful execution', () => {
      const text = buildRunSandboxText({
        mode: 'execute',
        success: true,
        output: 'hello world',
        executionTimeMs: 42,
      });
      expect(text).toBe('Execution successful (42ms)\n\nOutput:\nhello world');
    });

    it('includes cached script info when present', () => {
      const text = buildRunSandboxText({
        mode: 'execute',
        success: true,
        output: '[]',
        executionTimeMs: 5,
        cachedScript: 'list-pods',
      });
      expect(text).toContain('[cached: list-pods]');
      expect(text).toBe('Execution successful [cached: list-pods] (5ms)\n\nOutput:\n[]');
    });

    it('formats failed execution with error', () => {
      const text = buildRunSandboxText({
        mode: 'execute',
        success: false,
        output: '',
        error: 'ReferenceError: x is not defined',
        executionTimeMs: 10,
      });
      expect(text).toContain('Execution failed');
      expect(text).toContain('ReferenceError: x is not defined');
      expect(text).toContain('(10ms)');
    });
  });

  describe('stream mode', () => {
    it('formats successful stream execution', () => {
      const text = buildRunSandboxText({
        mode: 'stream',
        success: true,
        output: 'streamed output',
        executionTimeMs: 100,
      });
      expect(text).toContain('Execution successful');
      expect(text).toContain('streamed output');
    });
  });

  describe('async mode', () => {
    it('formats async execution start', () => {
      const text = buildRunSandboxText({
        mode: 'async',
        executionId: 'exec-123',
        state: 'running',
        message: 'Execution started',
      });
      expect(text).toContain('Execution started');
      expect(text).toContain('exec-123');
      expect(text).toContain('running');
    });
  });

  describe('status mode', () => {
    it('formats completed execution status', () => {
      const text = buildRunSandboxText({
        mode: 'status',
        executionId: 'exec-456',
        state: 'completed',
        output: 'done',
        errorOutput: '',
        result: { success: true },
      });
      expect(text).toContain('exec-456');
      expect(text).toContain('completed');
      expect(text).toContain('done');
    });

    it('includes error output when present', () => {
      const text = buildRunSandboxText({
        mode: 'status',
        executionId: 'exec-789',
        state: 'completed',
        output: 'partial',
        errorOutput: 'stderr line',
        result: { success: false },
      });
      expect(text).toContain('Errors:');
      expect(text).toContain('stderr line');
    });
  });

  describe('cancel mode', () => {
    it('formats successful cancellation', () => {
      const text = buildRunSandboxText({
        mode: 'cancel',
        success: true,
        executionId: 'exec-abc',
        state: 'cancelled',
      });
      expect(text).toContain('cancelled');
      expect(text).toContain('exec-abc');
    });

    it('formats failed cancellation', () => {
      const text = buildRunSandboxText({
        mode: 'cancel',
        success: false,
        executionId: 'exec-def',
        state: 'completed',
        message: 'Already finished',
      });
      expect(text).toContain('Failed to cancel');
      expect(text).toContain('Already finished');
    });
  });

  describe('list mode', () => {
    it('formats execution list', () => {
      const text = buildRunSandboxText({
        mode: 'list',
        totalCount: 2,
        executions: [
          { executionId: 'e1', state: 'running', codePreview: 'console.log...' },
          { executionId: 'e2', state: 'completed', codePreview: 'fetch(...)' },
        ],
      });
      expect(text).toContain('Found 2 execution(s)');
      expect(text).toContain('e1');
      expect(text).toContain('e2');
    });

    it('formats empty execution list', () => {
      const text = buildRunSandboxText({
        mode: 'list',
        totalCount: 0,
        executions: [],
      });
      expect(text).toBe('No executions found.');
    });
  });

  describe('error-only result', () => {
    it('formats bare error without output', () => {
      const text = buildRunSandboxText({ error: 'Something went wrong' });
      expect(text).toBe('Error: Something went wrong');
    });
  });

  describe('unknown mode', () => {
    it('falls back to JSON stringification', () => {
      const input = { mode: 'unknown', foo: 'bar' };
      const text = buildRunSandboxText(input);
      expect(text).toBe(JSON.stringify(input, null, 2));
    });
  });
});

// ---------------------------------------------------------------------------
// Handler response shape contracts
// ---------------------------------------------------------------------------

describe('MCP handler response shape contracts', () => {
  // Simulate tool result objects matching what runSandbox.execute() returns
  const mockExecuteResult = {
    mode: 'execute',
    success: true,
    output: '[{"name":"pod-1"}]',
    executionTimeMs: 15,
    cachedScript: 'list-pods',
    outputLineCount: 1,
    outputCharCount: 21,
    truncated: false,
  };

  const mockFailedResult = {
    mode: 'execute',
    success: false,
    output: '',
    error: 'TypeError: x is not a function',
    executionTimeMs: 8,
    outputLineCount: 0,
    outputCharCount: 0,
    truncated: false,
  };

  const mockTestResult = {
    mode: 'test',
    success: true,
    summary: { total: 3, passed: 3, failed: 0, skipped: 0 },
    tests: [
      { name: 'test 1', passed: true, durationMs: 1 },
      { name: 'test 2', passed: true, durationMs: 2 },
      { name: 'test 3', passed: true, durationMs: 1 },
    ],
    executionTimeMs: 10,
  };

  // Replicate the non-app handler logic
  function buildNonAppResponse(result: Record<string, unknown>) {
    const text = buildRunSandboxText(result);
    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    };
  }

  // Replicate the app handler logic
  function buildAppResponse(result: Record<string, unknown>) {
    const text = buildRunSandboxText(result);
    return {
      content: [
        {
          type: 'text' as const,
          text,
          annotations: { audience: ['assistant' as const] },
        },
      ],
      _meta: { structuredResult: result },
    };
  }

  describe('non-app handler response', () => {
    it('returns content array with text item', () => {
      const response = buildNonAppResponse(mockExecuteResult);
      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('text');
      expect(response.content[0].text).toContain('Execution successful');
    });

    it('does not include structuredContent', () => {
      const response = buildNonAppResponse(mockExecuteResult);
      expect(response).not.toHaveProperty('structuredContent');
    });

    it('does not include _meta', () => {
      const response = buildNonAppResponse(mockExecuteResult);
      expect(response).not.toHaveProperty('_meta');
    });

    it('does not include audience annotations', () => {
      const response = buildNonAppResponse(mockExecuteResult);
      expect(response.content[0]).not.toHaveProperty('annotations');
    });
  });

  describe('app handler response', () => {
    it('returns content array with text item', () => {
      const response = buildAppResponse(mockExecuteResult);
      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('text');
      expect(response.content[0].text).toContain('Execution successful');
    });

    it('annotates text content with audience assistant', () => {
      const response = buildAppResponse(mockExecuteResult);
      expect(response.content[0].annotations).toEqual({
        audience: ['assistant'],
      });
    });

    it('passes structured result via _meta', () => {
      const response = buildAppResponse(mockExecuteResult);
      expect(response._meta).toBeDefined();
      expect(response._meta.structuredResult).toBe(mockExecuteResult);
    });

    it('does not include structuredContent', () => {
      const response = buildAppResponse(mockExecuteResult);
      expect(response).not.toHaveProperty('structuredContent');
    });

    it('preserves full result object in _meta for execute mode', () => {
      const response = buildAppResponse(mockExecuteResult);
      const result = response._meta.structuredResult as Record<string, unknown>;
      expect(result.mode).toBe('execute');
      expect(result.success).toBe(true);
      expect(result.output).toBe('[{"name":"pod-1"}]');
      expect(result.executionTimeMs).toBe(15);
      expect(result.cachedScript).toBe('list-pods');
    });

    it('preserves full result object in _meta for failed execution', () => {
      const response = buildAppResponse(mockFailedResult);
      const result = response._meta.structuredResult as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(result.error).toBe('TypeError: x is not a function');
    });

    it('preserves full result object in _meta for test mode', () => {
      const response = buildAppResponse(mockTestResult);
      const result = response._meta.structuredResult as Record<string, unknown>;
      expect(result.mode).toBe('test');
      expect(result.summary).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
      expect((result.tests as unknown[]).length).toBe(3);
    });
  });

  describe('no duplicate output between app and non-app', () => {
    it('app response text matches non-app response text', () => {
      const appResponse = buildAppResponse(mockExecuteResult);
      const nonAppResponse = buildNonAppResponse(mockExecuteResult);
      // The text content should be identical — the difference is annotations and _meta
      expect(appResponse.content[0].text).toBe(nonAppResponse.content[0].text);
    });

    it('app response does not embed output in multiple places', () => {
      const response = buildAppResponse(mockExecuteResult);
      // Output should only appear in content[0].text and _meta.structuredResult
      // NOT in a top-level structuredContent field
      const keys = Object.keys(response);
      expect(keys).toContain('content');
      expect(keys).toContain('_meta');
      expect(keys).not.toContain('structuredContent');
    });
  });
});

// ---------------------------------------------------------------------------
// extractResult — app-side function that extracts structured data from tool result
// ---------------------------------------------------------------------------

describe('extractResult', () => {
  // Since extractResult is in the app bundle (uses DOM APIs), we replicate the
  // logic here for unit testing rather than importing from the app module.
  // This mirrors the implementation in src/apps/runSandbox/app.ts.
  function extractResult(toolResult: unknown): Record<string, unknown> {
    const raw = toolResult as Record<string, unknown>;
    const meta = raw._meta as Record<string, unknown> | undefined;
    if (meta?.structuredResult) {
      return meta.structuredResult as Record<string, unknown>;
    }
    if (raw.structuredContent) {
      return raw.structuredContent as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }

  it('extracts from _meta.structuredResult (preferred path)', () => {
    const toolResult = {
      content: [{ type: 'text', text: 'some text' }],
      _meta: {
        structuredResult: { mode: 'execute', success: true, output: 'hello' },
      },
    };
    const result = extractResult(toolResult);
    expect(result.mode).toBe('execute');
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
  });

  it('falls back to structuredContent (legacy path)', () => {
    const toolResult = {
      content: [{ type: 'text', text: 'some text' }],
      structuredContent: { mode: 'execute', success: true, output: 'legacy' },
    };
    const result = extractResult(toolResult);
    expect(result.mode).toBe('execute');
    expect(result.output).toBe('legacy');
  });

  it('prefers _meta over structuredContent when both are present', () => {
    const toolResult = {
      _meta: { structuredResult: { mode: 'execute', output: 'from-meta' } },
      structuredContent: { mode: 'execute', output: 'from-legacy' },
    };
    const result = extractResult(toolResult);
    expect(result.output).toBe('from-meta');
  });

  it('falls back to raw object when neither _meta nor structuredContent exist', () => {
    const toolResult = {
      mode: 'execute',
      success: true,
      output: 'raw fallback',
    };
    const result = extractResult(toolResult);
    expect(result.mode).toBe('execute');
    expect(result.output).toBe('raw fallback');
  });

  it('handles empty _meta gracefully', () => {
    const toolResult = {
      _meta: {},
      mode: 'execute',
      output: 'should fall through',
    };
    const result = extractResult(toolResult);
    // _meta exists but has no structuredResult, no structuredContent either
    // falls back to raw object
    expect(result.output).toBe('should fall through');
  });

  it('handles null/undefined _meta gracefully', () => {
    const toolResult = {
      _meta: undefined,
      mode: 'test',
      success: true,
    };
    const result = extractResult(toolResult);
    expect(result.mode).toBe('test');
  });

  it('extracts complex test mode result from _meta', () => {
    const testResult = {
      mode: 'test',
      success: true,
      summary: { total: 5, passed: 4, failed: 1, skipped: 0 },
      tests: [
        { name: 'test-a', passed: true, durationMs: 1 },
        { name: 'test-b', passed: false, error: 'assertion failed', durationMs: 2 },
      ],
      executionTimeMs: 50,
    };
    const toolResult = {
      content: [{ type: 'text', text: 'summary' }],
      _meta: { structuredResult: testResult },
    };
    const result = extractResult(toolResult);
    expect(result.mode).toBe('test');
    expect(result.summary).toEqual({ total: 5, passed: 4, failed: 1, skipped: 0 });
    expect((result.tests as unknown[]).length).toBe(2);
  });
});
