import { z } from 'zod';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import * as k8s from '@kubernetes/client-node';
import * as prometheusQuery from 'prometheus-query';
import type { ToolDefinition } from '../types.js';
import { SCRIPTS_CACHE_DIR } from '../../util/paths.js';
import { searchToolsService } from './searchTools.js';

// ============================================================================
// Simple Mutex for Concurrent Script Caching
// ============================================================================

/**
 * Simple async mutex to prevent race conditions during script caching.
 * Ensures only one cacheAndIndex operation runs at a time.
 */
class CacheMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const cacheMutex = new CacheMutex();

/**
 * Cache a successfully executed script to disk and index it.
 * Uses a mutex to handle concurrent requests safely.
 * Uses a hash of the code to create a unique filename, avoiding duplicates.
 */
async function cacheAndIndexScript(code: string): Promise<void> {
  await cacheMutex.acquire();

  try {
    // Ensure cache directory exists
    if (!existsSync(SCRIPTS_CACHE_DIR)) {
      mkdirSync(SCRIPTS_CACHE_DIR, { recursive: true });
    }

    // Create a hash-based filename to deduplicate by content
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);

    // Check if any script with this hash already exists (regardless of timestamp)
    const existingFiles = readdirSync(SCRIPTS_CACHE_DIR);
    const existingScript = existingFiles.find(f => f.includes(hash) && f.endsWith('.ts'));

    if (existingScript) {
      // Script with same content already cached, nothing to do
      return;
    }

    // Create new script file with timestamp and hash
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `script-${timestamp}-${hash}.ts`;
    const filepath = join(SCRIPTS_CACHE_DIR, filename);

    // Add a header comment with execution timestamp
    const header = `// Executed via runSandbox at ${new Date().toISOString()}\n`;
    writeFileSync(filepath, header + code, 'utf-8');

    // Index immediately so it's searchable
    await searchToolsService.indexScriptImmediately(filepath);
  } catch {
    // Silently ignore caching errors - don't fail the execution
  } finally {
    cacheMutex.release();
  }
}

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
  cachedScript?: string;    // Name of cached script that was executed (if using cached mode)
};

/**
 * Find a cached script by name (exact or partial match).
 * Returns the full path and filename if found, or null if not found.
 */
function findCachedScript(scriptName: string): { path: string; filename: string } | null {
  if (!existsSync(SCRIPTS_CACHE_DIR)) {
    return null;
  }

  const files = readdirSync(SCRIPTS_CACHE_DIR).filter(f => f.endsWith('.ts'));

  // Try exact match first (with or without .ts extension)
  const exactName = scriptName.endsWith('.ts') ? scriptName : `${scriptName}.ts`;
  if (files.includes(exactName)) {
    return { path: join(SCRIPTS_CACHE_DIR, exactName), filename: exactName };
  }

  // Try partial match (script name contains the search term)
  const partialMatch = files.find(f =>
    f.toLowerCase().includes(scriptName.toLowerCase())
  );
  if (partialMatch) {
    return { path: join(SCRIPTS_CACHE_DIR, partialMatch), filename: partialMatch };
  }

  return null;
}

/**
 * Read and return the code from a cached script file.
 * Strips the auto-generated header comment if present.
 */
function readCachedScript(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  // Strip the auto-generated header comment (first line if it starts with "// Executed via runSandbox")
  const lines = content.split('\n');
  if (lines[0]?.startsWith('// Executed via runSandbox')) {
    return lines.slice(1).join('\n').trim();
  }
  return content;
}

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
    const { code: inputCode, cached, timeout = 30000 } = input;
    const startTime = Date.now();
    const outputLines: string[] = [];

    // Resolve the code to execute
    let code: string;
    let cachedScriptName: string | undefined;

    if (cached) {
      // Find and load the cached script
      const found = findCachedScript(cached);
      if (!found) {
        return {
          success: false,
          output: '',
          error: `Cached script "${cached}" not found. Use searchTools with mode: "scripts" to list available scripts.`,
          executionTime: Date.now() - startTime,
        };
      }
      code = readCachedScript(found.path);
      cachedScriptName = found.filename;
    } else if (inputCode) {
      code = inputCode;
    } else {
      return {
        success: false,
        output: '',
        error: 'Either "code" or "cached" must be provided',
        executionTime: Date.now() - startTime,
      };
    }

    try {
      // 1. Wrap code in async IIFE BEFORE transforming so esbuild sees await inside a function
      const wrappedTs = `(async () => {\n${code}\n})()`;

      // 2. Transform TypeScript to JavaScript
      const { code: jsCode } = await transform(wrappedTs, {
        loader: 'ts',
        format: 'cjs',      // CommonJS for vm compatibility
        target: 'es2022',
      });

      // 3. Create sandbox context with full capabilities
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();

      const sandbox: Record<string, unknown> = {
        console: {
          log: (...args: unknown[]) => outputLines.push(args.map(String).join(' ')),
          error: (...args: unknown[]) => outputLines.push('[ERROR] ' + args.map(String).join(' ')),
          warn: (...args: unknown[]) => outputLines.push('[WARN] ' + args.map(String).join(' ')),
          info: (...args: unknown[]) => outputLines.push('[INFO] ' + args.map(String).join(' ')),
        },
        // Kubernetes (pre-configured for convenience)
        k8s,                           // Full @kubernetes/client-node library
        kc,                            // Pre-configured KubeConfig

        // Module loading (for all libraries including prometheus-query)
        require: (mod: string) => {
          if (mod === '@kubernetes/client-node') return k8s;
          if (mod === 'prometheus-query') return prometheusQuery;
          throw new Error(`Module '${mod}' not available in sandbox`);
        },

        // Environment & globals
        process: { env: process.env }, // Environment access (PROMETHEUS_URL, etc.)
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        Promise,
        JSON,
        Buffer,
        Date,
        Math,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Error,
      };

      // 4. Create a promise that will be resolved when the async code completes
      let resolveResult: (value: unknown) => void;
      let rejectResult: (error: unknown) => void;
      const resultPromise = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      // Add the resolver to sandbox context
      sandbox.__resolve__ = resolveResult!;
      sandbox.__reject__ = rejectResult!;

      const context = vm.createContext(sandbox);

      // 5. Wrap the transformed code to capture completion/errors
      // esbuild adds a trailing semicolon, so we need to remove it before adding .then()
      const trimmedJsCode = jsCode.trim().replace(/;$/, '');
      const finalCode = `
        ${trimmedJsCode}
        .then(() => __resolve__(undefined))
        .catch((e) => __reject__(e));
      `;

      // 6. Execute in sandbox
      const script = new vm.Script(finalCode, {
        filename: 'sandbox-script.js',
      });

      // Start execution (returns immediately, async work continues)
      script.runInContext(context);

      // Wait for the async code to complete with timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Script execution timed out')), timeout);
      });

      await Promise.race([resultPromise, timeoutPromise]);

      // Cache successful scripts for searchability and index immediately
      // Skip caching if we're running a cached script (it's already cached)
      if (!cachedScriptName) {
        await cacheAndIndexScript(code);
      }

      return {
        success: true,
        output: outputLines.join('\n'),
        returnValue: undefined,
        executionTime: Date.now() - startTime,
        cachedScript: cachedScriptName,
      };

    } catch (error) {
      return {
        success: false,
        output: outputLines.join('\n'),
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        cachedScript: cachedScriptName,
      };
    }
  },
};
