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
    inputSchema?: unknown;
  }>;
  totalMatches: number;
};

export const searchToolsTool: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'kubernetes.searchTools',
  description:
    'Search and discover available Kubernetes tools on-demand. Use this to find relevant tools before calling them, enabling progressive disclosure of the tool set.',
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
      switch (detailLevel) {
        case 'name':
          return { name: tool.name };
        case 'summary':
          return {
            name: tool.name,
            description: tool.description,
          };
        case 'full':
          return {
            name: tool.name,
            description: tool.description,
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

