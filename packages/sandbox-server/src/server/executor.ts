import vm from 'node:vm';
import { transform } from 'esbuild';
import { builtinModules, createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

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
  /** Optional override for allowed require() module roots (mainly for tests). */
  allowedModules?: string[];
  /** Optional override for module resolution base path (directory containing node_modules). */
  modulesBasePath?: string;
}

export interface StreamingExecuteOptions {
  code: string;
  timeoutMs?: number;
  onOutput?: OutputCallback;
  signal?: AbortSignal;
}

const DEFAULT_ALLOWED_MODULES = [
  '@kubernetes/client-node',
  '@prodisco/prometheus-client',
  '@prodisco/loki-client',
  'simple-statistics',
];

const localRequire = createRequire(import.meta.url);

function hasUsableNodeModules(dir: string): boolean {
  const nodeModulesPath = path.join(dir, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    return false;
  }

  // node_modules can exist for tooling caches (e.g., vitest creates node_modules/.vite),
  // so require at least one non-dot entry to treat it as a real dependency root.
  try {
    const entries = readdirSync(nodeModulesPath);
    return entries.some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

function findNearestNodeModulesBasePath(startDir: string): string {
  let dir = startDir;
  // Best-effort upward search for a directory containing node_modules.
  // This matters in monorepos where workspace commands run with cwd set to a package dir
  // but dependencies are hoisted to the repo root.
  // If none is found, return the original startDir as a fallback.
  while (true) {
    if (hasUsableNodeModules(dir)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return startDir;
    }
    dir = parent;
  }
}

function normalizeModulesBasePath(inputPath: string): string {
  const p = inputPath.trim();
  if (!p) return inputPath;

  // Accept either the node_modules directory itself or its parent.
  if (path.basename(p) === 'node_modules') {
    const parent = path.dirname(p);
    return existsSync(path.join(parent, 'node_modules')) ? parent : parent;
  }

  if (hasUsableNodeModules(p)) {
    return p;
  }

  return findNearestNodeModulesBasePath(p);
}

function getConfigPathFromEnv(): string | null {
  const p = process.env.PRODISCO_CONFIG_PATH || process.env.SANDBOX_CONFIG_PATH;
  return p && p.trim().length > 0 ? p.trim() : null;
}

function parseAllowedModulesFromConfigFile(configPath: string): string[] {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const ext = path.extname(configPath).toLowerCase();
  const raw = readFileSync(configPath, 'utf-8');

  let obj: unknown;
  if (ext === '.json') {
    obj = JSON.parse(raw) as unknown;
  } else if (ext === '.yaml' || ext === '.yml') {
    let yamlMod: unknown;
    try {
      yamlMod = localRequire('yaml');
    } catch {
      throw new Error('YAML config requires the "yaml" package to be available. Use JSON config or install yaml.');
    }

    const parseAllDocuments = (yamlMod as { parseAllDocuments?: (s: string) => Array<{ contents: unknown; toJSON: () => unknown }> })
      .parseAllDocuments;

    if (typeof parseAllDocuments !== 'function') {
      throw new Error('Invalid "yaml" package shape (missing parseAllDocuments)');
    }

    const docs = parseAllDocuments(raw);
    const nonEmptyDocs = docs.filter((d) => d.contents !== null);
    if (nonEmptyDocs.length === 0) {
      throw new Error('YAML config is empty');
    }
    if (nonEmptyDocs.length > 1) {
      throw new Error('YAML config must contain exactly one document');
    }
    obj = nonEmptyDocs[0]!.toJSON();
  } else {
    // Fallback: try JSON first, then YAML if available
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      let yamlMod: unknown;
      try {
        yamlMod = localRequire('yaml');
      } catch {
        throw new Error(`Unsupported config extension "${ext}". Use .json, .yaml, or .yml`);
      }
      const parse = (yamlMod as { parse?: (s: string) => unknown }).parse;
      if (typeof parse !== 'function') {
        throw new Error('Invalid "yaml" package shape (missing parse)');
      }
      obj = parse(raw);
    }
  }

  if (!obj || typeof obj !== 'object') {
    throw new Error('Config must be an object');
  }

  const libraries = (obj as { libraries?: unknown }).libraries;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    throw new Error('Config must include a non-empty "libraries" array');
  }

  const names: string[] = [];
  for (const entry of libraries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0) {
      names.push(name.trim());
    }
  }

  if (names.length === 0) {
    throw new Error('Config libraries entries must include a non-empty "name"');
  }

  // De-duplicate while preserving order
  const seen = new Set<string>();
  const unique = names.filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  return unique;
}

