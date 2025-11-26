#!/usr/bin/env node
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
import { searchToolsTool, warmupSearchIndex } from './tools/kubernetes/searchTools.js';
import {
  PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH,
  listGeneratedFiles,
  readGeneratedFile,
} from './resources/filesystem.js';

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
      'Kubernetes operations via Progressive Disclosure. Use the kubernetes.searchTools tool to discover available operations. ' +
      'The tool returns available Kubernetes API methods and a "paths.scriptsDirectory" for writing scripts. ' +
      'Write scripts to scriptsDirectory and use bare imports: import * as k8s from \'@kubernetes/client-node\'. ' +
      'The scriptsDirectory has a node_modules symlink that handles package resolution automatically.',
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

console.error(`📁 Exposed ${GENERATED_DIR} as MCP resources`);

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

async function main() {
  // Ensure ~/.prodisco/scripts/cache/ directory exists
  const scriptsDir = path.join(os.homedir(), '.prodisco', 'scripts', 'cache');
  fs.mkdirSync(scriptsDir, { recursive: true });
  console.error(`📝 Scripts directory: ${scriptsDir}`);

  // Pre-warm the Orama search index to avoid delay on first search
  await warmupSearchIndex();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Kubernetes MCP server ready on stdio');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server', error);
  process.exit(1);
});


