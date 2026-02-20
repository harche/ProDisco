#!/usr/bin/env node
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './util/logger.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
import { createSearchToolsTool, warmupSearchIndex, shutdownSearchIndex, type SearchToolsRuntimeConfig } from './tools/prodisco/searchTools.js';
import { createRunSandboxTool } from './tools/prodisco/runSandbox.js';
import { getSandboxClient, closeSandboxClient } from '@prodisco/sandbox-server/client';
import {
  DEFAULT_LIBRARIES_CONFIG,
  loadLibrariesConfigFile,
  type LibrarySpec,
} from './config/libraries.js';
import type { AnyToolDefinition, ToolExecutionContext } from './tools/types.js';
import { SandboxManager, type SandboxMode } from './sandbox-manager.js';

// Track the sandbox server subprocess
let sandboxProcess: ChildProcess | null = null;
let sandboxShuttingDown = false;
let sandboxRestartCount = 0;
const MAX_SANDBOX_RESTARTS = 5;
const SANDBOX_RESTART_WINDOW_MS = 60_000; // reset restart count after 1 minute of stability
let sandboxRestartWindowTimer: ReturnType<typeof setTimeout> | null = null;

// Track the HTTP server (when using HTTP transport)
let httpServer: Server | null = null;

// Track the sandbox manager (single or multi mode)
let sandboxManager: SandboxManager | null = null;
import {
  PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH,
  listGeneratedFiles,
  readGeneratedFile,
} from './resources/filesystem.js';
import { PACKAGE_ROOT, SCRIPTS_CACHE_DIR } from './util/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.resolve(__dirname, 'tools/prodisco');

function formatLibrariesForAgent(libraries: LibrarySpec[]): string {
  return libraries
    .map((l) => (l.description ? `${l.name} (${l.description})` : l.name))
    .join(', ');
}

function buildServerInstructions(libraries: LibrarySpec[]): string {
  const libs = formatLibrariesForAgent(libraries);
  return (
    '**ALWAYS SEARCH BEFORE WRITING CODE.** ' +
    'Call prodisco.searchTools first to discover APIs, methods, and correct usage patterns. ' +
    'Do NOT guess method names or parameters - search to find them. ' +
    '\n\n' +
    `CONFIGURED LIBRARIES: ${libs}` +
    '\n\n' +
    'WORKFLOW: ' +
    '1. Call prodisco.searchTools with a relevant query ' +
    '2. Review results to find correct APIs ' +
    '3. Call prodisco.runSandbox to execute code using discovered APIs'
  );
}

function registerGeneratedResources(mcpServer: McpServer): void {
  const resourceTemplate = new ResourceTemplate(
    `file://${PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH}{path}`,
    {
      list: async () => {
        const files = await listGeneratedFiles(GENERATED_DIR);
        return {
          resources: files.map((f) => ({
            uri: f.uri,
            name: f.name,
            description: f.description,
            mimeType: f.mimeType,
          })),
        };
      },
    },
  );

  mcpServer.registerResource(
    'generated-typescript-files',
    resourceTemplate,
    {
      description: 'Generated TypeScript modules for Kubernetes operations',
    },
    async (uri) => {
      // Extract relative path from canonical URI
      const requestedPath = decodeURIComponent(uri.pathname);
      const normalizedRoot = PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH;

      if (!requestedPath.startsWith(normalizedRoot)) {
        throw new Error(`Resource ${requestedPath} is outside ${normalizedRoot}`);
      }

      const relativePosixPath = requestedPath.slice(normalizedRoot.length);
      if (!relativePosixPath) {
        throw new Error('Resource path missing');
      }

      const relativePath = relativePosixPath.split('/').join(path.sep);
      const content = await readGeneratedFile(GENERATED_DIR, relativePath);

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/typescript',
            text: content,
          },
        ],
      };
    },
  );

  logger.info(`Exposed ${GENERATED_DIR} as MCP resources`);
}

