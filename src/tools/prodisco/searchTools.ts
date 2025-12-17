/**
 * Search Tools - Unified search for methods and types across libraries
 *
 * This is a thin wrapper around @prodisco/search-libs.
 * It provides the MCP tool interface for searching indexed TypeScript libraries.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { SCRIPTS_CACHE_DIR } from '../../util/paths.js';
import { logger } from '../../util/logger.js';
import {
  DEFAULT_LIBRARIES_CONFIG,
  resolveNodeModulesBasePath,
  type LibrarySpec,
} from '../../config/libraries.js';

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

export type SearchToolsRuntimeConfig = {
  libraries: LibrarySpec[];
  /** Base directory that contains `node_modules/` for resolving packages */
  basePath: string;
};

function getDefaultRuntimeConfig(): SearchToolsRuntimeConfig {
  return {
    libraries: DEFAULT_LIBRARIES_CONFIG.libraries,
    basePath: resolveNodeModulesBasePath(),
  };
}

function normalizeLibraryNames(libraries: LibrarySpec[]): string[] {
  return libraries.map((l) => l.name).slice().sort();
}

function isSameRuntimeConfig(a: SearchToolsRuntimeConfig, b: SearchToolsRuntimeConfig): boolean {
  if (a.basePath !== b.basePath) {
    return false;
  }
  const aNames = normalizeLibraryNames(a.libraries);
  const bNames = normalizeLibraryNames(b.libraries);
  if (aNames.length !== bNames.length) {
    return false;
  }
  for (let i = 0; i < aNames.length; i++) {
    if (aNames[i] !== bNames[i]) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Input Schema
// ============================================================================

function formatLibraryDescribe(libraries: LibrarySpec[]): string {
  return libraries
    .map((l) => `"${l.name}"${l.description ? ` (${l.description})` : ''}`)
    .join(', ');
}

function createSearchToolsInputSchema(libraries: LibrarySpec[]) {
  if (libraries.length === 0) {
    throw new Error('At least one library must be configured for searchTools');
  }

  const libraryNames = libraries.map((l) => l.name);
  // z.enum requires a non-empty tuple type; we already validated libraries.length > 0 above.
  const libraryEnumValues = [libraryNames[0]!, ...libraryNames.slice(1), 'all'] as [string, ...string[]];

  return z.object({
  // === Search by name ===
  methodName: z
    .string()
    .optional()
    .describe(
      'Search for API members by name (methods/types/functions/scripts). ' +
      'Use a class/type/function/method name or keyword relevant to the libraries you configured. ' +
      'Searches indexed TypeScript typings only (no code execution).'
    ),

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
    .enum(libraryEnumValues)
    .optional()
    .default('all')
    .describe(
      'Filter by library: ' +
      `${formatLibraryDescribe(libraries)}, or "all"`
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
}

type SearchToolsInput = z.infer<ReturnType<typeof createSearchToolsInputSchema>>;

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

function toPackageConfigs(libraries: LibrarySpec[]): PackageConfig[] {
  return libraries.map((l) => ({ name: l.name }));
}

// ============================================================================
// Search Tools Service
// ============================================================================

/**
 * SearchToolsService - Indexes TypeScript library APIs for search
 */
class SearchToolsService {
  private indexer: LibraryIndexer | null = null;
  private initialized = false;
  private runtimeConfig: SearchToolsRuntimeConfig = getDefaultRuntimeConfig();

  configure(config: SearchToolsRuntimeConfig): void {
    if (this.initialized) {
      if (isSameRuntimeConfig(this.runtimeConfig, config)) {
        return;
      }
      throw new Error('SearchToolsService is already initialized; shutdown before reconfiguring');
    }
    this.runtimeConfig = config;
  }

  /**
   * Initialize the search service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create and initialize the library indexer
    this.indexer = new LibraryIndexer({
      packages: toPackageConfigs(this.runtimeConfig.libraries),
      basePath: this.runtimeConfig.basePath,
    });

    const initResult = await this.indexer.initialize();
    logger.info(`Search index initialized: ${initResult.indexed} documents indexed`);

    // Enforce current limitation: only packages with TypeScript type definitions are supported for indexing.
    // If a configured package has no .d.ts files (or cannot be resolved), fail fast with a clear error.
    const fatalIndexErrors = initResult.errors
      .filter((e) =>
        typeof e.message === 'string' && (
          e.message.includes('No .d.ts files found for package:') ||
          e.message.includes('Could not resolve package:')
        )
      )
      .map((e) => `${e.file}: ${e.message}`);

    if (fatalIndexErrors.length > 0) {
      throw new Error(
        'One or more configured libraries cannot be indexed because they do not provide TypeScript type definitions (.d.ts).\n' +
        'ProDisco currently supports TypeScript-typed libraries only.\n' +
        fatalIndexErrors.map((m) => `- ${m}`).join('\n')
      );
    }

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
async function executeSearchMode(runtimeConfig: SearchToolsRuntimeConfig, input: SearchToolsInput): Promise<SearchToolsResult> {
  const {
    methodName,
    documentType = 'all',
    category,
    library,
    exclude,
    limit = 10,
    offset = 0,
  } = input;

  // Execute search
  const searchResult = await searchToolsService.search({
    query: methodName,
    documentType,
    category,
    library,
    exclude,
    limit,
    offset,
  });

  // Get relevant scripts if searching by name
  const relevantScripts = methodName
    ? await searchToolsService.getRelevantScripts(methodName)
    : [];

  // Format results
  const formatted = formatResults(searchResult, {
    maxProperties: 20,
    includeFilePaths: false,
  });

  const hasMore = offset + limit < searchResult.totalMatches;

  // Build summary
  let summary = '';

  summary += formatted.summary + '\n\n';

  formatted.items.forEach((item, idx) => {
    // Show className for methods (e.g., "SomeApi.someMethod")
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
    summary += `- Use library filter: ${runtimeConfig.libraries.map((l) => l.name).join(', ')}\n`;
  }

  const importLines: string[] = [];
  for (const lib of runtimeConfig.libraries) {
    const comment = lib.description ? ` // ${lib.description}` : '';
    importLines.push(`- ${lib.name}: require("${lib.name}")${comment}`);
  }

  const usageLines: string[] = [];
  usageLines.push('USAGE:');
  usageLines.push('- New code: runSandbox({ code: "..." })');
  usageLines.push('- Cached script: runSandbox({ cached: "script-name.ts" })');
  usageLines.push('- Execution modes: "execute" (blocking), "stream" (real-time), "async" (non-blocking)');
  usageLines.push('');
  usageLines.push('ALLOWED IMPORTS (require):');
  usageLines.push(...importLines);

  const usage = usageLines.join('\n');

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
export async function warmupSearchIndex(runtimeConfig: SearchToolsRuntimeConfig = getDefaultRuntimeConfig()): Promise<void> {
  searchToolsService.configure(runtimeConfig);
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

function formatLibrariesForDisplay(libraries: LibrarySpec[]): string {
  return libraries
    .map((l) => (l.description ? `${l.name} (${l.description})` : l.name))
    .join(', ');
}

export function createSearchToolsTool(runtimeConfig: SearchToolsRuntimeConfig) {
  // Keep the service config in lockstep with the schema/description we expose.
  searchToolsService.configure(runtimeConfig);

  const schema = createSearchToolsInputSchema(runtimeConfig.libraries);
  const indexed = formatLibrariesForDisplay(runtimeConfig.libraries);

  return {
    name: 'prodisco.searchTools',
    description:
      '**BROWSE API DOCUMENTATION.** Find methods/types/functions by name from indexed TypeScript libraries. ' +
      'Use methodName to search (this searches indexed TypeScript typings only; it does NOT execute code or call external services). ' +
      '\n\n' +
      `INDEXED: ${indexed}. ` +
      '\n\n' +
      'FILTERS: library, documentType (method|type|function|script), category',
    schema,
    async execute(input: z.infer<typeof schema>) {
      return executeSearchMode(runtimeConfig, input);
    },
  } satisfies ToolDefinition<SearchToolsResult, typeof schema>;
}

// Backward-compatible default export (used by tooling/metadata); runtime server should call createSearchToolsTool()
export const searchToolsTool = createSearchToolsTool(getDefaultRuntimeConfig());
