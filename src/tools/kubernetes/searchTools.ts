import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import type { ToolDefinition } from '../types.js';
import { kubernetesToolMetadata } from './metadata.js';

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
    inputSchema: unknown;
    outputSchema?: unknown;
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

    // Build list of discoverable Kubernetes tools (excluding search itself to avoid recursion)
    const discoverableTools = kubernetesToolMetadata;

    // Filter tools by query
    let matchedTools = discoverableTools;
    if (query) {
      matchedTools = matchedTools.filter(
        (entry) =>
          entry.tool.name.toLowerCase().includes(query) ||
          entry.tool.description.toLowerCase().includes(query),
      );
    }

    const totalMatches = matchedTools.length;
    const limitedTools = matchedTools.slice(0, limit);

    // Format based on detail level
    const formattedTools = limitedTools.map((entry) => {
      const moduleName = entry.tool.name.replace('kubernetes.', '');
      const resourceUri = `file://${path.join(generatedModulesDir, `${moduleName}.ts`)}`;
      const inputSchemaJson = zodToJsonSchema(entry.tool.schema, `${entry.tool.name}Input`);
      const outputSchemaJson = entry.resultSchema
        ? zodToJsonSchema(entry.resultSchema, `${entry.tool.name}Result`)
        : undefined;

      // Always include the schema so consumers can infer inputs without
      // needing a different detail level.
      const base = {
        name: entry.tool.name,
        resourceUri,
        inputSchema: inputSchemaJson,
        outputSchema: outputSchemaJson,
      };

      switch (detailLevel) {
        case 'name':
          return base;
        case 'summary':
          return {
            ...base,
            description: entry.tool.description,
          };
        case 'full':
          return {
            ...base,
            description: entry.tool.description,
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

