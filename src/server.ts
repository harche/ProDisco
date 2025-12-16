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
  resolveNodeModulesBasePath,
  type LibrarySpec,
} from './config/libraries.js';
import type { AnyToolDefinition } from './tools/types.js';

// Track the sandbox server subprocess
let sandboxProcess: ChildProcess | null = null;

// Track the HTTP server (when using HTTP transport)
let httpServer: Server | null = null;
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

function registerTools(
  mcpServer: McpServer,
  tools: { searchTools: AnyToolDefinition; runSandbox: AnyToolDefinition },
): void {
  const searchTools = tools.searchTools;
  const runSandbox = tools.runSandbox;

  // Register prodisco.searchTools helper as an exposed tool.
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
        structuredContent: result,
      };
    },
  );

  // Register prodisco.runSandbox tool for executing scripts in a sandboxed environment
  mcpServer.registerTool(
    runSandbox.name,
    {
      title: 'ProDisco Run Sandbox',
      description: runSandbox.description,
      inputSchema: runSandbox.schema,
    },
    async (args: Record<string, unknown>) => {
      const parsedArgs = await runSandbox.schema.parseAsync(args);
      const result = await runSandbox.execute(parsedArgs);

      // Build the output message based on mode
      let text: string;

      if ('error' in result && result.error && !('output' in result)) {
        // Error result without output
        text = `Error: ${result.error}`;
      } else if (result.mode === 'execute' || result.mode === 'stream') {
        // Execution results with output
        const execResult = result as { success: boolean; output: string; error?: string; executionTimeMs: number; cachedScript?: string };
        const cachedInfo = execResult.cachedScript ? ` [cached: ${execResult.cachedScript}]` : '';
        if (execResult.success) {
          text = `Execution successful${cachedInfo} (${execResult.executionTimeMs}ms)\n\nOutput:\n${execResult.output}`;
        } else {
          text = `Execution failed${cachedInfo} (${execResult.executionTimeMs}ms)\n\nError: ${execResult.error}\n\nOutput:\n${execResult.output}`;
        }
      } else if (result.mode === 'async') {
        // Async mode - return execution ID
        const asyncResult = result as { executionId: string; state: string; message: string };
        text = `${asyncResult.message}\n\nExecution ID: ${asyncResult.executionId}\nState: ${asyncResult.state}`;
      } else if (result.mode === 'status') {
        // Status mode - return status and output
        const statusResult = result as { executionId: string; state: string; output: string; errorOutput: string; result?: { success: boolean } };
        const isComplete = statusResult.result !== undefined;
        text = `Execution ${statusResult.executionId}\nState: ${statusResult.state}${isComplete ? ' (completed)' : ''}\n\nOutput:\n${statusResult.output}`;
        if (statusResult.errorOutput) {
          text += `\n\nErrors:\n${statusResult.errorOutput}`;
        }
      } else if (result.mode === 'cancel') {
        // Cancel mode
        const cancelResult = result as { success: boolean; executionId: string; state: string; message?: string };
        text = cancelResult.success
          ? `Execution ${cancelResult.executionId} cancelled. State: ${cancelResult.state}`
          : `Failed to cancel execution ${cancelResult.executionId}: ${cancelResult.message || 'Unknown error'}`;
      } else if (result.mode === 'list') {
        // List mode
        const listResult = result as { executions: Array<{ executionId: string; state: string; codePreview: string }>; totalCount: number };
        if (listResult.executions.length === 0) {
          text = 'No executions found.';
        } else {
          text = `Found ${listResult.totalCount} execution(s):\n\n`;
          for (const exec of listResult.executions) {
            text += `• ${exec.executionId} [${exec.state}]: ${exec.codePreview}\n`;
          }
        }
      } else {
        // Fallback
        text = JSON.stringify(result, null, 2);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
        structuredContent: result,
      };
    },
  );
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
  // Use require.resolve to find the sandbox-server package, works both in development
  // (where it's in packages/) and when installed from npm (where it's in node_modules/)
  const sandboxServerPath = require.resolve('@prodisco/sandbox-server/server');
  const socketPath = process.env.SANDBOX_SOCKET_PATH || '/tmp/prodisco-sandbox.sock';

  logger.info('Starting sandbox gRPC server...');

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
  clearCache: boolean;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  configPath?: string;
  installMissing: boolean;
} {
  const clearCache = args.includes('--clear-cache');

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

  // --install-missing (optional, can also be set via env)
  const envInstall = process.env.PRODISCO_INSTALL_MISSING;
  const installMissing =
    args.includes('--install-missing') ||
    envInstall === '1' ||
    envInstall === 'true';

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

  return { clearCache, transport, host, port, configPath, installMissing };
}