function parseAllowedModulesFromEnv(): Set<string> {
  const raw = process.env.SANDBOX_ALLOWED_MODULES;
  if (raw && raw.trim().length > 0) {
    // Prefer JSON (server passes JSON array)
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((s) => s.trim()));
      }
    } catch {
      // Fall back to CSV
    }

    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const configPath = getConfigPathFromEnv();
  if (configPath) {
    const libs = parseAllowedModulesFromConfigFile(configPath);
    return new Set(libs);
  }

  return new Set(DEFAULT_ALLOWED_MODULES);
}

const BUILTIN_MODULE_SET = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith('node:') ? m.slice('node:'.length) : m)),
]);

function isBuiltinModule(specifier: string): boolean {
  const cleaned = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return BUILTIN_MODULE_SET.has(specifier) || BUILTIN_MODULE_SET.has(cleaned);
}

function getPackageRootName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return specifier;
  }
  return specifier.split('/')[0] || specifier;
}

function isPathLike(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')) {
    return true;
  }
  // Windows drive letter paths, e.g. C:\foo
  if (/^[A-Za-z]:[\\/]/.test(specifier)) {
    return true;
  }
  // Disallow protocol-like specifiers (node:, file:, data:, etc.)
  if (specifier.includes(':')) {
    return true;
  }
  return false;
}

function isErrRequireEsm(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code?: unknown }).code === 'ERR_REQUIRE_ESM' ||
      (err as { code?: unknown }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
  );
}

function resolveImportEntryFromBasePath(basePath: string, packageName: string): string | null {
  const nodeModulesPath = path.join(basePath, 'node_modules');
  const packageDir = packageName.startsWith('@')
    ? path.join(nodeModulesPath, ...packageName.split('/'))
    : path.join(nodeModulesPath, packageName);

  const pkgJsonPath = path.join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return null;
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Prefer ESM import entry from exports, then fall back to module/main.
  let entry: string | undefined;
  const exportsField = pkgJson.exports as unknown;

  if (typeof exportsField === 'string') {
    entry = exportsField;
  } else if (exportsField && typeof exportsField === 'object') {
    const exportsObj = exportsField as Record<string, unknown>;
    const rootExport = (exportsObj['.'] ?? exportsObj) as unknown;
    if (typeof rootExport === 'string') {
      entry = rootExport;
    } else if (rootExport && typeof rootExport === 'object') {
      const root = rootExport as Record<string, unknown>;
      if (typeof root.import === 'string') {
        entry = root.import;
      } else if (typeof root.default === 'string') {
        entry = root.default;
      } else if (typeof root.require === 'string') {
        entry = root.require;
      }
    }
  }

  if (!entry && typeof pkgJson.module === 'string') {
    entry = pkgJson.module;
  }
  if (!entry && typeof pkgJson.main === 'string') {
    entry = pkgJson.main;
  }
  if (!entry) {
    entry = 'index.js';
  }

  const rel = entry.startsWith('./') ? entry.slice(2) : entry;
  return path.resolve(packageDir, rel);
}

function isEsmOnlyPackage(basePath: string, packageName: string): boolean {
  const nodeModulesPath = path.join(basePath, 'node_modules');
  const packageDir = packageName.startsWith('@')
    ? path.join(nodeModulesPath, ...packageName.split('/'))
    : path.join(nodeModulesPath, packageName);

  const pkgJsonPath = path.join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return false;
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return false;
  }

  const exportsField = pkgJson.exports as unknown;
  if (exportsField && typeof exportsField === 'object') {
    const exportsObj = exportsField as Record<string, unknown>;
    const rootExport = (exportsObj['.'] ?? exportsObj) as unknown;
    if (rootExport && typeof rootExport === 'object') {
      const root = rootExport as Record<string, unknown>;
      // If the package explicitly provides a require entry, treat it as CJS-compatible.
      if (root.require !== undefined) {
        return false;
      }
      // If it provides an import entry (or default) without require, treat it as ESM-only.
      if (root.import !== undefined || root.default !== undefined) {
        return true;
      }
    }
  }

  // Fallback heuristic: type=module without explicit require mapping is likely ESM-only.
  return pkgJson.type === 'module';
}

/**
 * Executor handles code execution in a sandboxed VM environment.
 * It provides Kubernetes and Prometheus context for scripts.
 */
export class Executor {
  private allowedModules: Set<string>;
  private basePath: string;
  private requireFromBase: NodeRequire;
  private prometheusUrl?: string;
  private moduleCache = new Map<string, unknown>();
  private preloadPromise: Promise<void> | null = null;

