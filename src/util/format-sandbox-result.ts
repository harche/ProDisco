/**
 * Formats a runSandbox result object into human-readable text for MCP tool responses.
 * Extracted from server.ts so it can be imported without triggering server startup side effects.
 */
export function buildRunSandboxText(result: Record<string, unknown>): string {
  if ('error' in result && result.error && !('output' in result)) {
    return `Error: ${result.error}`;
  } else if (result.mode === 'execute' || result.mode === 'stream') {
    const execResult = result as { success: boolean; output: string; error?: string; executionTimeMs: number; cachedScript?: string };
    const cachedInfo = execResult.cachedScript ? ` [cached: ${execResult.cachedScript}]` : '';
    if (execResult.success) {
      return `Execution successful${cachedInfo} (${execResult.executionTimeMs}ms)\n\nOutput:\n${execResult.output}`;
    } else {
      return `Execution failed${cachedInfo} (${execResult.executionTimeMs}ms)\n\nError: ${execResult.error}\n\nOutput:\n${execResult.output}`;
    }
  } else if (result.mode === 'async') {
    const asyncResult = result as { executionId: string; state: string; message: string };
    return `${asyncResult.message}\n\nExecution ID: ${asyncResult.executionId}\nState: ${asyncResult.state}`;
  } else if (result.mode === 'status') {
    const statusResult = result as { executionId: string; state: string; output: string; errorOutput: string; result?: { success: boolean } };
    const isComplete = statusResult.result !== undefined;
    let text = `Execution ${statusResult.executionId}\nState: ${statusResult.state}${isComplete ? ' (completed)' : ''}\n\nOutput:\n${statusResult.output}`;
    if (statusResult.errorOutput) {
      text += `\n\nErrors:\n${statusResult.errorOutput}`;
    }
    return text;
  } else if (result.mode === 'cancel') {
    const cancelResult = result as { success: boolean; executionId: string; state: string; message?: string };
    return cancelResult.success
      ? `Execution ${cancelResult.executionId} cancelled. State: ${cancelResult.state}`
      : `Failed to cancel execution ${cancelResult.executionId}: ${cancelResult.message || 'Unknown error'}`;
  } else if (result.mode === 'list') {
    const listResult = result as { executions: Array<{ executionId: string; state: string; codePreview: string }>; totalCount: number };
    if (listResult.executions.length === 0) {
      return 'No executions found.';
    }
    let text = `Found ${listResult.totalCount} execution(s):\n\n`;
    for (const exec of listResult.executions) {
      text += `• ${exec.executionId} [${exec.state}]: ${exec.codePreview}\n`;
    }
    return text;
  }
  return JSON.stringify(result, null, 2);
}
