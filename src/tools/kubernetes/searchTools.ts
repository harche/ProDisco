import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { ToolDefinition } from '../types.js';
import { kubernetesTools } from './index.js';

const SearchToolsInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Search query to filter tools by name or description. If omitted, returns all tools.'),
  detailLevel: z
    .enum(['name', 'summary', 'full'])
    .default('summary')
    .describe(
      'Level of detail: "name" (just tool names), "summary" (name + description), "full" (complete definition with schemas)',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(20)
    .optional()
    .describe('Maximum number of results to return'),
});

type SearchToolsResult = {
  summary: string;
  tools: Array<{
    name: string;
    description?: string;
    resourceUri?: string;
    inputSchema?: unknown;
  }>;
  totalMatches: number;
};

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '../../..');
const generatedModulesDir = path.join(repoRoot, 'generated/servers/kubernetes');

export const searchToolsTool: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'kubernetes.searchTools',
  description:
    'Search and discover available Kubernetes tools on-demand. Use this first to locate the relevant TypeScript modules exposed by the MCP server (each result includes a resourceUri), read the tool file (e.g., listPods.ts), then write your own script and execute it with `npx tsx <your_script>.ts` so the MCP environment runs it.',
  schema: SearchToolsInputSchema,
  async execute(input) {
    const query = input.query?.toLowerCase();
    const detailLevel = input.detailLevel ?? 'summary';
    const limit = input.limit ?? 20;

    // Filter tools by query
    let matchedTools = kubernetesTools;
    if (query) {
      matchedTools = matchedTools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(query) ||
          tool.description.toLowerCase().includes(query),
      );
    }

    const totalMatches = matchedTools.length;
    const limitedTools = matchedTools.slice(0, limit);

    // Format based on detail level
    const formattedTools = limitedTools.map((tool) => {
      const moduleName = tool.name.replace('kubernetes.', '');
      const resourceUri = `file://${path.join(generatedModulesDir, `${moduleName}.ts`)}`;

      switch (detailLevel) {
        case 'name':
          return { name: tool.name, resourceUri };
        case 'summary':
          return {
            name: tool.name,
            description: tool.description,
            resourceUri,
          };
        case 'full':
          return {
            name: tool.name,
            description: tool.description,
            resourceUri,
            inputSchema: tool.schema,
          };
      }
    });

    // Create summary text
    let summary = `Found ${totalMatches} tool(s)`;
    if (query) {
      summary += ` matching "${query}"`;
    }
    if (totalMatches > limit) {
      summary += ` (showing first ${limit})`;
    }
    summary += ':\n';
    summary += formattedTools.map((t) => `  - ${t.name}`).join('\n');

    if (detailLevel === 'name') {
      summary += `\n\nUse detailLevel="summary" or "full" to see more details about these tools.`;
    }

    return {
      summary,
      tools: formattedTools,
      totalMatches,
    };
  },
};

