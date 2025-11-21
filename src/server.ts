import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
import { tools } from './tools/index.js';
import { searchToolsTool } from './tools/kubernetes/searchTools.js';
import { listGeneratedFiles, readGeneratedFile } from './resources/filesystem.js';

type JsonLike = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.join(__dirname, '../generated');

const server = new McpServer(
  {
    name: 'kubernetes-mcp',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
  },
  {
    instructions:
      'Kubernetes operations via Code Execution pattern. Explore the filesystem at file:///servers/kubernetes/ to discover available TypeScript modules. Read the .ts files to understand each operation, then write code that imports and uses them. Example: import * as k8s from "./servers/kubernetes/index.js"; const pods = await k8s.listPods({});',
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
          uri: `file:///${f.name}`,
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
    // Extract relative path from URI
    const relativePath = uri.pathname.replace(/^\/+/, '');
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

// Register tools as INTERNAL ONLY (for code execution to call via callMCPTool)
// These are NOT exposed to Claude - only the generated TypeScript files are
for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
    },
    async (input: Parameters<typeof tool.execute>[0]) => {
      try {
        const result = await tool.execute(input);
        return formatToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool:${tool.name}] error`, error);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error executing ${tool.name}: ${message}`,
            },
          ],
        };
      }
    },
  );
}

console.error(`✅ Registered ${tools.length} internal tools (callable via code execution)`);
console.error(`📁 Exposed generated/ directory as MCP resources`);

// Override tools/list to only expose the searchTools helper.
const searchToolsListEntry = {
  name: searchToolsTool.name,
  description: searchToolsTool.description,
  inputSchema: zodToJsonSchema(searchToolsTool.schema),
};

server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [searchToolsListEntry],
}));

function formatToolResult(data: unknown) {
  if (typeof data === 'string') {
    return {
      content: [
        {
          type: 'text' as const,
          text: data,
        },
      ],
    };
  }

  if (data && typeof data === 'object') {
    const structured = data as JsonLike;
    return {
      content: [
        {
          type: 'text' as const,
          text: stringifyForContent(structured),
        },
      ],
      structuredContent: structured,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: stringifyForContent(data),
      },
    ],
  };
}

function stringifyForContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const serialized = JSON.stringify(value, null, 2);
  if (!serialized) {
    return String(value);
  }

  const maxLength = 4000;
  if (serialized.length <= maxLength) {
    return serialized;
  }

  return `${serialized.slice(0, maxLength)}\n... truncated (${serialized.length} chars total)`;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Kubernetes MCP server ready on stdio');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server', error);
  process.exit(1);
});


