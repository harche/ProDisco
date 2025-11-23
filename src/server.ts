import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
import { searchToolsTool } from './tools/kubernetes/searchTools.js';
import {
  PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH,
  listGeneratedFiles,
  readGeneratedFile,
} from './resources/filesystem.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.resolve(__dirname, '../dist/servers');

if (!existsSync(GENERATED_DIR)) {
  throw new Error(
    `Unable to find generated Kubernetes modules at ${GENERATED_DIR}. Run "npm run build && npm run codegen" first.`,
  );
}

const server = new McpServer(
  {
    name: 'kubernetes-mcp',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
  },
  {
    instructions:
      'Kubernetes operations via Code Execution pattern. Explore the filesystem at file:///dist/servers/kubernetes/ to discover available TypeScript modules. Read the .ts files to understand each operation, then write code that imports and uses them. Example: import * as k8s from "./dist/servers/kubernetes/index.js"; const pods = await k8s.listPods({});',
  },
);

// Expose generated TypeScript files as MCP resources using ResourceTemplate
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const resourceTemplate = new ResourceTemplate(
  'file:///{path}',
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

// Register only the kubernetes.searchTools helper as an exposed tool.
server.registerTool(
  searchToolsTool.name,
  {
    title: 'Kubernetes Tool Search',
    description: searchToolsTool.description,
    inputSchema: searchToolsTool.schema,
  },
  async (args) => {
    const parsedArgs = await searchToolsTool.schema.parseAsync(args);
    const result = await searchToolsTool.execute(parsedArgs);
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
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Kubernetes MCP server ready on stdio');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server', error);
  process.exit(1);
});