import { buildRunSandboxText } from './util/format-sandbox-result.js';

/** Cached app HTML content (loaded once on first read). */
let cachedAppHtml: string | null = null;

/**
 * Load the bundled runSandbox app HTML from dist/apps/, caching in memory.
 */
function loadAppHtml(): string {
  if (cachedAppHtml !== null) return cachedAppHtml;
  const appPath = path.join(__dirname, 'apps', 'runSandbox', 'index.html');
  cachedAppHtml = fs.readFileSync(appPath, 'utf-8');
  return cachedAppHtml;
}

const RUN_SANDBOX_APP_URI = 'ui://prodisco/runSandbox.html';

function registerTools(
  mcpServer: McpServer,
  tools: { searchTools: AnyToolDefinition; runSandbox: AnyToolDefinition },
  options: { enableApps: boolean } = { enableApps: false },
): void {
  const searchTools = tools.searchTools;
  const runSandbox = tools.runSandbox;

  // Register prodisco.searchTools helper as an exposed tool (no app UI for this one).
  mcpServer.registerTool(
    searchTools.name,
    {
      title: 'ProDisco Search Tools',
      description: searchTools.description,
      inputSchema: searchTools.schema,
    },
    async (args: Record<string, unknown>) => {
      const parsedArgs = await searchTools.schema.parseAsync(args);
      const result = await searchTools.execute(parsedArgs);

      return {
        content: [
          {
            type: 'text' as const,
            text: result.summary,
          },
          {
            type: 'text' as const,
            text: JSON.stringify(result.results, null, 2),
          },
        ],
      };
    },
  );

  // RunSandbox text-only handler for non-app clients
  const runSandboxHandler = async (args: Record<string, unknown>, extra: { sessionId?: string }) => {
    const parsedArgs = await runSandbox.schema.parseAsync(args);
    const context: ToolExecutionContext = { sessionId: extra.sessionId };
    const result = await runSandbox.execute(parsedArgs, context);
    const text = buildRunSandboxText(result as Record<string, unknown>);

    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    };
  };

  // RunSandbox app handler — passes structured result via _meta for the app UI
  // and annotates text content as assistant-only to avoid duplicate display
  const runSandboxAppHandler = async (args: Record<string, unknown>, extra: { sessionId?: string }) => {
    const parsedArgs = await runSandbox.schema.parseAsync(args);
    const context: ToolExecutionContext = { sessionId: extra.sessionId };
    const result = await runSandbox.execute(parsedArgs, context);
    const text = buildRunSandboxText(result as Record<string, unknown>);

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
  };

  if (options.enableApps) {
    // Dynamic import at module level isn't needed — we conditionally require the exports
    // Use registerAppTool + registerAppResource from @modelcontextprotocol/ext-apps/server
    let registerAppTool: typeof import('@modelcontextprotocol/ext-apps/server').registerAppTool;
    let registerAppResource: typeof import('@modelcontextprotocol/ext-apps/server').registerAppResource;
    let RESOURCE_MIME_TYPE: typeof import('@modelcontextprotocol/ext-apps/server').RESOURCE_MIME_TYPE;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const extApps = require('@modelcontextprotocol/ext-apps/server');
      registerAppTool = extApps.registerAppTool;
      registerAppResource = extApps.registerAppResource;
      RESOURCE_MIME_TYPE = extApps.RESOURCE_MIME_TYPE;
    } catch (err) {
      logger.warn(`Failed to load @modelcontextprotocol/ext-apps/server, falling back to standard registration: ${err}`);
      // Fall back to standard registration
      mcpServer.registerTool(
        runSandbox.name,
        {
          title: 'ProDisco Run Sandbox',
          description: runSandbox.description,
          inputSchema: runSandbox.schema,
        },
        runSandboxHandler,
      );
      return;
    }

    const resourceUri = RUN_SANDBOX_APP_URI;

    // Register the app resource that serves the bundled HTML
    registerAppResource(
      mcpServer,
      resourceUri,
      resourceUri,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE as string,
            text: loadAppHtml(),
          },
        ],
      }),
    );

    // Register runSandbox as an app-enabled tool
    registerAppTool(
      mcpServer,
      runSandbox.name,
      {
        title: 'ProDisco Run Sandbox',
        description: runSandbox.description,
        inputSchema: runSandbox.schema,
        _meta: { ui: { resourceUri } },
      },
      runSandboxAppHandler,
    );

    logger.info('MCP Apps enabled for runSandbox tool');
  } else {
    // Standard registration without app UI
    mcpServer.registerTool(
      runSandbox.name,
      {
        title: 'ProDisco Run Sandbox',
        description: runSandbox.description,
        inputSchema: runSandbox.schema,
      },
      runSandboxHandler,
    );
  }
}

