#!/usr/bin/env node
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './util/logger.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
import { searchToolsTool, warmupSearchIndex, shutdownSearchIndex } from './tools/kubernetes/searchTools.js';
import { runSandboxTool } from './tools/kubernetes/runSandbox.js';
import { getSandboxClient, closeSandboxClient } from '@prodisco/sandbox-server/client';

// Track the sandbox server subprocess
let sandboxProcess: ChildProcess | null = null;
import {
  PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH,
  listGeneratedFiles,
  readGeneratedFile,
} from './resources/filesystem.js';
import { probeClusterConnectivity } from './kube/client.js';
import { SCRIPTS_CACHE_DIR } from './util/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.resolve(__dirname, 'tools/kubernetes');

const server = new McpServer(
  {
    name: 'kubernetes-mcp',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
  },
  {
    instructions:
      'Kubernetes and Prometheus operations via Progressive Disclosure. ' +
      'Use kubernetes.searchTools to discover available APIs. ' +
      'Use kubernetes.runSandbox to execute TypeScript scripts directly. ' +
      'The sandbox provides: k8s, kc (pre-configured KubeConfig), console, and require("prometheus-query").',
  },
);

// Expose generated TypeScript files as MCP resources using ResourceTemplate
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

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

server.registerResource(
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

// Register kubernetes.searchTools helper as an exposed tool.
// This tool now supports both modes: 'methods' (API discovery) and 'types' (type definitions)
server.registerTool(
  searchToolsTool.name,
  {
    title: 'Kubernetes Search Tools',
    description: searchToolsTool.description,
    inputSchema: searchToolsTool.schema,
  },
  async (args: Record<string, unknown>) => {
    const parsedArgs = await searchToolsTool.schema.parseAsync(args);
    const result = await searchToolsTool.execute(parsedArgs);

    // Handle different result modes
    if (result.mode === 'types') {
      return {
        content: [
          {
            type: 'text',
            text: result.summary,
          },
          {
            type: 'text',
            text: JSON.stringify(result.types, null, 2),
          },
        ],
        structuredContent: result,
      };
    } else if (result.mode === 'scripts') {
      return {
        content: [
          {
            type: 'text',
            text: result.summary,
          },
          {
            type: 'text',
            text: JSON.stringify(result.scripts, null, 2),
          },
        ],
        structuredContent: result,
      };
    } else if (result.mode === 'prometheus') {
      // Handle metrics category (has 'metrics' array) vs methods (has 'methods' array)
      if ('category' in result && result.category === 'metrics') {
        return {
          content: [
            {
              type: 'text',
              text: result.summary,
            },
            {
              type: 'text',
              text: JSON.stringify(result.metrics, null, 2),
            },
          ],
          structuredContent: result,
        };
      }
      // Build summary - handle both success and error cases for PrometheusModeResult | PrometheusErrorResult
      const methodsResult = result as { summary?: string; error?: string; message?: string; example?: string; methods: unknown };
      const summary = 'summary' in result ? result.summary :
        `${methodsResult.error}: ${methodsResult.message}\nExample: ${methodsResult.example}`;
      return {
        content: [
          {
            type: 'text',
            text: summary,
          },
          {
            type: 'text',
            text: JSON.stringify(methodsResult.methods, null, 2),
          },
        ],
        structuredContent: result,
      };
    } else {
      // mode === 'methods'
      return {
        content: [
          {
            type: 'text',
            text: result.summary,
          },
          {
            type: 'text',
            text: JSON.stringify(result.tools, null, 2),
          },
        ],
        structuredContent: result,
      };
    }
  },
);

// Register kubernetes.runSandbox tool for executing scripts in a sandboxed environment
server.registerTool(
  runSandboxTool.name,
  {
    title: 'Kubernetes Run Sandbox',
    description: runSandboxTool.description,
    inputSchema: runSandboxTool.schema,
  },
  async (args: Record<string, unknown>) => {
    const parsedArgs = await runSandboxTool.schema.parseAsync(args);
    const result = await runSandboxTool.execute(parsedArgs);

    // Build the output message
    const cachedInfo = result.cachedScript ? ` [cached: ${result.cachedScript}]` : '';
    const successMsg = `Execution successful${cachedInfo} (${result.executionTime}ms)\n\nOutput:\n${result.output}`;
    const failMsg = `Execution failed${cachedInfo} (${result.executionTime}ms)\n\nError: ${result.error}\n\nOutput:\n${result.output}`;

    return {
      content: [
        {
          type: 'text',
          text: result.success ? successMsg : failMsg,
        },
      ],
      structuredContent: result,
    };
  },
);

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

    const healthStatus = await client.healthCheck();
    logger.info(`Remote sandbox server is ready (context: ${healthStatus.kubernetesContext})`);
    return;
  }

  // Local mode: spawn subprocess
  const sandboxServerPath = path.resolve(__dirname, '../packages/sandbox-server/dist/server/index.js');
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

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const clearCache = args.includes('--clear-cache');

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

  // Probe cluster connectivity before starting the server
  // This ensures we fail fast if the cluster is not reachable
  logger.info('Probing Kubernetes cluster connectivity...');
  try {
    await probeClusterConnectivity();
    logger.info('Kubernetes cluster is reachable');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to connect to Kubernetes cluster: ${message}`);
    throw new Error(`Kubernetes cluster is not accessible: ${message}`);
  }

  // Pre-warm the Orama search index to avoid delay on first search
  await warmupSearchIndex();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Kubernetes MCP server ready on stdio');
}

/**
 * Graceful shutdown handler.
 * Stops the sandbox server, script watcher, and cleans up resources.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
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


