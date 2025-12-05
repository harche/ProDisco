import vm from 'node:vm';
import { transform } from 'esbuild';
import * as k8s from '@kubernetes/client-node';
import * as prometheusQuery from 'prometheus-query';

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  executionTimeMs: number;
}

export interface StreamingExecutionResult extends ExecutionResult {
  cancelled: boolean;
  timedOut: boolean;
}

export type OutputCallback = (output: string, isError: boolean) => void;

export interface ExecutorConfig {
  prometheusUrl?: string;
}

export interface StreamingExecuteOptions {
  code: string;
  timeoutMs?: number;
  onOutput?: OutputCallback;
  signal?: AbortSignal;
}

/**
 * Executor handles code execution in a sandboxed VM environment.
 * It provides Kubernetes and Prometheus context for scripts.
 */
export class Executor {
  private kc: k8s.KubeConfig;
  private prometheusUrl?: string;

  constructor(config: ExecutorConfig = {}) {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.prometheusUrl = config.prometheusUrl || process.env.PROMETHEUS_URL;
  }

  /**
   * Get the current Kubernetes context name.
   */
  getKubernetesContext(): string {
    return this.kc.getCurrentContext() || 'unknown';
  }

  /**
   * Execute code in the sandbox.
   * @param code - TypeScript code to execute
   * @param timeoutMs - Execution timeout in milliseconds (default: 30000, max: 120000)
   */
  async execute(code: string, timeoutMs: number = 30000): Promise<ExecutionResult> {
    const startTime = Date.now();
    const outputLines: string[] = [];

    // Clamp timeout
    const timeout = Math.min(Math.max(timeoutMs, 1000), 120000);

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
      const sandbox: Record<string, unknown> = {
        console: {
          log: (...args: unknown[]) => outputLines.push(args.map(String).join(' ')),
          error: (...args: unknown[]) => outputLines.push('[ERROR] ' + args.map(String).join(' ')),
          warn: (...args: unknown[]) => outputLines.push('[WARN] ' + args.map(String).join(' ')),
          info: (...args: unknown[]) => outputLines.push('[INFO] ' + args.map(String).join(' ')),
        },
        // Kubernetes (pre-configured for convenience)
        k8s,                           // Full @kubernetes/client-node library
        kc: this.kc,                   // Pre-configured KubeConfig

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

      return {
        success: true,
        output: outputLines.join('\n'),
        executionTimeMs: Date.now() - startTime,
      };

    } catch (error) {
      return {
        success: false,
        output: outputLines.join('\n'),
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute code with streaming output and cancellation support.
   * @param options - Streaming execution options
   */
  async executeStreaming(options: StreamingExecuteOptions): Promise<StreamingExecutionResult> {
    const { code, timeoutMs = 30000, onOutput, signal } = options;
    const startTime = Date.now();
    const outputLines: string[] = [];

    // Check if already aborted
    if (signal?.aborted) {
      return {
        success: false,
        output: '',
        error: 'Execution was cancelled',
        executionTimeMs: 0,
        cancelled: true,
        timedOut: false,
      };
    }

    // Clamp timeout
    const timeout = Math.min(Math.max(timeoutMs, 1000), 120000);

    try {
      // 1. Wrap code in async IIFE BEFORE transforming
      const wrappedTs = `(async () => {\n${code}\n})()`;

      // 2. Transform TypeScript to JavaScript
      const { code: jsCode } = await transform(wrappedTs, {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
      });

      // 3. Create sandbox context with streaming output
      const sandbox: Record<string, unknown> = {
        console: {
          log: (...args: unknown[]) => {
            const line = args.map(String).join(' ');
            outputLines.push(line);
            onOutput?.(line + '\n', false);
          },
          error: (...args: unknown[]) => {
            const line = '[ERROR] ' + args.map(String).join(' ');
            outputLines.push(line);
            onOutput?.(line + '\n', true);
          },
          warn: (...args: unknown[]) => {
            const line = '[WARN] ' + args.map(String).join(' ');
            outputLines.push(line);
            onOutput?.(line + '\n', false);
          },
          info: (...args: unknown[]) => {
            const line = '[INFO] ' + args.map(String).join(' ');
            outputLines.push(line);
            onOutput?.(line + '\n', false);
          },
        },
        k8s,
        kc: this.kc,
        require: (mod: string) => {
          if (mod === '@kubernetes/client-node') return k8s;
          if (mod === 'prometheus-query') return prometheusQuery;
          throw new Error(`Module '${mod}' not available in sandbox`);
        },
        process: { env: process.env },
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

      // 4. Create completion promise
      let resolveResult: (value: unknown) => void;
      let rejectResult: (error: unknown) => void;
      const resultPromise = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      sandbox.__resolve__ = resolveResult!;
      sandbox.__reject__ = rejectResult!;

      const context = vm.createContext(sandbox);

      // 5. Execute code
      const trimmedJsCode = jsCode.trim().replace(/;$/, '');
      const finalCode = `
        ${trimmedJsCode}
        .then(() => __resolve__(undefined))
        .catch((e) => __reject__(e));
      `;

      const script = new vm.Script(finalCode, {
        filename: 'sandbox-script.js',
      });

      script.runInContext(context);

      // 6. Wait with timeout and abort support
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeout);
      });

      const abortPromise = new Promise<'abort'>((resolve) => {
        if (signal) {
          signal.addEventListener('abort', () => resolve('abort'), { once: true });
        }
      });

      const result = await Promise.race([
        resultPromise.then(() => 'success' as const),
        resultPromise.catch((e) => ({ error: e })),
        timeoutPromise,
        abortPromise,
      ]);

      if (result === 'abort') {
        return {
          success: false,
          output: outputLines.join('\n'),
          error: 'Execution was cancelled',
          executionTimeMs: Date.now() - startTime,
          cancelled: true,
          timedOut: false,
        };
      }

      if (result === 'timeout') {
        return {
          success: false,
          output: outputLines.join('\n'),
          error: 'Script execution timed out',
          executionTimeMs: Date.now() - startTime,
          cancelled: false,
          timedOut: true,
        };
      }

      if (typeof result === 'object' && result !== null && 'error' in result) {
        const error = (result as { error: unknown }).error;
        return {
          success: false,
          output: outputLines.join('\n'),
          error: error instanceof Error ? error.message : String(error),
          executionTimeMs: Date.now() - startTime,
          cancelled: false,
          timedOut: false,
        };
      }

      return {
        success: true,
        output: outputLines.join('\n'),
        executionTimeMs: Date.now() - startTime,
        cancelled: false,
        timedOut: false,
      };

    } catch (error) {
      return {
        success: false,
        output: outputLines.join('\n'),
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
        cancelled: false,
        timedOut: false,
      };
    }
  }
}