/**
 * Check if TCP transport is configured via environment variables.
 */
function isUsingTcpTransport(): boolean {
  const envUseTcp = process.env.SANDBOX_USE_TCP;
  if (envUseTcp === 'true' || envUseTcp === '1') {
    return true;
  }
  // If TCP host or port is specified, assume TCP mode
  if (process.env.SANDBOX_TCP_HOST || process.env.SANDBOX_TCP_PORT) {
    return true;
  }
  return false;
}

/**
 * Start the gRPC sandbox server.
 * In TCP mode, connects to an existing remote sandbox server.
 * In local mode (default), spawns a subprocess.
 */
async function startSandboxServer(): Promise<void> {
  // If using TCP transport, connect to remote sandbox server instead of spawning subprocess
  if (isUsingTcpTransport()) {
    const host = process.env.SANDBOX_TCP_HOST || 'localhost';
    const port = process.env.SANDBOX_TCP_PORT || '50051';
    logger.info(`Connecting to remote sandbox server at ${host}:${port}...`);

    const client = getSandboxClient(); // Will use TCP env vars automatically
    const healthy = await client.waitForHealthy(10000);

    if (!healthy) {
      throw new Error(`Remote sandbox server at ${host}:${port} is not reachable`);
    }

    logger.info('Remote sandbox server is ready');
    return;
  }

  // Local mode: spawn subprocess
  const socketPath = process.env.SANDBOX_SOCKET_PATH || '/tmp/prodisco-sandbox.sock';
  await spawnSandboxProcess(socketPath);
}

/**
 * Spawn the sandbox server subprocess and wait for it to become healthy.
 */
async function spawnSandboxProcess(socketPath: string): Promise<void> {
  // Use require.resolve to find the sandbox-server package, works both in development
  // (where it's in packages/) and when installed from npm (where it's in node_modules/)
  const sandboxServerPath = require.resolve('@prodisco/sandbox-server/server');

  logger.info('Starting sandbox gRPC server...');

  // Close any existing gRPC client before (re)spawning
  closeSandboxClient();

  sandboxProcess = spawn('node', [sandboxServerPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SANDBOX_SOCKET_PATH: socketPath,
      SCRIPTS_CACHE_DIR,
    },
  });

  // Log sandbox server output
  sandboxProcess.stdout?.on('data', (data: Buffer) => {
    logger.info(`[sandbox] ${data.toString().trim()}`);
  });

  sandboxProcess.stderr?.on('data', (data: Buffer) => {
    logger.error(`[sandbox] ${data.toString().trim()}`);
  });

  sandboxProcess.on('error', (error) => {
    logger.error('Sandbox server process error', error);
  });

  sandboxProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      logger.error(`Sandbox server exited with code ${code}`);
    } else if (signal) {
      logger.info(`Sandbox server terminated by signal ${signal}`);
    }
    sandboxProcess = null;

    // Auto-restart unless we're shutting down intentionally
    if (!sandboxShuttingDown) {
      sandboxRestartCount++;
      if (sandboxRestartCount > MAX_SANDBOX_RESTARTS) {
        logger.error(`Sandbox server crashed ${sandboxRestartCount} times within the restart window, not restarting`);
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, sandboxRestartCount - 1), 10_000);
      logger.info(`Sandbox server died unexpectedly, restarting in ${delay}ms (attempt ${sandboxRestartCount}/${MAX_SANDBOX_RESTARTS})...`);

      setTimeout(() => {
        if (sandboxShuttingDown) return;
        spawnSandboxProcess(socketPath).catch((err) => {
          logger.error('Failed to restart sandbox server', err);
        });
      }, delay);

      // Reset restart count after a period of stability
      if (sandboxRestartWindowTimer) clearTimeout(sandboxRestartWindowTimer);
      sandboxRestartWindowTimer = setTimeout(() => {
        sandboxRestartCount = 0;
      }, SANDBOX_RESTART_WINDOW_MS);
    }
  });

  // Wait for the sandbox server to become healthy
  const client = getSandboxClient({ socketPath });
  const healthy = await client.waitForHealthy(10000);

  if (!healthy) {
    throw new Error('Sandbox server failed to start within timeout');
  }

  logger.info('Sandbox gRPC server is ready');
}

