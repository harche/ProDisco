import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getSandboxClient } from '@prodisco/sandbox-server/client';
import { searchToolsService } from './searchTools.js';

const RunSandboxInputSchema = z.object({
  code: z.string().optional()
    .describe('TypeScript code to execute (required if "cached" is not provided)'),
  cached: z.string().optional()
    .describe('Name of a cached script to execute (from searchTools results). Can be filename or partial match.'),
  timeout: z.number().int().positive().max(120000).default(30000).optional()
    .describe('Execution timeout in milliseconds (default: 30000, max: 120000)'),
}).refine(
  (data) => data.code !== undefined || data.cached !== undefined,
  { message: 'Either "code" or "cached" must be provided' }
);

type RunSandboxResult = {
  success: boolean;
  output: string;           // Captured console output
  returnValue?: unknown;    // Return value from script (if any)
  error?: string;           // Error message if failed
  executionTime: number;    // Execution time in ms
  cachedScript?: string;    // Name of cached script that was executed or newly cached
  /** Full cache entry if newly cached (for immediate indexing) */
  cached?: {
    name: string;
    description: string;
    createdAtMs: number;
    contentHash: string;
  };
};

export const runSandboxTool: ToolDefinition<RunSandboxResult, typeof RunSandboxInputSchema> = {
  name: 'kubernetes.runSandbox',
  description:
    'Execute TypeScript code in a sandboxed environment for Kubernetes and Prometheus operations. ' +
    'TWO MODES: ' +
    '(1) code: Provide TypeScript code directly. Start with a descriptive comment for indexing. ' +
    '(2) cached: Run a previously cached script by name (from searchTools results). ' +
    'The sandbox provides: k8s, kc (pre-configured KubeConfig), console, process.env, require("prometheus-query"). ' +
    'Use searchTools first to discover APIs and find cached scripts.',
  schema: RunSandboxInputSchema,

  async execute(input) {
    const { code, cached, timeout = 30000 } = input;
    const startTime = Date.now();

    try {
      const client = getSandboxClient();

      const result = await client.execute({
        code,
        cached,
        timeoutMs: timeout,
      });

      // Index newly cached scripts for searchability using CacheEntry metadata
      if (result.success && result.cached) {
        // The sandbox server cached it and returned full entry for immediate indexing
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
        success: result.success,
        output: result.output,
        returnValue: undefined,
        error: result.error,
        executionTime: result.executionTimeMs,
        cachedScript: result.cached?.name ?? (cached ? cached : undefined),
        cached: result.cached,
      };

    } catch (error) {
      return {
        success: false,
        output: '',
        error: `gRPC error: ${error instanceof Error ? error.message : String(error)}`,
        executionTime: Date.now() - startTime,
      };
    }
  },
};