/**
 * Start the MCP server with HTTP transport using StreamableHTTPServerTransport.
 */
async function startHttpTransport(mcpServer: McpServer, host: string, port: number): Promise<void> {
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
        // New session - create a new transport
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            logger.info(`New MCP session: ${newSessionId}`);
          },
          onsessionclosed: (closedSessionId) => {
            transports.delete(closedSessionId);
            logger.info(`MCP session closed: ${closedSessionId}`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        // Connect the transport to the MCP server
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

Other Options:
  --config <path>      Path to YAML/JSON config listing libraries to index/allow
  --install-missing    Auto-install missing libraries into .cache/deps (opt-in)
  --clear-cache        Clear the scripts cache on startup
  --help, -h           Show this help message

Environment Variables:
  PRODISCO_CONFIG_PATH         Path to YAML/JSON config listing libraries to index/allow
  PRODISCO_INSTALL_MISSING     If set to 1/true, auto-install missing libraries into .cache/deps
  MCP_TRANSPORT        Transport mode (stdio or http)
  MCP_HOST             HTTP host to bind to
  MCP_PORT             HTTP port to listen on

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

  const { clearCache, transport, host, port, configPath, installMissing } = parseArgs(args);

  // Load libraries config (defaults to built-in list for backward compatibility)
  const librariesConfig = configPath
    ? await loadLibrariesConfigFile(configPath)
    : DEFAULT_LIBRARIES_CONFIG;

  const libraryNames = librariesConfig.libraries.map((l) => l.name);
  logger.info(`Configured libraries: ${libraryNames.join(', ')}`);

  // Resolve base path for node_modules
  let modulesBasePath: string;

  if (installMissing) {
    modulesBasePath = path.join(PACKAGE_ROOT, '.cache', 'deps');
    await ensureDepsCacheDir(modulesBasePath);

    const missing = libraryNames.filter((name) => !isPackageInstalled(modulesBasePath, name));
    if (missing.length > 0) {
      logger.info(`Installing ${missing.length} missing package(s) into ${modulesBasePath}...`);
      await npmInstallPackages(modulesBasePath, missing);
    }

    const stillMissing = libraryNames.filter((name) => !isPackageInstalled(modulesBasePath, name));
    if (stillMissing.length > 0) {
      throw new Error(
        `Missing packages even after install: ${stillMissing.join(', ')}`
      );
    }
  } else {
    modulesBasePath = resolveNodeModulesBasePath({
      startDir: PACKAGE_ROOT,
      fallbackDir: process.cwd(),
    });

    const missing = libraryNames.filter((name) => !isPackageInstalled(modulesBasePath, name));
    if (missing.length > 0) {
      throw new Error(
        `Missing packages: ${missing.join(', ')}. ` +
        'Install them into your environment or start with --install-missing.'
      );
    }
  }

  logger.info(`Node modules base path: ${modulesBasePath}`);

  // Configure sandbox allowlist for local sandbox-server subprocess
  process.env.SANDBOX_ALLOWED_MODULES = JSON.stringify(libraryNames);
  process.env.SANDBOX_MODULES_BASE_PATH = modulesBasePath;

  const searchToolsRuntimeConfig: SearchToolsRuntimeConfig = {
    libraries: librariesConfig.libraries,
    basePath: modulesBasePath,
  };
  const searchTools = createSearchToolsTool(searchToolsRuntimeConfig);
  const runSandbox = createRunSandboxTool({ libraries: librariesConfig.libraries });

  // Create MCP server with dynamic instructions, then register resources/tools
  const mcpServer = new McpServer(
    {
      name: 'kubernetes-mcp',
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    },
    {
      instructions: buildServerInstructions(librariesConfig.libraries),
    },
  );
  registerGeneratedResources(mcpServer);
  registerTools(mcpServer, { searchTools, runSandbox });

  // Handle --clear-cache flag
  if (clearCache) {
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

  // Start the sandbox gRPC server
  await startSandboxServer();

  // No built-in cluster probes: ProDisco is library-agnostic; connectivity checks are up to user code.

  // Pre-warm the Orama search index to avoid delay on first search
  await warmupSearchIndex(searchToolsRuntimeConfig);

  // Start the appropriate transport
  if (transport === 'http') {
    await startHttpTransport(mcpServer, host, port);
  } else {
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