  constructor(config: ExecutorConfig = {}) {
    this.allowedModules = config.allowedModules ? new Set(config.allowedModules) : parseAllowedModulesFromEnv();
    const requestedBasePath = config.modulesBasePath || process.env.SANDBOX_MODULES_BASE_PATH || process.cwd();
    this.basePath = normalizeModulesBasePath(requestedBasePath);
    this.requireFromBase = createRequire(path.join(this.basePath, 'index.js'));
    this.prometheusUrl = config.prometheusUrl || process.env.PROMETHEUS_URL;

    // Start preloading in the background so async APIs can return quickly.
    // Any errors are swallowed; a later require() will surface failures as needed.
    this.preloadPromise = this.preloadAllowedModules().catch(() => undefined);
  }

  /**
   * Get the current Kubernetes context name.
   */
  getKubernetesContext(): string {
    return 'unknown';
  }

  private async ensureAllowedModulesPreloaded(): Promise<void> {
    if (!this.preloadPromise) {
      this.preloadPromise = this.preloadAllowedModules();
    }
    await this.preloadPromise;
  }

  private async preloadAllowedModules(): Promise<void> {
    // Preload allowlisted modules so synchronous require() in the VM can return
    // ESM-only packages (e.g., @prodisco/prometheus-client) via cached imports.
    for (const pkgName of this.allowedModules) {
      if (this.moduleCache.has(pkgName)) {
        continue;
      }

      // Only preload packages that are likely ESM-only.
      // CJS-compatible packages should be loaded on demand via require().
      if (!isEsmOnlyPackage(this.basePath, pkgName)) {
        continue;
      }

      // Import-only package: resolve an import entry, then import it.
      const resolved = resolveImportEntryFromBasePath(this.basePath, pkgName);

      if (!resolved) {
        continue;
      }

      try {
        const imported = await import(pathToFileURL(resolved).href);
        this.moduleCache.set(pkgName, imported);
      } catch {
        // If import fails, leave it uncached; require() will throw later.
      }
    }
  }

  private safeRequire(mod: string): unknown {
    const fail = () => {
      throw new Error(`Module '${mod}' not available in sandbox`);
    };

    if (typeof mod !== 'string') {
      fail();
    }

    const spec = mod.trim();
    if (!spec) {
      fail();
    }

    if (isPathLike(spec) || isBuiltinModule(spec)) {
      fail();
    }

    const root = getPackageRootName(spec);
    if (!this.allowedModules.has(root)) {
      fail();
    }

    // Prefer cached modules (needed for ESM-only packages)
    const cached = this.moduleCache.get(spec);
    if (cached) {
      return cached;
    }

    try {
      const loaded = this.requireFromBase(spec) as unknown;
      // Cache exact specifier to avoid repeated resolution
      this.moduleCache.set(spec, loaded);
      return loaded;
    } catch {
      fail();
    }
  }

  private buildSandbox(outputLines: string[], onOutput?: OutputCallback): Record<string, unknown> {
    const makeLine = (args: unknown[]) => args.map(String).join(' ');

    const consoleObj = {
      log: (...args: unknown[]) => {
        const line = makeLine(args);
        outputLines.push(line);
        onOutput?.(line + '\n', false);
      },
      error: (...args: unknown[]) => {
        const line = '[ERROR] ' + makeLine(args);
        outputLines.push(line);
        onOutput?.(line + '\n', true);
      },
      warn: (...args: unknown[]) => {
        const line = '[WARN] ' + makeLine(args);
        outputLines.push(line);
        onOutput?.(line + '\n', false);
      },
      info: (...args: unknown[]) => {
        const line = '[INFO] ' + makeLine(args);
        outputLines.push(line);
        onOutput?.(line + '\n', false);
      },
    };

    const sandbox: Record<string, unknown> = {
      console: consoleObj,
      require: (m: string) => this.safeRequire(m),
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

    return sandbox;
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
      await this.ensureAllowedModulesPreloaded();

      // 1. Wrap code in async IIFE BEFORE transforming so esbuild sees await inside a function
      const wrappedTs = `(async () => {\n${code}\n})()`;

      // 2. Transform TypeScript to JavaScript
      const { code: jsCode } = await transform(wrappedTs, {
        loader: 'ts',
        format: 'cjs',      // CommonJS for vm compatibility
        target: 'es2022',
      });

      // 3. Create sandbox context with restricted require() and optional Kubernetes globals
      const sandbox: Record<string, unknown> = this.buildSandbox(outputLines);

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
      await this.ensureAllowedModulesPreloaded();

      // 1. Wrap code in async IIFE BEFORE transforming
      const wrappedTs = `(async () => {\n${code}\n})()`;

      // 2. Transform TypeScript to JavaScript
      const { code: jsCode } = await transform(wrappedTs, {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
      });

      // 3. Create sandbox context with restricted require() and optional Kubernetes globals
      const sandbox: Record<string, unknown> = this.buildSandbox(outputLines, onOutput);

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
