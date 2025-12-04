#!/usr/bin/env node
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './util/logger.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
import { searchToolsTool, warmupSearchIndex, shutdownSearchIndex } from './tools/kubernetes/searchTools.js';
import { runSandboxTool } from './tools/kubernetes/runSandbox.js';
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

  // Ensure scripts cache directory exists (server-controlled location)
  await fs.promises.mkdir(SCRIPTS_CACHE_DIR, { recursive: true });
  logger.info(`Scripts cache directory: ${SCRIPTS_CACHE_DIR}`);

  // Pre-warm the Orama search index to avoid delay on first search
  await warmupSearchIndex();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Kubernetes MCP server ready on stdio');
}

/**
 * Graceful shutdown handler.
 * Stops the script watcher and cleans up resources.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
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


