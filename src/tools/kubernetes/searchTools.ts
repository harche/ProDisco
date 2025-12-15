/**
 * Search Tools - Unified search for methods and types across libraries
 *
 * This is a thin wrapper around @prodisco/search-libs and @prodisco/prometheus-client.
 * It provides the MCP tool interface for searching indexed TypeScript libraries.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { SCRIPTS_CACHE_DIR } from '../../util/paths.js';
import { logger } from '../../util/logger.js';

import {
  LibraryIndexer,
  type PackageConfig,
  type BaseDocument,
  type SearchResult,
  formatResults,
} from '@prodisco/search-libs';

// ============================================================================
// Search Configuration Constants
// ============================================================================

/** Maximum number of relevant scripts to show in method search results */
const MAX_RELEVANT_SCRIPTS = 5;

// ============================================================================
// Indexed Libraries
// ============================================================================

/**
 * Library names that are indexed and searchable.
 * These are the valid values for the `library` filter parameter.
 */
const INDEXED_LIBRARIES = [
  '@kubernetes/client-node',
  '@prodisco/prometheus-client',
  '@prodisco/loki-client',
  'simple-statistics',
] as const;

// ============================================================================
// Input Schema
// ============================================================================

const SearchToolsInputSchema = z.object({
  // === Search parameters ===
  query: z
    .string()
    .optional()
    .describe('Search term - searches names, descriptions, and types'),

  // === Filter parameters ===
  documentType: z
    .enum(['method', 'type', 'function', 'script', 'all'])
    .optional()
    .default('all')
    .describe('Filter by document type: "method" (class methods), "type" (classes, interfaces, enums), "function" (standalone functions), "script" (cached scripts), or "all"'),

  category: z
    .string()
    .optional()
    .describe('Filter by category (e.g., list, create, read, delete, patch for methods; class, interface, enum for types)'),

  library: z
    .enum([...INDEXED_LIBRARIES, 'all'])
    .optional()
    .default('all')
    .describe(
      'Filter by library: ' +
      '"@kubernetes/client-node" (Kubernetes API client), ' +
      '"@prodisco/prometheus-client" (Prometheus queries & metric discovery), ' +
      '"@prodisco/loki-client" (Loki log queries), ' +
      '"simple-statistics" (statistical analysis functions), ' +
      'or "all"'
    ),

  exclude: z
    .object({
      categories: z
        .array(z.string())
        .optional()
        .describe('Categories to exclude'),
      libraries: z
        .array(z.string())
        .optional()
        .describe('Libraries to exclude'),
    })
    .optional()
    .describe('Exclusion criteria'),

  // === Pagination ===
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .optional()
    .describe('Maximum number of results to return'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .optional()
    .describe('Number of results to skip for pagination (default: 0)'),
});

// ============================================================================
// Result Types
// ============================================================================

/** Relevant script for display (NO filePath - security: agent should not see internal paths) */
type RelevantScript = {
  filename: string;
  description: string;
  apiClasses: string[];
};

/** Unified search result type */
type SearchToolsResult = {
  summary: string;
  results: Array<{
    id: string;
    documentType: string;
    name: string;
    description: string;
    library: string;
    category: string;
    // Method-specific
    className?: string;
    parameters?: Array<{ name: string; type: string; optional: boolean; description?: string; typeDefinition?: string }>;
    returnType?: string;
    returnTypeDefinition?: string;
    signature?: string;
    // Type-specific
    properties?: Array<{ name: string; type: string; optional: boolean; description?: string }>;
    typeDefinition?: string;
    nestedTypes?: string[];
    typeKind?: string;
  }>;
  totalMatches: number;
  relevantScripts: RelevantScript[];
  facets: {
    documentType: Record<string, number>;
    library: Record<string, number>;
    category: Record<string, number>;
  };
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  searchTime: number;
  usage: string;
  paths: {
    scriptsDirectory: string;
  };
};

// ============================================================================
// Package Configuration
// ============================================================================

/**
 * Libraries to index - generic extraction via TypeScript AST
 */
const PACKAGES_TO_INDEX: PackageConfig[] = [
  { name: '@kubernetes/client-node' },
  { name: '@prodisco/prometheus-client' },
  { name: '@prodisco/loki-client' },
  { name: 'simple-statistics' },
];

// ============================================================================
// Search Tools Service
// ============================================================================

/**
 * SearchToolsService - Indexes TypeScript library APIs for search
 */
class SearchToolsService {
  private indexer: LibraryIndexer | null = null;
  private initialized = false;

  /**
   * Initialize the search service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create and initialize the library indexer
    this.indexer = new LibraryIndexer({
      packages: PACKAGES_TO_INDEX,
    });

    const initResult = await this.indexer.initialize();
    logger.info(`Search index initialized: ${initResult.indexed} documents indexed`);

    if (initResult.errors.length > 0) {
      logger.warn(`Index initialization had ${initResult.errors.length} errors`);
    }

    // Index scripts from the cache directory
    try {
      const scriptsAdded = await this.indexer.addScriptsFromDirectory(SCRIPTS_CACHE_DIR, {
        recursive: true,
      });
      logger.info(`Indexed ${scriptsAdded} scripts from ${SCRIPTS_CACHE_DIR}`);
    } catch (error) {
      logger.warn(`Failed to index scripts: ${error}`);
    }

    this.initialized = true;
  }

  /**
   * Search the index
   */
  async search(options: {
    query?: string;
    documentType?: string;
    category?: string;
    library?: string;
    exclude?: { categories?: string[]; libraries?: string[] };
    limit: number;
    offset: number;
  }): Promise<SearchResult<BaseDocument>> {
    if (!this.indexer) {
      await this.initialize();
    }

    // Pass through to search-libs directly - convert 'all' to undefined
    return this.indexer!.search({
      query: options.query,
      documentType: options.documentType === 'all' ? undefined : options.documentType,
      category: options.category,
      library: options.library === 'all' ? undefined : options.library,
      exclude: options.exclude,
      limit: options.limit,
      offset: options.offset,
    });
  }

  /**
   * Get relevant scripts for the query
   */
  async getRelevantScripts(query?: string): Promise<RelevantScript[]> {
    if (!this.indexer || !query) {
      return [];
    }

    const result = await this.indexer.search({
      query,
      documentType: 'script',
      limit: MAX_RELEVANT_SCRIPTS,
    });

    return result.results.map((doc) => ({
      filename: doc.name,
      description: doc.description,
      apiClasses: doc.keywords ? doc.keywords.split(' ').filter(Boolean) : [],
    }));
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    if (this.indexer) {
      await this.indexer.shutdown();
      this.indexer = null;
    }

    this.initialized = false;
  }

  /**
   * Index a cache entry (script) that was just created.
   * Called by runSandbox when a script is cached.
   */
  async indexCacheEntry(entry: {
    name: string;
    description: string;
    createdAtMs: number;
    contentHash?: string;
  }): Promise<void> {
    if (!this.indexer) {
      await this.initialize();
    }

    // Try to add the script using the addScript method
    // The script should now be in the cache directory
    const filePath = `${SCRIPTS_CACHE_DIR}/${entry.name}`;
    try {
      await this.indexer!.addScript(filePath);
      logger.debug(`Indexed cache entry: ${entry.name}`);
    } catch (error) {
      logger.warn(`Failed to index cache entry ${entry.name}: ${error}`);
    }
  }
}

// Singleton instance - exported for use by runSandbox.ts
export const searchToolsService = new SearchToolsService();

// ============================================================================
// Search Execution
// ============================================================================

/**
 * Execute search and format results
 */
async function executeSearchMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<SearchToolsResult> {
  const {
    query = '',
    documentType = 'all',
    category,
    library,
    exclude,
    limit = 10,
    offset = 0,
  } = input;

  // Execute search
  const searchResult = await searchToolsService.search({
    query,
    documentType,
    category,
    library,
    exclude,
    limit,
    offset,
  });

  // Get relevant scripts
  const relevantScripts = await searchToolsService.getRelevantScripts(query);

  // Format results
  const formatted = formatResults(searchResult, {
    maxProperties: 20,
    includeFilePaths: false,
  });

  const hasMore = offset + limit < searchResult.totalMatches;

  // Build summary
  let summary = '';

  // Add workflow guidance based on query patterns
  const queryLower = query.toLowerCase();
  const isMetricsQuery = /\b(memory|cpu|disk|network|node|pod|container|usage|consumption|utilization|metrics?)\b/.test(queryLower);
  const isLogsQuery = /\b(log|logs|error|warn|debug|trace)\b/.test(queryLower);

  if (isMetricsQuery && (!library || library === 'all' || library === '@prodisco/prometheus-client')) {
    summary += '**PROMETHEUS WORKFLOW:**\n';
    summary += '1. First discover available metrics: `await prom.findMetrics(/memory/i)`\n';
    summary += '2. Then query the discovered metrics: `await prom.queryRange("metric_name", { start, end, step })`\n';
    summary += '3. Access results: `result.data[i].labels`, `result.data[i].samples[j].value`\n\n';
  }

  if (isLogsQuery && (!library || library === 'all' || library === '@prodisco/loki-client')) {
    summary += '**LOKI WORKFLOW:**\n';
    summary += '1. Query logs: `await loki.queryRange({ query: \'{namespace="default"}\', start, end })`\n';
    summary += '2. Access results: `result.streams[i].labels`, `result.streams[i].entries[j].line`\n\n';
  }

  summary += formatted.summary + '\n\n';

  formatted.items.forEach((item, idx) => {
    // Show className for methods (e.g., "CoreV1Api.listPodForAllNamespaces")
    const displayName = item.className ? `${item.className}.${item.name}` : item.name;
    summary += `${offset + idx + 1}. **${displayName}** (${item.type})\n`;
    summary += `   Library: ${item.library} | Category: ${item.category}\n`;
    summary += `   ${item.description.substring(0, 120)}${item.description.length > 120 ? '...' : ''}\n`;

    if (item.type === 'type') {
      if (item.properties && item.properties.length > 0) {
        const props = item.properties
          .slice(0, 5)
          .map((p) => `${p.name}: ${p.type}`)
          .join(', ');
        summary += `   Properties: ${props}${item.properties.length > 5 ? ` ... +${item.properties.length - 5} more` : ''}\n`;
      }
      if (item.nestedTypes && item.nestedTypes.length > 0) {
        summary += `   Nested types: ${item.nestedTypes.slice(0, 5).join(', ')}${item.nestedTypes.length > 5 ? ` ... +${item.nestedTypes.length - 5} more` : ''}\n`;
      }
    } else {
      if (item.parameters && item.parameters.length > 0) {
        const params = item.parameters.map((p) => {
          const typeDef = p.typeDefinition ? ` = ${p.typeDefinition}` : '';
          return `${p.name}${p.optional ? '?' : ''}: ${p.type}${typeDef}`;
        }).join(', ');
        summary += `   Params: (${params})\n`;
      }
      if (item.returnType) {
        const returnDef = item.returnTypeDefinition ? ` = ${item.returnTypeDefinition}` : '';
        summary += `   Returns: ${item.returnType}${returnDef}\n`;
      }
    }
    summary += '\n';
  });

  if (formatted.items.length === 0) {
    summary += 'No results found. Try:\n';
    summary += '- Different query term\n';
    summary += '- Omit filters to see more results\n';
    summary += `- Use library filter: ${INDEXED_LIBRARIES.join(', ')}\n`;
  }

  const usage =
    'USAGE:\n' +
    '- New code: runSandbox({ code: "..." })\n' +
    '- Cached script: runSandbox({ cached: "script-name.ts" })\n' +
    '- Execution modes: "execute" (blocking), "stream" (real-time), "async" (non-blocking)\n' +
    '\n' +
    'LIBRARY IMPORTS:\n' +
    '- Prometheus: const { PrometheusClient } = require("@prodisco/prometheus-client"); const prom = new PrometheusClient({ endpoint: process.env.PROMETHEUS_URL });\n' +
    '- Loki: const { LokiClient } = require("@prodisco/loki-client"); const client = new LokiClient({ baseUrl: process.env.LOKI_URL });\n' +
    '- Analytics: require("simple-statistics"), require("ml-regression"), require("mathjs"), require("fft-js")\n' +
    '- K8s: k8s and kc (KubeConfig) are pre-configured globals\n' +
    '\n' +
    'LIVE METRIC DISCOVERY:\n' +
    '- To find available metrics in the cluster: const { MetricDiscovery, PrometheusClient } = require("@prodisco/prometheus-client"); const discovery = new MetricDiscovery(new PrometheusClient({ endpoint: process.env.PROMETHEUS_URL }));\n' +
    '- Search by pattern: await discovery.searchMetrics(/memory/i)\n' +
    '- List all: await discovery.discoverMetrics()';

  // Map results to expected format
  const results = formatted.items.map((item) => ({
    id: item.id,
    documentType: item.type,
    name: item.name,
    description: item.description,
    library: item.library,
    category: item.category,
    className: item.className,
    parameters: item.parameters,
    returnType: item.returnType,
    returnTypeDefinition: item.returnTypeDefinition,
    signature: item.signature,
    properties: item.properties,
    typeDefinition: item.typeDefinition,
    nestedTypes: item.nestedTypes,
    typeKind: item.typeKind,
  }));

  return {
    summary,
    results,
    totalMatches: searchResult.totalMatches,
    relevantScripts,
    facets: searchResult.facets,
    pagination: {
      offset,
      limit,
      hasMore,
    },
    searchTime: searchResult.searchTime,
    usage,
    paths: {
      scriptsDirectory: SCRIPTS_CACHE_DIR,
    },
  };
}

// ============================================================================
// Warmup Export
// ============================================================================

/**
 * Pre-warm the search index during server startup.
 */
export async function warmupSearchIndex(): Promise<void> {
  await searchToolsService.initialize();
}

/**
 * Shutdown the search tools service.
 */
export async function shutdownSearchIndex(): Promise<void> {
  await searchToolsService.shutdown();
}

// ============================================================================
// Main Tool Export
// ============================================================================

export const searchToolsTool: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'searchTools',
  description:
    'Search for API methods and types across indexed TypeScript libraries. ' +
    '\n\n' +
    '**CRITICAL - PROMETHEUS METRICS WORKFLOW:** ' +
    'To query metrics (memory, CPU, disk, etc.), you MUST first discover what metrics exist in the cluster. ' +
    'Step 1: Search for "findMetrics" to find the discovery API. ' +
    'Step 2: Use findMetrics(/pattern/) to discover available metric names. ' +
    'Step 3: Use queryRange() to query the discovered metrics. ' +
    'DO NOT guess metric names - always discover first!' +
    '\n\n' +
    '**INDEXED LIBRARIES:** ' +
    '@kubernetes/client-node (K8s API), ' +
    '@prodisco/prometheus-client (Prometheus queries), ' +
    '@prodisco/loki-client (Loki logs), ' +
    'simple-statistics (stats functions). ' +
    '\n\n' +
    'FILTERS: library, documentType (method|type|function|script|all), category',
  schema: SearchToolsInputSchema,
  async execute(input) {
    return executeSearchMode(input);
  },
};