/**
 * Stop the sandbox server subprocess (only in local mode).
 */
function stopSandboxServer(): void {
  sandboxShuttingDown = true;
  if (sandboxRestartWindowTimer) clearTimeout(sandboxRestartWindowTimer);
  closeSandboxClient();

  // Only stop subprocess if running in local mode
  if (sandboxProcess) {
    logger.info('Stopping sandbox server...');
    sandboxProcess.kill('SIGTERM');
    sandboxProcess = null;
  }
}

/**
 * Parse command line arguments for transport configuration.
 */
function parseArgs(args: string[]): {
  keepCache: boolean;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  configPath?: string;
  enableApps: boolean;
  sandboxMode: SandboxMode;
} {
  const keepCache = args.includes('--keep-cache');

  // --config <path> (optional)
  const configIdx = args.indexOf('--config');
  let configPath: string | undefined;
  if (configIdx !== -1) {
    const value = args[configIdx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for --config <path>');
    }
    configPath = value;
  }

  // Environment fallback for config path
  if (!configPath && process.env.PRODISCO_CONFIG_PATH) {
    configPath = process.env.PRODISCO_CONFIG_PATH;
  }

  // Check for --transport flag
  const transportIdx = args.indexOf('--transport');
  let transport: 'stdio' | 'http' = 'stdio';
  if (transportIdx !== -1) {
    const value = args[transportIdx + 1];
    if (value) {
      const lowerValue = value.toLowerCase();
      if (lowerValue === 'http' || lowerValue === 'sse') {
        transport = 'http';
      } else if (lowerValue !== 'stdio') {
        logger.warn(`Unknown transport "${value}", defaulting to stdio`);
      }
    }
  }

  // Check for --port flag (implies HTTP transport)
  const portIdx = args.indexOf('--port');
  let port = 3000;
  if (portIdx !== -1) {
    const portValue = args[portIdx + 1];
    if (portValue) {
      port = parseInt(portValue, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${portValue}`);
      }
      transport = 'http'; // --port implies HTTP transport
    }
  }

  // Check for --host flag
  const hostIdx = args.indexOf('--host');
  let host = '127.0.0.1';
  if (hostIdx !== -1) {
    const hostValue = args[hostIdx + 1];
    if (hostValue) {
      host = hostValue;
    }
  }

  // Environment variables can also configure transport
  if (process.env.MCP_TRANSPORT === 'http' || process.env.MCP_TRANSPORT === 'sse') {
    transport = 'http';
  }
  if (process.env.MCP_PORT) {
    port = parseInt(process.env.MCP_PORT, 10);
    transport = 'http';
  }
  if (process.env.MCP_HOST) {
    host = process.env.MCP_HOST;
  }

  // --enable-apps flag or PRODISCO_ENABLE_APPS env var
  let enableApps = args.includes('--enable-apps');
  if (!enableApps) {
    const envApps = process.env.PRODISCO_ENABLE_APPS;
    if (envApps === 'true' || envApps === '1') {
      enableApps = true;
    }
  }

  // --sandbox-mode flag or SANDBOX_MODE env var
  let sandboxMode: SandboxMode = 'single';
  const sandboxModeIdx = args.indexOf('--sandbox-mode');
  if (sandboxModeIdx !== -1) {
    const value = args[sandboxModeIdx + 1];
    if (value === 'multi') {
      sandboxMode = 'multi';
    }
  }
  if (process.env.SANDBOX_MODE === 'multi') {
    sandboxMode = 'multi';
  }

  return { keepCache, transport, host, port, configPath, enableApps, sandboxMode };
}

/**
 * Start the MCP server with HTTP transport using StreamableHTTPServerTransport.
 */
async function startHttpTransport(
  createMcpServer: () => McpServer,
  host: string,
  port: number,
  manager: SandboxManager,
): Promise<void> {
  // Track active transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health check endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Get session ID from header for existing sessions
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport for this session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else if (req.method === 'POST') {
        // New session - create a new transport and a dedicated McpServer instance
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            logger.info(`New MCP session: ${newSessionId}`);
            manager.onSessionInitialized(newSessionId).catch((err) => {
              logger.error(`Failed to initialize sandbox for session ${newSessionId}`, err);
            });
          },
          onsessionclosed: (closedSessionId) => {
            transports.delete(closedSessionId);
            logger.info(`MCP session closed: ${closedSessionId}`);
            manager.onSessionClosed(closedSessionId).catch((err) => {
              logger.error(`Failed to cleanup sandbox for session ${closedSessionId}`, err);
            });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            manager.onSessionClosed(transport.sessionId).catch((err) => {
              logger.error(`Failed to cleanup sandbox for session ${transport.sessionId}`, err);
            });
          }
        };

        // Each session gets its own McpServer instance to avoid cross-session interference
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } else if (req.method === 'GET') {
        // SSE stream request without existing session - need to init first
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Bad Request',
          message: 'Session not initialized. Send POST request first.'
        }));
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      }
      return;
    }

    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return new Promise((resolve, reject) => {
    httpServer!.on('error', reject);
    httpServer!.listen(port, host, () => {
      logger.info(`ProDisco MCP server ready on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

function packageInstallPath(basePath: string, packageName: string): string {
  const nodeModulesPath = path.join(basePath, 'node_modules');
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/');
    if (parts.length >= 2) {
      return path.join(nodeModulesPath, parts[0]!, parts[1]!);
    }
  }
  return path.join(nodeModulesPath, packageName);
}

function isPackageInstalled(basePath: string, packageName: string): boolean {
  return fs.existsSync(packageInstallPath(basePath, packageName));
}

/**
 * Check if a package is installed in either the cache deps directory or the main node_modules.
 * This handles workspace packages like @prodisco/loki-client which are installed in the main
 * node_modules but not in the cache deps directory.
 */
function isPackageAvailable(depsBasePath: string, packageName: string): boolean {
  // Check the deps cache directory first
  if (isPackageInstalled(depsBasePath, packageName)) {
    return true;
  }
  // Also check the main node_modules (for workspace packages)
  return isPackageInstalled(PACKAGE_ROOT, packageName);
}

async function ensureDepsCacheDir(basePath: string): Promise<void> {
  await fs.promises.mkdir(basePath, { recursive: true });
  const pkgJsonPath = path.join(basePath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    await fs.promises.writeFile(
      pkgJsonPath,
      JSON.stringify({ name: 'prodisco-deps-cache', private: true }, null, 2),
      'utf-8',
    );
  }
}

async function npmInstallPackages(cwd: string, packages: string[]): Promise<void> {
  if (packages.length === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'npm',
      ['install', '--no-audit', '--no-fund', '--no-progress', ...packages],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.info(`[npm] ${line}`);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install failed (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ProDisco MCP Server - Progressive Disclosure

Usage: prodisco-k8s [options]

Transport Options:
  --transport <mode>   Transport mode: stdio (default) or http
  --host <host>        HTTP host to bind to (default: 127.0.0.1)
  --port <port>        HTTP port to listen on (default: 3000, implies --transport http)

Sandbox Options:
  --sandbox-mode <mode>  Sandbox mode: single (default) or multi (per-session sandboxes)

Other Options:
  --config <path>      Path to YAML/JSON config listing libraries to index/allow
  --keep-cache         Keep the scripts cache on startup (cache is cleared by default)
  --enable-apps        Enable MCP Apps UI for runSandbox tool (interactive HTML rendering)
  --help, -h           Show this help message

Environment Variables:
  PRODISCO_CONFIG_PATH         Path to YAML/JSON config listing libraries to index/allow
  PRODISCO_ENABLE_APPS         Enable MCP Apps UI (true/1)
  MCP_TRANSPORT        Transport mode (stdio or http)
  MCP_HOST             HTTP host to bind to
  MCP_PORT             HTTP port to listen on
  SANDBOX_MODE         Sandbox mode: single (default) or multi
  SANDBOX_NAMESPACE    K8s namespace for Sandbox CRDs (default: prodisco)
  SANDBOX_IMAGE        Container image for sandbox pods
  SANDBOX_IDLE_TIMEOUT_MS  Idle session timeout in ms (default: 600000 = 10 min)
  SANDBOX_MAX_SESSIONS Maximum concurrent sandboxes (default: 10)

Examples:
  # Stdio mode (for Claude Desktop, claude mcp add)
  prodisco-k8s

  # Use a custom libraries config (YAML/JSON)
  prodisco-k8s --config prodisco.config.yaml

  # HTTP mode on default port
  prodisco-k8s --transport http

  # HTTP mode on custom port
  prodisco-k8s --port 8080

  # HTTP mode on all interfaces
  prodisco-k8s --host 0.0.0.0 --port 3000
`);
    process.exit(0);
  }

  const { keepCache, transport, host, port, configPath, enableApps, sandboxMode: parsedSandboxMode } = parseArgs(args);
  let sandboxMode = parsedSandboxMode;

  // Load libraries config (defaults to built-in list for backward compatibility)
  const librariesConfig = configPath
    ? await loadLibrariesConfigFile(configPath)
    : DEFAULT_LIBRARIES_CONFIG;

  const libraryNames = librariesConfig.libraries.map((l) => l.name);
  logger.info(`Configured libraries: ${libraryNames.join(', ')}`);

  // Auto-install missing packages into .cache/deps
  const modulesBasePath = path.join(PACKAGE_ROOT, '.cache', 'deps');
  await ensureDepsCacheDir(modulesBasePath);

  const missing = libraryNames.filter((name) => !isPackageAvailable(modulesBasePath, name));
  if (missing.length > 0) {
    logger.info(`Installing ${missing.length} missing package(s) into ${modulesBasePath}...`);
    await npmInstallPackages(modulesBasePath, missing);
  }

  const stillMissing = libraryNames.filter((name) => !isPackageAvailable(modulesBasePath, name));
  if (stillMissing.length > 0) {
    throw new Error(
      `Missing packages even after install: ${stillMissing.join(', ')}`
    );
  }

  logger.info(`Node modules base path: ${modulesBasePath}`);

  // Configure sandbox allowlist for local sandbox-server subprocess
  process.env.SANDBOX_ALLOWED_MODULES = JSON.stringify(libraryNames);
  process.env.SANDBOX_MODULES_BASE_PATH = modulesBasePath;

  const searchToolsRuntimeConfig: SearchToolsRuntimeConfig = {
    libraries: librariesConfig.libraries,
    // Search both cache deps directory (external packages) and main package root (workspace packages)
    basePath: [modulesBasePath, PACKAGE_ROOT],
  };
  // Multi-sandbox mode requires HTTP transport (stdio has no session concept)
  if (sandboxMode === 'multi' && transport === 'stdio') {
    logger.warn('SANDBOX_MODE=multi requires HTTP transport; falling back to single mode');
    sandboxMode = 'single';
  }

  const searchTools = createSearchToolsTool(searchToolsRuntimeConfig);

  // Clear cache by default unless --keep-cache is specified
  if (!keepCache) {
    logger.info('Clearing scripts cache...');
    try {
      await fs.promises.rm(SCRIPTS_CACHE_DIR, { recursive: true, force: true });
      logger.info('Scripts cache cleared');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to clear cache: ${message}`);
    }
  }

  // Ensure scripts cache directory exists (server-controlled location)
  await fs.promises.mkdir(SCRIPTS_CACHE_DIR, { recursive: true });
  logger.info(`Scripts cache directory: ${SCRIPTS_CACHE_DIR}`);

  // Initialize the sandbox manager based on mode
  if (sandboxMode === 'multi') {
    const idleTimeoutMs = parseInt(process.env.SANDBOX_IDLE_TIMEOUT_MS || '600000', 10);
    const maxSessions = parseInt(process.env.SANDBOX_MAX_SESSIONS || '10', 10);
    sandboxManager = new SandboxManager({
      mode: 'multi',
      namespace: process.env.SANDBOX_NAMESPACE || 'prodisco',
      sandboxPort: parseInt(process.env.SANDBOX_TCP_PORT || '50051', 10),
      sandboxImage: process.env.SANDBOX_IMAGE,
      sessionIdleTimeoutMs: idleTimeoutMs,
      maxSessions,
    });
    await sandboxManager.cleanupOrphanedSandboxes();
    logger.info(`Multi-sandbox mode: per-session sandboxes (max=${maxSessions}, idle=${idleTimeoutMs / 1000}s)`);
  } else {
    // Single mode: start/connect to one sandbox, wrap it in SandboxManager
    await startSandboxServer();
    const singleClient = getSandboxClient();
    sandboxManager = new SandboxManager({
      mode: 'single',
      singleClient,
    });
    logger.info('Single-sandbox mode: all sessions share one sandbox');
  }

  // Create runSandbox tool with session-aware client resolver
  const runSandbox = createRunSandboxTool({
    libraries: librariesConfig.libraries,
    enableApps,
    getClient: (sessionId) => sandboxManager!.getClient(sessionId),
  });

  // Factory to create a fresh McpServer instance with all tools/resources registered.
  // Each HTTP session gets its own instance to avoid cross-session interference.
  const createMcpServer = (): McpServer => {
    const server = new McpServer(
      {
        name: 'kubernetes-mcp',
        version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      },
      {
        instructions: buildServerInstructions(librariesConfig.libraries),
      },
    );
    registerGeneratedResources(server);
    registerTools(server, { searchTools, runSandbox }, { enableApps });
    return server;
  };

  // No built-in cluster probes: ProDisco is library-agnostic; connectivity checks are up to user code.

  // Pre-warm the Orama search index to avoid delay on first search
  await warmupSearchIndex(searchToolsRuntimeConfig);

  // Start the appropriate transport
  if (transport === 'http') {
    await startHttpTransport(createMcpServer, host, port, sandboxManager);
  } else {
    const mcpServer = createMcpServer();
    const stdioTransport = new StdioServerTransport();
    await mcpServer.connect(stdioTransport);
    logger.info('ProDisco MCP server ready on stdio');
  }
}

/**
 * Graceful shutdown handler.
 * Stops the sandbox server, HTTP server, and cleans up resources.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
    // Close HTTP server if running
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
      logger.info('HTTP server stopped');
    }

    if (sandboxManager) {
      await sandboxManager.shutdown();
    }
    stopSandboxServer();
    await shutdownSearchIndex();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  logger.error('Fatal error starting MCP server', error);
  process.exit(1);
});


