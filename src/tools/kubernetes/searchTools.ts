import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import * as ts from 'typescript';
import { readFileSync, existsSync, readdirSync, mkdirSync, symlinkSync, realpathSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import type { ToolDefinition } from '../types.js';
import { PACKAGE_ROOT, SCRIPTS_CACHE_DIR } from '../../util/paths.js';
import { create, insert, search, remove } from '@orama/orama';
import type { Orama, Results, SearchParams } from '@orama/orama';
import { logger } from '../../util/logger.js';

// ============================================================================
// Search Configuration Constants
// ============================================================================

/** Maximum number of resource types to extract from script content to prevent noise */
const MAX_RESOURCE_TYPES_FROM_CONTENT = 10;

/** Multiplier for initial search results to allow for post-filtering and pagination */
const SEARCH_RESULTS_MULTIPLIER = 3;

/** Minimum number of search results to fetch before post-filtering */
const MIN_SEARCH_RESULTS = 100;

/** Maximum number of relevant scripts to show in method search results */
const MAX_RELEVANT_SCRIPTS = 5;

/** Default maximum number of properties to show when formatting type definitions */
const DEFAULT_MAX_TYPE_PROPERTIES = 20;

// ============================================================================

const SearchToolsInputSchema = z.object({
  // === Search parameters ===
  query: z
    .string()
    .optional()
    .describe('Search term - searches names, descriptions, and types'),

  // === Filter parameters ===
  documentType: z
    .enum(['kubernetes', 'prometheus', 'prometheus-metric', 'loki', 'analytics', 'script', 'type', 'all'])
    .optional()
    .default('all')
    .describe('Filter by document type: "kubernetes" (K8s API methods), "prometheus" (Prometheus client methods), "prometheus-metric" (live metrics), "loki", "analytics", "script", "type" (TypeScript type definitions), or "all"'),

  category: z
    .string()
    .optional()
    .describe('Filter by category: Method actions (list, create, read, delete, patch, replace, connect, watch) or type kinds (class, interface, enum) or library categories (query, metadata, alerts, descriptive, regression, etc.)'),

  library: z
    .string()
    .optional()
    .describe('Filter by library: @kubernetes/client-node, prometheus-query, @prodisco/loki-client, mathjs, simple-statistics, ml-regression, fft-js'),

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

type KubernetesApiMethod = {
  apiClass: string;
  methodName: string;
  resourceType: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    description?: string;
  }>;
  returnType: string;
  example: string;
  // Type definition location for agent to read actual types
  typeDefinitionFile: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; required?: boolean }>;
    required: string[];
    description: string;
  };
  outputSchema: {
    type: 'object';
    description: string;
    properties: Record<string, { type: string; description: string; }>;
  };
  // Actual TypeScript type definitions
  typeDefinitions?: {
    input?: string;
    output?: string;
  };
};

// ExtractedType for type extraction
type ExtractedType = {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'type-alias';
  description: string;
  properties: Array<{
    name: string;
    type: string;
    optional: boolean;
    description?: string;
  }>;
  nestedTypes: string[];
  sourceFile: string;
  library: string;
};

// Cached script metadata for indexing
type CachedScript = {
  filename: string;
  filePath: string;
  description: string;
  resourceTypes: string[];
  apiClasses: string[];
  keywords: string[];
};

// Relevant script for display (NO filePath - security: agent should not see internal paths)
type RelevantScript = {
  filename: string;
  description: string;
  apiClasses: string[];
};

// Prometheus mode types
type PrometheusCategory = 'query' | 'metadata' | 'alerts';

type PrometheusMethod = {
  library: 'prometheus-query';
  className?: string;           // e.g., "PrometheusDriver"
  methodName: string;           // e.g., "instantQuery", "rangeQuery"
  category: PrometheusCategory;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    description?: string;
  }>;
  returnType: string;
  example: string;
};

// Analytics mode types
type AnalyticsLibrary = 'simple-statistics' | 'ml-regression' | 'mathjs' | 'fft-js';
type AnalyticsCategory = 'descriptive' | 'regression' | 'distribution' | 'matrix' | 'signal' | 'utility';

type AnalyticsFunction = {
  library: AnalyticsLibrary;
  functionName: string;
  category: AnalyticsCategory;
  description: string;
  signature: string;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    description?: string;
  }>;
  returnType: string;
  example: string;
};

// ============================================================================
// Loki mode types
// ============================================================================

type LokiCategory = 'query' | 'labels' | 'streams' | 'health' | 'all';

type LokiMethod = {
  library: '@prodisco/loki-client';
  className?: string;           // e.g., "LokiClient"
  methodName: string;           // e.g., "queryRange", "labels"
  category: LokiCategory;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    description?: string;
  }>;
  returnType: string;
  example: string;
};

// Unified search result type
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
    parameters?: Array<{ name: string; type: string; optional: boolean; description?: string }>;
    returnType?: string;
    example?: string;
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
// Type Definition Helper Types and Functions (from typeDefinitions.ts)
// ============================================================================

interface PropertyInfo {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

interface TypeInfo {
  name: string;
  properties: PropertyInfo[];
  description?: string;
}

/**
 * Extract JSDoc comment from a node
 */
function getJSDocDescription(node: ts.Node): string | undefined {
  const jsDocComments = ts.getJSDocCommentsAndTags(node);
  for (const comment of jsDocComments) {
    if (ts.isJSDoc(comment) && comment.comment) {
      if (typeof comment.comment === 'string') {
        return comment.comment;
      }
    }
  }
  return undefined;
}

/**
 * Extract nested type references from a TypeNode using TypeScript AST
 */
function extractNestedTypeRefsFromNode(typeNode: ts.TypeNode | undefined): string[] {
  if (!typeNode) {
    return [];
  }

  const refs: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName.getText();
      // Only include K8s types (V1*, K8*, Core*)
      if ((typeName.startsWith('V') || typeName.startsWith('K') || typeName.startsWith('Core')) &&
          !refs.includes(typeName)) {
        refs.push(typeName);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(typeNode);
  return refs;
}

/**
 * Format type info as a readable string
 */
function formatTypeInfo(typeInfo: TypeInfo, maxProperties: number = DEFAULT_MAX_TYPE_PROPERTIES): string {
  let result = `${typeInfo.name} {\n`;

  const propsToShow = typeInfo.properties.slice(0, maxProperties);
  const hasMore = typeInfo.properties.length > maxProperties;

  for (const prop of propsToShow) {
    const optionalMarker = prop.optional ? '?' : '';
    result += `  ${prop.name}${optionalMarker}: ${prop.type}\n`;
  }

  if (hasMore) {
    result += `  ... ${typeInfo.properties.length - maxProperties} more properties\n`;
  }

  result += `}`;
  return result;
}

// ============================================================================
// Type Extractors for All Libraries
// ============================================================================

/**
 * Extract all types from a TypeScript file (classes, interfaces, enums, type aliases)
 */
function extractAllTypesFromFile(filePath: string, libraryName: string): ExtractedType[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

  const types: ExtractedType[] = [];

  function visit(node: ts.Node) {
    // Extract classes
    if (ts.isClassDeclaration(node) && node.name) {
      const extracted = extractClassOrInterface(node, sourceFile, libraryName, filePath, 'class');
      if (extracted) types.push(extracted);
    }
    // Extract interfaces
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const extracted = extractClassOrInterface(node, sourceFile, libraryName, filePath, 'interface');
      if (extracted) types.push(extracted);
    }
    // Extract enums
    if (ts.isEnumDeclaration(node) && node.name) {
      const extracted = extractEnum(node, sourceFile, libraryName, filePath);
      if (extracted) types.push(extracted);
    }
    // Extract type aliases (skip complex utility types)
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const extracted = extractTypeAlias(node, sourceFile, libraryName, filePath);
      if (extracted) types.push(extracted);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return types;
}

/**
 * Extract a class or interface declaration
 */
function extractClassOrInterface(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string,
  kind: 'class' | 'interface'
): ExtractedType | null {
  if (!node.name) return null;

  const name = node.name.text;
  const description = getJSDocDescription(node) || `${kind} ${name}`;
  const properties: ExtractedType['properties'] = [];
  const nestedTypes = new Set<string>();

  node.members?.forEach((member) => {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      if (member.name) {
        const propName = member.name.getText(sourceFile).replace(/['"]/g, '');
        const propType = member.type?.getText(sourceFile) || 'any';
        const isOptional = !!member.questionToken;
        const propDescription = getJSDocDescription(member);

        // Skip internal/static fields
        if (propName === 'discriminator' || propName === 'mapping' || propName === 'attributeTypeMap') {
          return;
        }

        properties.push({
          name: propName,
          type: propType,
          optional: isOptional,
          description: propDescription,
        });

        // Extract nested type references
        const typeRefs = extractNestedTypeRefsFromNode(member.type);
        for (const ref of typeRefs) {
          if (ref !== name) {
            nestedTypes.add(ref);
          }
        }
      }
    }
  });

  return {
    name,
    kind,
    description,
    properties,
    nestedTypes: Array.from(nestedTypes),
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Extract an enum declaration
 */
function extractEnum(
  node: ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedType | null {
  if (!node.name) return null;

  const name = node.name.text;
  const description = getJSDocDescription(node) || `enum ${name}`;
  const properties: ExtractedType['properties'] = [];

  node.members.forEach((member) => {
    const memberName = member.name.getText(sourceFile);
    const memberValue = member.initializer?.getText(sourceFile) || memberName;

    properties.push({
      name: memberName,
      type: memberValue,
      optional: false,
    });
  });

  return {
    name,
    kind: 'enum',
    description,
    properties,
    nestedTypes: [],
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Extract a type alias declaration
 */
function extractTypeAlias(
  node: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedType | null {
  if (!node.name) return null;

  const name = node.name.text;

  // Skip complex utility types and generics
  if (node.typeParameters && node.typeParameters.length > 0) {
    return null;
  }

  const description = getJSDocDescription(node) || `type ${name}`;
  const typeText = node.type.getText(sourceFile);

  // For union types, extract each option as a "property"
  const properties: ExtractedType['properties'] = [];
  if (ts.isUnionTypeNode(node.type)) {
    node.type.types.forEach((t) => {
      const typeStr = t.getText(sourceFile);
      properties.push({
        name: typeStr.replace(/['"]/g, ''),
        type: typeStr,
        optional: false,
      });
    });
  } else {
    properties.push({
      name: 'value',
      type: typeText,
      optional: false,
    });
  }

  return {
    name,
    kind: 'type-alias',
    description,
    properties,
    nestedTypes: [],
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Extract Kubernetes types from @kubernetes/client-node
 */
function extractK8sTypes(): ExtractedType[] {
  const modelsPath = join(process.cwd(), 'node_modules', '@kubernetes', 'client-node', 'dist', 'gen', 'models');

  if (!existsSync(modelsPath)) {
    logger.warn('K8s models path not found');
    return [];
  }

  const files = readdirSync(modelsPath).filter(f => f.endsWith('.d.ts') && f !== 'all.d.ts');
  const types: ExtractedType[] = [];

  for (const file of files) {
    const typeName = file.replace('.d.ts', '');
    const filePath = join(modelsPath, file);

    const extracted = extractAllTypesFromFile(filePath, '@kubernetes/client-node');
    // Filter to only the type matching the filename
    const matchingType = extracted.find(t => t.name === typeName);
    if (matchingType) {
      types.push(matchingType);
    }
  }

  return types;
}

/**
 * Extract Prometheus types from prometheus-query
 */
function extractPrometheusTypes(): ExtractedType[] {
  const typesPath = join(process.cwd(), 'node_modules', 'prometheus-query', 'dist', 'types.d.ts');
  return extractAllTypesFromFile(typesPath, 'prometheus-query');
}

/**
 * Extract Loki types from @prodisco/loki-client
 */
function extractLokiTypes(): ExtractedType[] {
  // Try installed package first
  let sourcePath = join(process.cwd(), 'node_modules', '@prodisco', 'loki-client', 'dist', 'index.d.ts');

  if (!existsSync(sourcePath)) {
    // Fall back to local package source
    sourcePath = join(process.cwd(), 'packages', 'loki-client', 'src', 'index.ts');
  }

  return extractAllTypesFromFile(sourcePath, '@prodisco/loki-client');
}

/**
 * Key mathjs types to extract (not all - it has hundreds)
 */
const MATHJS_KEY_TYPES = new Set([
  'MathNumericType', 'MathScalarType', 'MathCollection', 'MathType', 'MathExpression',
  'Matrix', 'BigNumber', 'Complex', 'Unit', 'Fraction',
  'MathNode', 'ParseOptions', 'EvalFunction',
]);

/**
 * Extract key MathJS types
 */
function extractMathjsTypes(): ExtractedType[] {
  const typesPath = join(process.cwd(), 'node_modules', 'mathjs', 'types', 'index.d.ts');

  if (!existsSync(typesPath)) {
    return [];
  }

  const allTypes = extractAllTypesFromFile(typesPath, 'mathjs');
  return allTypes.filter(t => MATHJS_KEY_TYPES.has(t.name));
}

/**
 * Build an OramaDocument from an ExtractedType
 */
function buildTypeDocument(type: ExtractedType): OramaDocument {
  const searchTokens = [
    type.name,
    splitCamelCase(type.name),
    type.kind,
    type.description,
    ...type.properties.map(p => p.name),
    ...type.nestedTypes,
  ].join(' ');

  return {
    id: `type:${type.library}:${type.name}`,
    documentType: 'type',
    name: type.name,
    description: type.description,
    searchTokens,
    library: type.library,
    category: type.kind,
    // Method fields (empty for types)
    resourceType: '',
    scope: '',
    filePath: '',
    // Type-specific fields
    properties: JSON.stringify(type.properties),
    typeDefinition: formatTypeInfo({
      name: type.name,
      properties: type.properties,
      description: type.description,
    }),
    nestedTypes: type.nestedTypes.join(','),
    typeKind: type.kind,
  };
}

// ============================================================================
// SearchToolsService Class - Encapsulates All Module State
// ============================================================================

/**
 * Service class that encapsulates the search tools state and operations.
 * This provides:
 * - Proper lifecycle management (initialize/shutdown)
 * - Testability through class instantiation
 * - Clean separation of state from functions
 */
class SearchToolsService {
  /** Cache for Kubernetes API methods */
  private apiMethodsCache: KubernetesApiMethod[] | null = null;

  /** Orama database instance cache */
  private oramaDb: Orama<typeof oramaSchema> | null = null;

  /** Track indexed scripts to support incremental re-indexing */
  private indexedScriptPaths = new Set<string>();

  /** Whether the service has been initialized */
  private initialized = false;

  /** Prometheus metrics indexing status */
  private metricsIndexingStatus: 'ready' | 'in_progress' | 'unavailable' = 'unavailable';

  /** Interval for refreshing Prometheus metrics */
  private metricsRefreshInterval: NodeJS.Timeout | null = null;

  /** Refresh interval in milliseconds (30 minutes) */
  private static readonly METRICS_REFRESH_INTERVAL = 30 * 60 * 1000;

  /**
   * Initialize the search index.
   * This is called automatically on first use, but can be called explicitly
   * for pre-warming during server startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.initializeOramaDb();
    this.initialized = true;

    // Start background Prometheus metrics indexing (non-blocking)
    if (process.env.PROMETHEUS_URL) {
      this.startPrometheusMetricsIndexing();
    }
  }

  /**
   * Get the current Prometheus metrics indexing status
   */
  getMetricsIndexingStatus(): 'ready' | 'in_progress' | 'unavailable' {
    return this.metricsIndexingStatus;
  }

  /**
   * Shutdown the service and clean up resources.
   * Call this during graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.metricsRefreshInterval) {
      clearInterval(this.metricsRefreshInterval);
      this.metricsRefreshInterval = null;
      logger.info('Orama: Stopped Prometheus metrics refresh');
    }
    this.oramaDb = null;
    this.apiMethodsCache = null;
    this.indexedScriptPaths.clear();
    this.metricsIndexingStatus = 'unavailable';
    this.initialized = false;
    // Clear module-level caches
    clearPrometheusMethodsCache();
    clearAnalyticsMethodsCache();
    clearLokiMethodsCache();
  }

  /**
   * Get the Orama database instance, initializing it if needed
   */
  async getOramaDb(): Promise<Orama<typeof oramaSchema>> {
    if (!this.oramaDb) {
      await this.initializeOramaDb();
    }
    return this.oramaDb!;
  }

  /**
   * Get the cached API methods, extracting them if needed
   */
  getApiMethods(): KubernetesApiMethod[] {
    if (!this.apiMethodsCache) {
      this.apiMethodsCache = this.extractKubernetesApiMethods();
    }
    return this.apiMethodsCache;
  }

  /**
   * Index a script file immediately into Orama.
   * Called by runSandbox after caching a new script to ensure
   * it's immediately searchable without waiting for the filesystem watcher.
   * @deprecated Use indexCacheEntry instead for gRPC-based caching
   */
  async indexScriptImmediately(filePath: string): Promise<void> {
    if (!this.oramaDb) {
      // DB not initialized yet, will be indexed on startup
      return;
    }

    // Skip if already indexed
    if (this.indexedScriptPaths.has(filePath)) {
      return;
    }

    const script = parseScriptFile(filePath);
    if (script) {
      const doc = buildScriptDocument(script);
      await insert(this.oramaDb, doc);
      this.indexedScriptPaths.add(filePath);
      logger.info(`Orama: Immediately indexed new script ${basename(filePath)}`);
    }
  }

  /**
   * Index a cache entry from gRPC ExecuteResponse.
   * This is the preferred method when cache is in a remote sandbox container.
   */
  async indexCacheEntry(entry: {
    name: string;
    description: string;
    createdAtMs: number;
    contentHash: string;
  }): Promise<void> {
    if (!this.oramaDb) {
      // DB not initialized yet
      return;
    }

    const entryId = `script:${entry.name}`;

    // Skip if already indexed
    if (this.indexedScriptPaths.has(entryId)) {
      return;
    }

    // Build search tokens from description
    const keywords = entry.description
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2)
      .filter(word => !['the', 'and', 'for', 'from', 'with', 'this', 'that'].includes(word));

    // Always include 'script' so scripts can be found with default query
    const searchTokens = ['script', entry.description, ...keywords].join(' ');

    const doc: OramaDocument = {
      id: entryId,
      documentType: 'script',
      name: 'sandbox-script',
      description: entry.description,
      searchTokens,
      library: 'CachedScript',
      category: 'script',
      // Method-specific
      resourceType: '',
      scope: 'script',
      filePath: entry.name, // Use name as path since cache is remote
      // Type fields (empty for scripts)
      properties: '',
      typeDefinition: '',
      nestedTypes: '',
      typeKind: '',
    };

    await insert(this.oramaDb, doc);
    this.indexedScriptPaths.add(entryId);
    logger.info(`Orama: Indexed cache entry ${entry.name}`);
  }

  /**
   * Initialize and populate the Orama search database
   */
  private async initializeOramaDb(): Promise<Orama<typeof oramaSchema>> {
    if (this.oramaDb) {
      return this.oramaDb;
    }

    // Create Orama instance with optimized configuration
    const db = await create({
      schema: oramaSchema,
      components: {
        tokenizer: {
          stemming: true,
          // Skip stemming for code identifiers - they should match exactly
          stemmerSkipProperties: ['name', 'resourceType', 'library', 'id', 'typeKind'],
        },
      },
    });

    // Get all API methods and index them
    const methods = this.getApiMethods();

    for (const method of methods) {
      // Skip WithHttpInfo variants
      if (method.methodName.toLowerCase().includes('withhttpinfo')) {
        continue;
      }

      // Build searchTokens from identifiers for better matching
      const searchTokens = [
        method.resourceType,
        method.methodName,
        method.apiClass,
        splitCamelCase(method.methodName),
      ].join(' ');

      const doc: OramaDocument = {
        id: `${method.apiClass}.${method.methodName}`,
        documentType: 'kubernetes',
        name: method.methodName,
        description: method.description,
        searchTokens,
        library: method.apiClass,
        category: extractAction(method.methodName),
        // Method-specific
        resourceType: method.resourceType,
        scope: extractScope(method.methodName),
        filePath: '',
        // Type fields (empty for methods)
        properties: '',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: '',
      };

      await insert(db, doc);
    }

    // Index cached scripts
    const scriptCount = await this.indexCachedScripts(db);

    // Index prometheus library methods
    const prometheusCount = await this.indexPrometheusMethods(db);

    // Index loki library methods
    const lokiCount = await this.indexLokiMethods(db);

    // Index analytics library methods
    const analyticsCount = await this.indexAnalyticsMethods(db);

    // Index types from all libraries
    const typeCount = await this.indexTypes(db);

    this.oramaDb = db;
    logger.info(`Orama: Indexed ${methods.length} K8s methods, ${prometheusCount} prometheus, ${lokiCount} loki, ${analyticsCount} analytics, ${scriptCount} scripts, ${typeCount} types`);
    return db;
  }

  /**
   * Index types from all libraries into the Orama database.
   */
  private async indexTypes(db: Orama<typeof oramaSchema>): Promise<number> {
    let indexedCount = 0;

    try {
      // Extract and index K8s types
      const k8sTypes = extractK8sTypes();
      for (const type of k8sTypes) {
        await insert(db, buildTypeDocument(type));
        indexedCount++;
      }
      logger.debug(`Indexed ${k8sTypes.length} K8s types`);

      // Extract and index Prometheus types
      const prometheusTypes = extractPrometheusTypes();
      for (const type of prometheusTypes) {
        await insert(db, buildTypeDocument(type));
        indexedCount++;
      }
      logger.debug(`Indexed ${prometheusTypes.length} Prometheus types`);

      // Extract and index Loki types
      const lokiTypes = extractLokiTypes();
      for (const type of lokiTypes) {
        await insert(db, buildTypeDocument(type));
        indexedCount++;
      }
      logger.debug(`Indexed ${lokiTypes.length} Loki types`);

      // Extract and index MathJS types
      const mathjsTypes = extractMathjsTypes();
      for (const type of mathjsTypes) {
        await insert(db, buildTypeDocument(type));
        indexedCount++;
      }
      logger.debug(`Indexed ${mathjsTypes.length} MathJS types`);

    } catch (error) {
      logger.error('Error indexing types', error);
    }

    return indexedCount;
  }

  /**
   * Index cached scripts into the Orama database.
   */
  private async indexCachedScripts(db: Orama<typeof oramaSchema>): Promise<number> {
    const scriptsDirectory = SCRIPTS_CACHE_DIR;
    let indexedCount = 0;

    try {
      if (!existsSync(scriptsDirectory)) {
        return 0;
      }

      const files = readdirSync(scriptsDirectory)
        .filter(f => f.endsWith('.ts'))
        .map(f => join(scriptsDirectory, f));

      for (const filePath of files) {
        // Skip if already indexed
        if (this.indexedScriptPaths.has(filePath)) {
          continue;
        }

        const script = parseScriptFile(filePath);
        if (!script) {
          continue;
        }

        const doc = buildScriptDocument(script);
        await insert(db, doc);
        this.indexedScriptPaths.add(filePath);
        indexedCount++;
      }
    } catch (error) {
      logger.error('Error indexing cached scripts', error);
    }

    return indexedCount;
  }

  /**
   * Index prometheus library methods into the Orama database.
   */
  private async indexPrometheusMethods(db: Orama<typeof oramaSchema>): Promise<number> {
    const methods = getPrometheusMethods();
    let indexedCount = 0;

    for (const method of methods) {
      // Build searchTokens from identifiers for better matching
      const searchTokens = [
        'prometheus',
        method.methodName,
        method.className || '',
        method.library,
        method.category,
        method.description,
        splitCamelCase(method.methodName),
      ].join(' ');

      const doc: OramaDocument = {
        id: `prometheus:${method.library}:${method.className || 'fn'}:${method.methodName}`,
        documentType: 'prometheus',
        name: method.methodName,
        description: method.description,
        searchTokens,
        library: method.library,
        category: method.category,
        // Method-specific
        resourceType: method.category,
        scope: 'library',
        filePath: '',
        // Type fields (empty for methods)
        properties: '',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: '',
      };

      await insert(db, doc);
      indexedCount++;
    }

    return indexedCount;
  }

  /**
   * Index Loki library methods into the Orama database.
   */
  private async indexLokiMethods(db: Orama<typeof oramaSchema>): Promise<number> {
    const methods = getLokiMethods();
    let indexedCount = 0;

    for (const method of methods) {
      const searchTokens = [
        'loki',
        method.methodName,
        splitCamelCase(method.methodName),
        method.className || '',
        method.library,
        method.category,
        method.description,
      ].join(' ');

      const doc: OramaDocument = {
        id: `loki:${method.library}:${method.className || 'fn'}:${method.methodName}`,
        documentType: 'loki',
        name: method.methodName,
        description: method.description,
        searchTokens,
        library: method.library,
        category: method.category,
        // Method-specific
        resourceType: method.category,
        scope: 'library',
        filePath: '',
        // Type fields (empty for methods)
        properties: '',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: '',
      };

      await insert(db, doc);
      indexedCount++;
    }

    return indexedCount;
  }

  /**
   * Index analytics library functions into the Orama database.
   */
  private async indexAnalyticsMethods(db: Orama<typeof oramaSchema>): Promise<number> {
    const functions = getAnalyticsFunctions();
    let indexedCount = 0;

    for (const func of functions) {
      const searchTokens = [
        'analytics',
        func.functionName,
        splitCamelCase(func.functionName),
        func.library,
        func.category,
        func.description,
      ].join(' ');

      const doc: OramaDocument = {
        id: `analytics:${func.library}:${func.functionName}`,
        documentType: 'analytics',
        name: func.functionName,
        description: func.description,
        searchTokens,
        library: func.library,
        category: func.category,
        // Method-specific
        resourceType: func.category,
        scope: 'library',
        filePath: '',
        // Type fields (empty for methods)
        properties: '',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: '',
      };

      await insert(db, doc);
      indexedCount++;
    }

    return indexedCount;
  }

  /**
   * Start background Prometheus metrics indexing (non-blocking).
   * Fetches metric metadata from Prometheus and indexes into Orama.
   */
  private startPrometheusMetricsIndexing(): void {
    this.metricsIndexingStatus = 'in_progress';

    // Run indexing in background (don't await)
    this.indexPrometheusMetrics()
      .then(() => {
        this.metricsIndexingStatus = 'ready';

        // Schedule incremental refresh
        this.metricsRefreshInterval = setInterval(() => {
          this.refreshPrometheusMetrics();
        }, SearchToolsService.METRICS_REFRESH_INTERVAL);
      })
      .catch((error) => {
        logger.error('Failed to index Prometheus metrics', error);
        this.metricsIndexingStatus = 'unavailable';
      });
  }

  /**
   * Index Prometheus metrics from the cluster into Orama.
   */
  private async indexPrometheusMetrics(): Promise<number> {
    const prometheusUrl = process.env.PROMETHEUS_URL;
    if (!prometheusUrl) {
      return 0;
    }

    const { PrometheusDriver } = await import('prometheus-query');
    const prom = new PrometheusDriver({ endpoint: prometheusUrl });

    const metadata = await prom.metadata();
    const db = await this.getOramaDb();
    let count = 0;

    for (const [name, info] of Object.entries(metadata)) {
      const metricInfo = Array.isArray(info) ? info[0] : info;
      const metricType = (metricInfo as { type?: string })?.type || 'unknown';
      const description = (metricInfo as { help?: string })?.help || 'No description available';

      const doc: OramaDocument = {
        id: `metric:${name}`,
        documentType: 'prometheus-metric',
        name,
        description,
        searchTokens: `${name.replace(/_/g, ' ')} ${metricType} ${description}`,
        library: 'prometheus-metric',
        category: 'metric',
        // Method-specific
        resourceType: '',
        scope: 'prometheus',
        filePath: '',
        // Type fields (empty for metrics)
        properties: '',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: '',
        metricType,
      };

      await insert(db, doc);
      count++;
    }

    logger.info(`Orama: Indexed ${count} Prometheus metrics from cluster`);
    return count;
  }

  /**
   * Incrementally refresh Prometheus metrics.
   * Adds new metrics, removes stale ones.
   */
  private async refreshPrometheusMetrics(): Promise<void> {
    const prometheusUrl = process.env.PROMETHEUS_URL;
    if (!prometheusUrl) {
      return;
    }

    try {
      const { PrometheusDriver } = await import('prometheus-query');
      const prom = new PrometheusDriver({ endpoint: prometheusUrl });
      const metadata = await prom.metadata();
      const db = await this.getOramaDb();

      const currentMetrics = new Set(Object.keys(metadata));

      // Get existing indexed metrics
      const existingResults = await search(db, {
        term: '',
        properties: ['name'],
        limit: 10000,
      });

      const existingMetrics = new Map<string, string>();
      for (const hit of existingResults.hits) {
        if (hit.document.documentType === 'prometheus-metric') {
          existingMetrics.set(hit.document.name, hit.document.id);
        }
      }

      let added = 0;
      let removed = 0;

      // Add new metrics
      for (const [name, info] of Object.entries(metadata)) {
        if (!existingMetrics.has(name)) {
          const metricInfo = Array.isArray(info) ? info[0] : info;
          const metricType = (metricInfo as { type?: string })?.type || 'unknown';
          const description = (metricInfo as { help?: string })?.help || 'No description available';

          const doc: OramaDocument = {
            id: `metric:${name}`,
            documentType: 'prometheus-metric',
            name,
            description,
            searchTokens: `${name.replace(/_/g, ' ')} ${metricType} ${description}`,
            library: 'prometheus-metric',
            category: 'metric',
            // Method-specific
            resourceType: '',
            scope: 'prometheus',
            filePath: '',
            // Type fields (empty for metrics)
            properties: '',
            typeDefinition: '',
            nestedTypes: '',
            typeKind: '',
            metricType,
          };

          await insert(db, doc);
          added++;
        }
      }

      // Remove stale metrics
      for (const [name, id] of existingMetrics) {
        if (!currentMetrics.has(name)) {
          try {
            await remove(db, id);
            removed++;
          } catch {
            // Ignore removal errors
          }
        }
      }

      if (added > 0 || removed > 0) {
        logger.info(`Orama: Prometheus metrics refresh - added ${added}, removed ${removed}`);
      }
    } catch (error) {
      logger.error('Failed to refresh Prometheus metrics', error);
    }
  }

  /**
   * Unified search using Orama - works for all document types including types
   */
  async searchWithOrama(options: {
    query: string;
    documentType?: 'kubernetes' | 'prometheus' | 'prometheus-metric' | 'loki' | 'analytics' | 'script' | 'type' | 'all';
    category?: string;
    library?: string;
    exclude?: { categories?: string[]; libraries?: string[] };
    limit: number;
    offset: number;
  }): Promise<{
    results: OramaDocument[];
    scriptResults: OramaDocument[];
    totalMatches: number;
    facets: {
      documentType: Record<string, number>;
      library: Record<string, number>;
      category: Record<string, number>;
    };
    searchTime: number;
  }> {
    const { query, documentType = 'all', category, library, exclude, limit, offset } = options;
    const db = await this.getOramaDb();

    const searchParams: SearchParams<Orama<typeof oramaSchema>, OramaDocument> = {
      term: query,
      properties: ['name', 'resourceType', 'description', 'searchTokens', 'properties'],
      boost: {
        name: 3,
        resourceType: 2.5,
        searchTokens: 2,
        description: 1,
        properties: 0.5,
      },
      tolerance: 1,
      limit: Math.max((offset + limit) * SEARCH_RESULTS_MULTIPLIER, MIN_SEARCH_RESULTS),
      facets: {
        documentType: {},
        library: {},
        category: {},
      },
    };

    const startTime = performance.now();
    const searchResult: Results<OramaDocument> = await search(db, searchParams);
    const searchTime = performance.now() - startTime;

    // Filter by documentType
    let hits = searchResult.hits;
    if (documentType !== 'all') {
      hits = hits.filter(hit => hit.document.documentType === documentType);
    }

    // Separate scripts for display (shown separately in results)
    const scriptHits = hits.filter(hit => hit.document.documentType === 'script');
    let nonScriptHits = hits.filter(hit => hit.document.documentType !== 'script');

    // Apply category filter
    if (category) {
      const lowerCategory = category.toLowerCase();
      nonScriptHits = nonScriptHits.filter(hit => hit.document.category === lowerCategory);
    }

    // Apply library filter
    if (library) {
      nonScriptHits = nonScriptHits.filter(hit => hit.document.library === library);
    }

    // Apply exclusions
    if (exclude) {
      nonScriptHits = nonScriptHits.filter(hit => {
        const doc = hit.document;
        const hasCategories = exclude.categories && exclude.categories.length > 0;
        const hasLibraries = exclude.libraries && exclude.libraries.length > 0;

        if (hasCategories && hasLibraries) {
          const matchesCategory = exclude.categories!.some(c =>
            doc.category === c.toLowerCase() || doc.name.toLowerCase().includes(c.toLowerCase())
          );
          const matchesLibrary = exclude.libraries!.includes(doc.library);
          return !(matchesCategory && matchesLibrary);
        } else if (hasCategories) {
          const matchesCategory = exclude.categories!.some(c =>
            doc.category === c.toLowerCase() || doc.name.toLowerCase().includes(c.toLowerCase())
          );
          return !matchesCategory;
        } else if (hasLibraries) {
          return !exclude.libraries!.includes(doc.library);
        }
        return true;
      });
    }

    // Extract facets
    const facets = {
      documentType: {} as Record<string, number>,
      library: {} as Record<string, number>,
      category: {} as Record<string, number>,
    };

    if (searchResult.facets) {
      if (searchResult.facets.documentType?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.documentType.values)) {
          facets.documentType[key] = value as number;
        }
      }
      if (searchResult.facets.library?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.library.values)) {
          if (key !== 'CachedScript') {
            facets.library[key] = value as number;
          }
        }
      }
      if (searchResult.facets.category?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.category.values)) {
          if (key !== 'script') {
            facets.category[key] = value as number;
          }
        }
      }
    }

    // Sort by relevance, prioritizing exact matches
    const sortedNonScriptHits = nonScriptHits.sort((a, b) => {
      const aExact = a.document.resourceType.toLowerCase() === query.toLowerCase() ||
                     a.document.name.toLowerCase() === query.toLowerCase();
      const bExact = b.document.resourceType.toLowerCase() === query.toLowerCase() ||
                     b.document.name.toLowerCase() === query.toLowerCase();

      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      return (b.score || 0) - (a.score || 0);
    });

    // Sort by score, then by id for stable ordering (important for pagination)
    const sortedScriptHits = scriptHits.sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      // Use document id for stable secondary sort
      return a.document.id.localeCompare(b.document.id);
    });

    // When specifically searching for scripts, return them in results (not scriptResults)
    if (documentType === 'script') {
      return {
        results: sortedScriptHits.slice(offset, offset + limit).map(hit => hit.document),
        scriptResults: [], // Scripts are already in results
        totalMatches: sortedScriptHits.length,
        facets,
        searchTime,
      };
    }

    return {
      results: sortedNonScriptHits.slice(offset, offset + limit).map(hit => hit.document),
      scriptResults: sortedScriptHits.slice(0, MAX_RELEVANT_SCRIPTS).map(hit => hit.document),
      totalMatches: sortedNonScriptHits.length,
      facets,
      searchTime,
    };
  }

  /**
   * Extract all API methods from @kubernetes/client-node
   */
  private extractKubernetesApiMethods(): KubernetesApiMethod[] {
    if (this.apiMethodsCache) {
      return this.apiMethodsCache;
    }

    const methods: KubernetesApiMethod[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiClasses: Array<{ class: string; constructor: any; description: string }> = [
      { class: 'CoreV1Api', constructor: k8s.CoreV1Api, description: 'Core Kubernetes resources (Pods, Services, ConfigMaps, Secrets, Namespaces, Nodes, etc.)' },
      { class: 'AppsV1Api', constructor: k8s.AppsV1Api, description: 'Applications API (Deployments, StatefulSets, DaemonSets, ReplicaSets)' },
      { class: 'BatchV1Api', constructor: k8s.BatchV1Api, description: 'Batch operations (Jobs, CronJobs)' },
      { class: 'NetworkingV1Api', constructor: k8s.NetworkingV1Api, description: 'Networking resources (Ingresses, NetworkPolicies, IngressClasses)' },
      { class: 'RbacAuthorizationV1Api', constructor: k8s.RbacAuthorizationV1Api, description: 'RBAC (Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, ServiceAccounts)' },
      { class: 'StorageV1Api', constructor: k8s.StorageV1Api, description: 'Storage resources (StorageClasses, PersistentVolumes, VolumeAttachments)' },
      { class: 'CustomObjectsApi', constructor: k8s.CustomObjectsApi, description: 'Custom Resource Definitions (CRDs) and custom resources' },
      { class: 'ApiextensionsV1Api', constructor: k8s.ApiextensionsV1Api, description: 'API extensions (CustomResourceDefinitions for discovering and managing CRDs)' },
      { class: 'AutoscalingV1Api', constructor: k8s.AutoscalingV1Api, description: 'Autoscaling resources (HorizontalPodAutoscalers)' },
      { class: 'PolicyV1Api', constructor: k8s.PolicyV1Api, description: 'Policy resources (PodDisruptionBudgets)' },
    ];

    for (const { class: className, constructor: ApiClass, description: classDesc } of apiClasses) {
      if (!ApiClass) continue;

      const proto = ApiClass.prototype;
      const methodNames = Object.getOwnPropertyNames(proto);

      for (const methodName of methodNames) {
        if (methodName === 'constructor' || methodName.startsWith('_') ||
            methodName === 'setDefaultAuthentication' || typeof proto[methodName] !== 'function') {
          continue;
        }

        const resourceType = extractResourceType(methodName);
        const description = generateDescriptionFromMethodName(methodName, classDesc);
        const parameters = inferParameters(methodName, className);
        const example = generateUsageExample(className, methodName, parameters);
        const inputSchema = generateInputSchema(parameters);
        const outputSchema = generateOutputSchema(methodName, resourceType);
        const typeDefinitionFile = `node_modules/@kubernetes/client-node/dist/gen/apis/${className}.d.ts`;
        const typeDefinitions = extractMethodTypeDefinitions(className, methodName, resourceType);

        methods.push({
          apiClass: className,
          methodName,
          resourceType,
          description,
          parameters,
          returnType: 'Promise<any>',
          example,
          typeDefinitionFile,
          inputSchema,
          outputSchema,
          typeDefinitions: Object.keys(typeDefinitions).length > 0 ? typeDefinitions : undefined,
        });
      }
    }

    this.apiMethodsCache = methods;
    logger.info(`Indexed ${methods.length} Kubernetes API methods`);
    return methods;
  }
}

// Export singleton for production use
export const searchToolsService = new SearchToolsService();

// Export class for testing
export { SearchToolsService };

// ============================================================================
// Orama Search Engine Configuration
// ============================================================================

/**
 * Orama schema for methods, types, and other documents
 *
 * Design decisions based on Orama best practices:
 * - `string` types for full-text searchable fields (name, description, searchTokens)
 * - `enum` types for exact-match filterable fields (category, library)
 * - stemmerSkipProperties for code identifiers that shouldn't be stemmed
 * - Boosting configured at search time for relevance tuning
 */
const oramaSchema = {
  // === Common fields (all document types) ===
  id: 'string',                  // Unique identifier
  documentType: 'enum',          // "kubernetes" | "prometheus" | "loki" | "analytics" | "script" | "prometheus-metric" | "type"
  name: 'string',                // Method name OR type name (unified)
  description: 'string',         // Full description text
  searchTokens: 'string',        // CamelCase split tokens for better matching
  library: 'enum',               // Package/API class: "@kubernetes/client-node", "prometheus-query", etc.
  category: 'enum',              // Action (list, create) OR type kind (class, interface) OR category (query, descriptive)

  // === Method-specific fields ===
  resourceType: 'string',        // K8s resource type: "Pod", "Deployment"
  scope: 'enum',                 // "namespaced", "cluster", "forAllNamespaces"
  filePath: 'string',            // Script file path (empty for methods/types)

  // === Type-specific fields ===
  properties: 'string',          // JSON array: [{name, type, optional, description}]
  typeDefinition: 'string',      // Formatted type definition for display
  nestedTypes: 'string',         // Comma-separated referenced type names
  typeKind: 'enum',              // "class" | "interface" | "enum" | "type-alias"

  // === Prometheus metric fields ===
  metricType: 'enum',            // "gauge" | "counter" | "histogram" | "summary" | "unknown"
} as const;

type OramaDocument = {
  id: string;
  documentType: 'kubernetes' | 'prometheus' | 'prometheus-metric' | 'loki' | 'analytics' | 'script' | 'type';
  name: string;
  description: string;
  searchTokens: string;
  library: string;
  category: string;
  // Method-specific
  resourceType: string;
  scope: string;
  filePath: string;
  // Type-specific
  properties: string;
  typeDefinition: string;
  nestedTypes: string;
  typeKind: string;
  // Prometheus metrics
  metricType?: string;
};

/**
 * Split camelCase/PascalCase identifiers into separate words for better search matching.
 * e.g., "queryRange" -> "query Range", "queryRangeStream" -> "query Range Stream"
 */
function splitCamelCase(identifier: string): string {
  return identifier.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Extract the action from a method name
 */
function extractAction(methodName: string): string {
  const lowerMethod = methodName.toLowerCase();
  const actions = ['list', 'read', 'create', 'delete', 'patch', 'replace', 'connect', 'watch', 'get'];
  for (const action of actions) {
    if (lowerMethod.startsWith(action)) {
      return action;
    }
  }
  return 'unknown';
}

/**
 * Extract the scope from a method name
 */
function extractScope(methodName: string): string {
  const lowerMethod = methodName.toLowerCase();
  if (lowerMethod.includes('forallnamespaces')) {
    return 'forAllNamespaces';
  }
  if (lowerMethod.includes('namespaced')) {
    return 'namespaced';
  }
  return 'cluster';
}

// ============================================================================
// Prometheus Library Methods (Dynamic Extraction from .d.ts files)
// ============================================================================

/**
 * Extract JSDoc comment text from a node using TypeScript AST
 */
function extractJSDocComment(node: ts.Node, _sourceFile: ts.SourceFile): string {
  const jsDocComments = ts.getJSDocCommentsAndTags(node);
  for (const comment of jsDocComments) {
    if (ts.isJSDoc(comment) && comment.comment) {
      if (typeof comment.comment === 'string') {
        return comment.comment;
      }
      // Handle JSDocComment array (multiple parts)
      if (Array.isArray(comment.comment)) {
        return comment.comment
          .map(part => typeof part === 'string' ? part : part.text)
          .join('')
          .trim();
      }
    }
  }
  return '';
}

/**
 * Extract parameter info from TypeScript function parameters
 */
function extractParameterInfo(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile
): Array<{ name: string; type: string; optional: boolean; description?: string }> {
  return params.map(param => {
    const name = param.name.getText(sourceFile);
    const type = param.type?.getText(sourceFile) || 'any';
    const optional = !!param.questionToken || !!param.initializer;
    return { name, type, optional };
  });
}

/**
 * Determine category for a prometheus-query method based on its name
 */
function categorizePrometheusQueryMethod(methodName: string, _description: string): PrometheusCategory {
  const lowerName = methodName.toLowerCase();

  if (lowerName.includes('query') || lowerName === 'instantquery' || lowerName === 'rangequery') {
    return 'query';
  }
  if (lowerName.includes('alert') || lowerName.includes('rule')) {
    return 'alerts';
  }
  return 'metadata';
}

/**
 * Generate example code for a prometheus-query method
 */
function generatePrometheusQueryExample(methodName: string, params: Array<{ name: string; type: string; optional: boolean }>): string {
  const requiredParams = params.filter(p => !p.optional);

  const paramExamples: string[] = [];
  for (const p of requiredParams) {
    switch (p.name) {
      case 'query':
        paramExamples.push("'up{job=\"prometheus\"}'");
        break;
      case 'time':
      case 'start':
        paramExamples.push('new Date(Date.now() - 3600000)');
        break;
      case 'end':
        paramExamples.push('new Date()');
        break;
      case 'step':
        paramExamples.push("'1m'");
        break;
      case 'matchs':
      case 'match':
        paramExamples.push("['{job=\"prometheus\"}']");
        break;
      case 'labelName':
        paramExamples.push("'job'");
        break;
      default:
        paramExamples.push(`/* ${p.name} */`);
    }
  }

  return `// Sandbox provides: k8s, kc, console, require()
const { PrometheusDriver } = require('prometheus-query');
const prom = new PrometheusDriver({ endpoint: process.env.PROMETHEUS_URL });
const result = await prom.${methodName}(${paramExamples.join(', ')});
console.log(result);`;
}

/**
 * Dynamically extract methods from prometheus-query library .d.ts files
 */
function extractPrometheusQueryMethods(): PrometheusMethod[] {
  const methods: PrometheusMethod[] = [];

  try {
    const driverPath = join(process.cwd(), 'node_modules', 'prometheus-query', 'dist', 'driver.d.ts');
    if (!existsSync(driverPath)) {
      logger.debug('prometheus-query driver.d.ts not found');
      return methods;
    }

    const sourceCode = readFileSync(driverPath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      driverPath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    function visit(node: ts.Node) {
      if (ts.isClassDeclaration(node) && node.name?.text === 'PrometheusDriver') {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const methodName = member.name.getText(sourceFile);

            if (methodName.startsWith('_') || methodName === 'constructor' ||
                member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) {
              continue;
            }

            const description = extractJSDocComment(member, sourceFile) ||
              `${methodName.charAt(0).toUpperCase() + methodName.slice(1).replace(/([A-Z])/g, ' $1').trim()} from Prometheus API`;

            const params = extractParameterInfo(member.parameters, sourceFile);
            const returnType = member.type?.getText(sourceFile) || 'Promise<any>';
            const category = categorizePrometheusQueryMethod(methodName, description);
            const example = generatePrometheusQueryExample(methodName, params);

            methods.push({
              library: 'prometheus-query',
              className: 'PrometheusDriver',
              methodName,
              category,
              description,
              parameters: params,
              returnType,
              example,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    logger.debug(`Extracted ${methods.length} methods from prometheus-query`);
  } catch (error) {
    logger.debug(`Failed to extract prometheus-query methods: ${error instanceof Error ? error.message : String(error)}`);
  }

  return methods;
}

/**
 * Get all Prometheus library methods (dynamically extracted from .d.ts files)
 */
function getAllPrometheusMethods(): PrometheusMethod[] {
  const startTime = Date.now();

  const methods = extractPrometheusQueryMethods();

  const elapsed = Date.now() - startTime;
  logger.info(`Dynamically extracted ${methods.length} prometheus-query methods in ${elapsed}ms`);

  return methods;
}

/**
 * Prometheus methods cache (populated at service initialization)
 */
let prometheusMethodsCache: PrometheusMethod[] | null = null;

/**
 * Get cached Prometheus methods
 */
function getPrometheusMethods(): PrometheusMethod[] {
  if (!prometheusMethodsCache) {
    prometheusMethodsCache = getAllPrometheusMethods();
  }
  return prometheusMethodsCache;
}

/**
 * Clear the prometheus methods cache (used during shutdown/reset)
 */
function clearPrometheusMethodsCache(): void {
  prometheusMethodsCache = null;
}

// ============================================================================
// Analytics Library Functions (Dynamic Extraction from .d.ts files)
// ============================================================================

/**
 * Analytics functions cache
 */
let analyticsMethodsCache: AnalyticsFunction[] | null = null;

/**
 * Categorize an analytics function based on its name
 */
function categorizeAnalyticsFunction(functionName: string, library: AnalyticsLibrary): AnalyticsCategory {
  const lowerName = functionName.toLowerCase();

  // Signal processing (fft-js)
  if (library === 'fft-js' || lowerName.includes('fft') || lowerName.includes('ifft') || lowerName.includes('freq') || lowerName.includes('mag')) {
    return 'signal';
  }

  // Regression
  if (lowerName.includes('regression') || lowerName.includes('rsquared') || lowerName.includes('r_squared') ||
      lowerName.includes('polynomial') || lowerName.includes('exponential') || lowerName.includes('power')) {
    return 'regression';
  }

  // Matrix operations
  if (lowerName.includes('matrix') || lowerName.includes('transpose') || lowerName.includes('inv') ||
      lowerName.includes('det') || lowerName.includes('eig') || lowerName.includes('multiply') && library === 'mathjs') {
    return 'matrix';
  }

  // Distribution
  if (lowerName.includes('distribution') || lowerName.includes('probability') || lowerName.includes('poisson') ||
      lowerName.includes('bernoulli') || lowerName.includes('binomial') || lowerName.includes('gamma') ||
      lowerName.includes('probit') || lowerName.includes('logit') || lowerName.includes('erf')) {
    return 'distribution';
  }

  // Default to descriptive statistics
  return 'descriptive';
}

/**
 * Generate example code for an analytics function
 */
function generateAnalyticsExample(functionName: string, library: AnalyticsLibrary, _params: Array<{ name: string; type: string; optional: boolean }>): string {
  const requireStatement = library === 'simple-statistics'
    ? `const ss = require('simple-statistics');`
    : library === 'ml-regression'
      ? `const { ${functionName} } = require('ml-regression');`
      : library === 'mathjs'
        ? `const math = require('mathjs');`
        : `const fft = require('fft-js');`;

  const exampleData = '[45, 52, 48, 55, 50]';
  const callPrefix = library === 'simple-statistics' ? 'ss' : library === 'mathjs' ? 'math' : library === 'fft-js' ? 'fft' : '';

  if (library === 'ml-regression') {
    return `${requireStatement}
const x = [0, 1, 2, 3, 4, 5];
const y = [10, 20, 35, 45, 60, 70];
const regression = new ${functionName}(x, y);
console.log('Prediction at x=6:', regression.predict(6));`;
  }

  return `${requireStatement}
const data = ${exampleData};
const result = ${callPrefix}.${functionName}(data);
console.log('Result:', result);`;
}

/**
 * Extract functions from simple-statistics library .d.ts files
 */
function extractSimpleStatisticsFunctions(): AnalyticsFunction[] {
  const functions: AnalyticsFunction[] = [];

  try {
    const indexPath = join(process.cwd(), 'node_modules', 'simple-statistics', 'index.d.ts');
    if (!existsSync(indexPath)) {
      logger.debug('simple-statistics index.d.ts not found');
      return functions;
    }

    const sourceCode = readFileSync(indexPath, 'utf-8');
    const sourceFile = ts.createSourceFile(indexPath, sourceCode, ts.ScriptTarget.Latest, true);

    // Parse export declarations to get function names
    function visit(node: ts.Node) {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exportName = element.name.getText(sourceFile);
          const localName = element.propertyName?.getText(sourceFile) || exportName;

          // Skip aliases (like 'iqr' for 'interquartileRange')
          if (localName === 'default' && exportName !== localName) {
            continue;
          }

          // Try to read the individual .d.ts file for this function
          const funcDtsPath = join(process.cwd(), 'node_modules', 'simple-statistics', 'src', `${toSnakeCase(exportName)}.d.ts`);

          let description = `${exportName} function from simple-statistics`;
          let signature = `${exportName}(...args): any`;
          let returnType = 'number';
          const params: Array<{ name: string; type: string; optional: boolean; description?: string }> = [];

          if (existsSync(funcDtsPath)) {
            try {
              const funcSource = readFileSync(funcDtsPath, 'utf-8');
              const funcFile = ts.createSourceFile(funcDtsPath, funcSource, ts.ScriptTarget.Latest, true);

              funcFile.forEachChild((funcNode) => {
                if (ts.isFunctionDeclaration(funcNode) && funcNode.name) {
                  // Extract JSDoc comment
                  const jsDocComment = extractJSDocComment(funcNode, funcFile);
                  if (jsDocComment) {
                    description = jsDocComment;
                  }

                  // Extract parameters
                  for (const param of funcNode.parameters) {
                    const paramName = param.name.getText(funcFile);
                    const paramType = param.type?.getText(funcFile) || 'any';
                    const isOptional = !!param.questionToken;
                    params.push({ name: paramName, type: paramType, optional: isOptional });
                  }

                  // Extract return type
                  if (funcNode.type) {
                    returnType = funcNode.type.getText(funcFile);
                  }

                  // Build signature
                  const paramStr = params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
                  signature = `${exportName}(${paramStr}): ${returnType}`;
                }
              });
            } catch {
              // Ignore individual file errors
            }
          }

          const category = categorizeAnalyticsFunction(exportName, 'simple-statistics');
          const example = generateAnalyticsExample(exportName, 'simple-statistics', params);

          functions.push({
            library: 'simple-statistics',
            functionName: exportName,
            category,
            description,
            signature,
            parameters: params.length > 0 ? params : [{ name: 'data', type: 'number[]', optional: false }],
            returnType,
            example,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    logger.debug(`Extracted ${functions.length} functions from simple-statistics`);
  } catch (error) {
    logger.debug(`Failed to extract simple-statistics functions: ${error instanceof Error ? error.message : String(error)}`);
  }

  return functions;
}

/**
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

/**
 * Extract functions from mathjs library .d.ts files
 */
function extractMathjsFunctions(): AnalyticsFunction[] {
  const functions: AnalyticsFunction[] = [];

  try {
    const indexPath = join(process.cwd(), 'node_modules', 'mathjs', 'types', 'index.d.ts');
    if (!existsSync(indexPath)) {
      logger.debug('mathjs types/index.d.ts not found');
      return functions;
    }

    const sourceCode = readFileSync(indexPath, 'utf-8');
    const sourceFile = ts.createSourceFile(indexPath, sourceCode, ts.ScriptTarget.Latest, true);

    // Track which functions we've already added (to avoid duplicates from overloads)
    const seenFunctions = new Set<string>();

    // Key math functions we want to expose (mathjs has hundreds, we focus on useful ones)
    const targetFunctions = new Set([
      'mean', 'median', 'mode', 'std', 'variance', 'sum', 'min', 'max',
      'matrix', 'multiply', 'transpose', 'inv', 'det', 'eigs', 'dot', 'cross',
      'add', 'subtract', 'divide', 'pow', 'sqrt', 'abs', 'round', 'floor', 'ceil',
      'log', 'log10', 'exp', 'sin', 'cos', 'tan',
      'zeros', 'ones', 'identity', 'diag', 'range',
      'quantileSeq', 'mad', 'prod',
    ]);

    function visit(node: ts.Node) {
      // Look for interface declarations that contain math functions
      if (ts.isInterfaceDeclaration(node)) {
        const interfaceName = node.name.getText(sourceFile);

        // MathJsInstance contains the main math functions
        if (interfaceName === 'MathJsInstance') {
          for (const member of node.members) {
            if (ts.isMethodSignature(member) && member.name) {
              const methodName = member.name.getText(sourceFile);

              // Only extract targeted functions and skip duplicates
              if (!targetFunctions.has(methodName) || seenFunctions.has(methodName)) {
                continue;
              }
              seenFunctions.add(methodName);

              const description = extractJSDocComment(member, sourceFile) ||
                `${methodName} function from mathjs`;

              const params: Array<{ name: string; type: string; optional: boolean }> = [];
              for (const param of member.parameters) {
                const paramName = param.name.getText(sourceFile);
                const paramType = param.type?.getText(sourceFile) || 'any';
                const isOptional = !!param.questionToken;
                params.push({ name: paramName, type: paramType, optional: isOptional });
              }

              const returnType = member.type?.getText(sourceFile) || 'any';
              const paramStr = params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
              const signature = `${methodName}(${paramStr}): ${returnType}`;

              const category = categorizeAnalyticsFunction(methodName, 'mathjs');
              const example = generateAnalyticsExample(methodName, 'mathjs', params);

              functions.push({
                library: 'mathjs',
                functionName: methodName,
                category,
                description,
                signature,
                parameters: params,
                returnType,
                example,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    logger.debug(`Extracted ${functions.length} functions from mathjs`);
  } catch (error) {
    logger.debug(`Failed to extract mathjs functions: ${error instanceof Error ? error.message : String(error)}`);
  }

  return functions;
}

/**
 * Extract classes from ml-regression library (no .d.ts, so use known exports)
 */
function extractMlRegressionFunctions(): AnalyticsFunction[] {
  // ml-regression doesn't have .d.ts files, define known exports
  const regressionClasses = [
    { name: 'SimpleLinearRegression', description: 'Simple linear regression (y = mx + b)' },
    { name: 'PolynomialRegression', description: 'Polynomial regression for non-linear trends' },
    { name: 'ExponentialRegression', description: 'Exponential regression for growth/decay patterns' },
    { name: 'PowerRegression', description: 'Power regression (y = a * x^b)' },
    { name: 'MultivariateLinearRegression', description: 'Multivariate linear regression' },
    { name: 'TheilSenRegression', description: 'Robust linear regression using Theil-Sen estimator' },
    { name: 'RobustPolynomialRegression', description: 'Robust polynomial regression' },
  ];

  return regressionClasses.map(cls => ({
    library: 'ml-regression' as AnalyticsLibrary,
    functionName: cls.name,
    category: 'regression' as AnalyticsCategory,
    description: cls.description,
    signature: `new ${cls.name}(x: number[], y: number[])`,
    parameters: [
      { name: 'x', type: 'number[]', optional: false, description: 'Independent variable values' },
      { name: 'y', type: 'number[]', optional: false, description: 'Dependent variable values' },
    ],
    returnType: cls.name,
    example: `const { ${cls.name} } = require('ml-regression');
const x = [0, 1, 2, 3, 4, 5];
const y = [10, 20, 35, 45, 60, 70];
const regression = new ${cls.name}(x, y);
console.log('Slope:', regression.slope);
console.log('Prediction at x=6:', regression.predict(6));`,
  }));
}

/**
 * Extract functions from fft-js library (no .d.ts, so use known exports)
 */
function extractFftJsFunctions(): AnalyticsFunction[] {
  // fft-js doesn't have .d.ts files, define known exports
  const fftFunctions: AnalyticsFunction[] = [
    {
      library: 'fft-js',
      functionName: 'fft',
      category: 'signal',
      description: 'Compute Fast Fourier Transform to find periodic patterns in time-series data',
      signature: 'fft(signal: number[]): [number[], number[]]',
      parameters: [{ name: 'signal', type: 'number[]', optional: false, description: 'Time-domain signal (length should be power of 2)' }],
      returnType: '[number[], number[]]',
      example: `const fft = require('fft-js').fft;
const signal = [1, 0, 1, 0, 1, 0, 1, 0];
const phasors = fft(signal);
console.log('Phasors:', phasors);`,
    },
    {
      library: 'fft-js',
      functionName: 'ifft',
      category: 'signal',
      description: 'Compute Inverse FFT to reconstruct signal from frequency domain',
      signature: 'ifft(phasors: [number[], number[]]): number[]',
      parameters: [{ name: 'phasors', type: '[number[], number[]]', optional: false, description: 'Frequency-domain phasors from fft()' }],
      returnType: 'number[]',
      example: `const { fft, ifft } = require('fft-js');
const signal = [1, 0, 1, 0, 1, 0, 1, 0];
const phasors = fft(signal);
const reconstructed = ifft(phasors);
console.log('Reconstructed:', reconstructed);`,
    },
    {
      library: 'fft-js',
      functionName: 'util.fftMag',
      category: 'signal',
      description: 'Calculate magnitude spectrum from FFT phasors',
      signature: 'util.fftMag(phasors: [number[], number[]]): number[]',
      parameters: [{ name: 'phasors', type: '[number[], number[]]', optional: false, description: 'Phasors from fft()' }],
      returnType: 'number[]',
      example: `const { fft, util } = require('fft-js');
const signal = [1, 2, 1, 2, 1, 2, 1, 2];
const phasors = fft(signal);
const magnitudes = util.fftMag(phasors);
console.log('Magnitudes:', magnitudes);`,
    },
    {
      library: 'fft-js',
      functionName: 'util.fftFreq',
      category: 'signal',
      description: 'Get frequency values corresponding to FFT bins',
      signature: 'util.fftFreq(phasors: [number[], number[]], sampleRate: number): number[]',
      parameters: [
        { name: 'phasors', type: '[number[], number[]]', optional: false, description: 'Phasors from fft()' },
        { name: 'sampleRate', type: 'number', optional: false, description: 'Samples per unit time' },
      ],
      returnType: 'number[]',
      example: `const { fft, util } = require('fft-js');
const signal = new Array(64).fill(0).map((_, i) => Math.sin(2 * Math.PI * i / 24));
const phasors = fft(signal);
const frequencies = util.fftFreq(phasors, 1);
console.log('Frequencies:', frequencies.slice(0, 5));`,
    },
  ];

  return fftFunctions;
}

/**
 * Get all analytics library functions (dynamically extracted from .d.ts files where available)
 */
function getAllAnalyticsFunctions(): AnalyticsFunction[] {
  const startTime = Date.now();

  const functions: AnalyticsFunction[] = [
    ...extractSimpleStatisticsFunctions(),
    ...extractMathjsFunctions(),
    ...extractMlRegressionFunctions(),
    ...extractFftJsFunctions(),
  ];

  const elapsed = Date.now() - startTime;
  logger.info(`Dynamically extracted ${functions.length} analytics functions in ${elapsed}ms`);

  return functions;
}

/**
 * Get cached analytics functions
 */
function getAnalyticsFunctions(): AnalyticsFunction[] {
  if (!analyticsMethodsCache) {
    analyticsMethodsCache = getAllAnalyticsFunctions();
  }
  return analyticsMethodsCache;
}

/**
 * Clear the analytics methods cache (used during shutdown/reset)
 */
function clearAnalyticsMethodsCache(): void {
  analyticsMethodsCache = null;
}

// ============================================================================
// Loki Library Methods (Based on @prodisco/loki-client)
// ============================================================================

/**
 * Loki methods cache
 */
let lokiMethodsCache: LokiMethod[] | null = null;

/**
 * Generate example code for a Loki method
 */
function generateLokiExample(methodName: string, _className: string): string {
  const baseSetup = `// Sandbox provides: require('@prodisco/loki-client'), process.env.LOKI_URL
const { LokiClient } = require('@prodisco/loki-client');
const client = new LokiClient({ baseUrl: process.env.LOKI_URL || 'http://loki:3100' });
`;

  switch (methodName) {
    case 'queryRange':
      return `${baseSetup}
// Query logs from the last hour
const result = await client.queryRange('{app="nginx"}', { since: '1h', limit: 100 });
console.log(\`Found \${result.logs.length} log entries\`);
result.logs.forEach(log => console.log(\`[\${log.timestamp.toISOString()}] \${log.line}\`));`;

    case 'queryRangeMatrix':
      return `${baseSetup}
// Query for metric results (rate, count, etc.)
const result = await client.queryRangeMatrix('rate({app="nginx"}[5m])', { since: '1h' });
console.log(\`Found \${result.metrics.length} metric series\`);
result.metrics.forEach(m => console.log(m.labels, m.values));`;

    case 'labels':
      return `${baseSetup}
// Get all available label names
const labels = await client.labels({ since: '24h' });
console.log('Available labels:', labels);`;

    case 'labelValues':
      return `${baseSetup}
// Get values for a specific label
const values = await client.labelValues('namespace', { since: '24h' });
console.log('Namespace values:', values);`;

    case 'series':
      return `${baseSetup}
// Get log stream series matching selectors
const series = await client.series(['{namespace="default"}'], { since: '1h' });
console.log(\`Found \${series.length} series\`);
series.forEach(s => console.log(s));`;

    case 'ready':
      return `${baseSetup}
// Check if Loki is ready
const isReady = await client.ready();
console.log('Loki is ready:', isReady);`;

    default:
      return `${baseSetup}
const result = await client.${methodName}();
console.log(result);`;
  }
}

/**
 * Get all Loki methods (based on @prodisco/loki-client API)
 */
function getAllLokiMethods(): LokiMethod[] {
  const methods: LokiMethod[] = [
    // Query methods
    {
      library: '@prodisco/loki-client',
      className: 'LokiClient',
      methodName: 'queryRange',
      category: 'query',
      description: 'Query logs from Loki using LogQL. Returns parsed log entries with timestamps and labels.',
      parameters: [
        { name: 'logQL', type: 'string', optional: false, description: 'LogQL query string (e.g., {app="nginx"})' },
        { name: 'options', type: 'QueryRangeOptions', optional: true, description: 'Query options: limit, start, end, since, direction' },
      ],
      returnType: 'Promise<QueryRangeLogsResult>',
      example: generateLokiExample('queryRange', 'LokiClient'),
    },
    {
      library: '@prodisco/loki-client',
      className: 'LokiClient',
      methodName: 'queryRangeMatrix',
      category: 'query',
      description: 'Query for matrix/metric results. Use for LogQL metric queries like rate() or count_over_time().',
      parameters: [
        { name: 'logQL', type: 'string', optional: false, description: 'LogQL metric query (e.g., rate({app="nginx"}[5m]))' },
        { name: 'options', type: 'QueryRangeOptions', optional: true, description: 'Query options: limit, start, end, since' },
      ],
      returnType: 'Promise<QueryRangeMatrixResult>',
      example: generateLokiExample('queryRangeMatrix', 'LokiClient'),
    },
    {
      library: '@prodisco/loki-client',
      className: 'LokiClient',
      methodName: 'series',
      category: 'query',
      description: 'Get log stream series matching one or more stream selectors.',
      parameters: [
        { name: 'selectors', type: 'string[]', optional: false, description: 'Array of stream selectors (e.g., ["{namespace=\\"default\\"}"])' },
        { name: 'options', type: '{ start?, end?, since? }', optional: true, description: 'Time range options' },
      ],
      returnType: 'Promise<Record<string, string>[]>',
      example: generateLokiExample('series', 'LokiClient'),
    },
    // Labels methods
    {
      library: '@prodisco/loki-client',
      className: 'LokiClient',
      methodName: 'labels',
      category: 'labels',
      description: 'Get all available label names in Loki. Useful for discovering what labels exist.',
      parameters: [
        { name: 'options', type: 'LabelValuesOptions', optional: true, description: 'Options: start, end, since' },
      ],
      returnType: 'Promise<string[]>',
      example: generateLokiExample('labels', 'LokiClient'),
    },
    {
      library: '@prodisco/loki-client',
      className: 'LokiClient',
      methodName: 'labelValues',
      category: 'labels',
      description: 'Get all values for a specific label. Essential for building log queries.',
      parameters: [
        { name: 'label', type: 'string', optional: false, description: 'Label name (e.g., "namespace", "app")' },
        { name: 'options', type: 'LabelValuesOptions', optional: true, description: 'Options: start, end, since, query' },
      ],
      returnType: 'Promise<string[]>',
      example: generateLokiExample('labelValues', 'LokiClient'),
    },
    // Health check
    {
      library: '@prodisco/loki-client',
      className: 'LokiClient',
      methodName: 'ready',
      category: 'health',
      description: 'Check if Loki is ready and accepting requests.',
      parameters: [],
      returnType: 'Promise<boolean>',
      example: generateLokiExample('ready', 'LokiClient'),
    },
  ];

  return methods;
}

/**
 * Get cached Loki methods
 */
function getLokiMethods(): LokiMethod[] {
  if (!lokiMethodsCache) {
    lokiMethodsCache = getAllLokiMethods();
    logger.info(`Loaded ${lokiMethodsCache.length} Loki methods`);
  }
  return lokiMethodsCache;
}

/**
 * Clear the Loki methods cache (used during shutdown/reset)
 */
function clearLokiMethodsCache(): void {
  lokiMethodsCache = null;
}

// ============================================================================
// Script Parsing Functions
// ============================================================================

/**
 * Extract the first comment block from a TypeScript file using TypeScript AST.
 * Supports block comments and consecutive single-line comments.
 */
function extractFirstCommentBlock(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // Get leading comments from the start of the file using TypeScript's comment parser
    const leadingComments = ts.getLeadingCommentRanges(content, 0);

    if (!leadingComments || leadingComments.length === 0) {
      return '';
    }

    // Collect all consecutive comments at the start
    const commentTexts: string[] = [];
    for (const comment of leadingComments) {
      const commentText = content.slice(comment.pos, comment.end);

      if (comment.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        // Block comment - extract content between /* and */
        const inner = commentText.slice(2, -2); // Remove /* and */
        const lines = inner.split('\n');
        for (const line of lines) {
          // Remove leading asterisks and whitespace
          let cleaned = line.trim();
          if (cleaned.startsWith('*')) {
            cleaned = cleaned.slice(1).trim();
          }
          if (cleaned.length > 0) {
            commentTexts.push(cleaned);
          }
        }
      } else if (comment.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
        // Single-line comment - remove leading //
        const cleaned = commentText.slice(2).trim();
        if (cleaned.length > 0) {
          commentTexts.push(cleaned);
        }
      }
    }

    return commentTexts.join(' ').trim();
  } catch (error) {
    logger.debug(`Failed to extract comment from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * Check if a filename is an auto-generated script name from runSandbox.
 * Auto-generated names look like: script-2025-12-04T13-47-57-abc123def456.ts
 */
function isAutoGeneratedScriptName(filename: string): boolean {
  // Match pattern: script-YYYY-MM-DDTHH-MM-SS-<hash>.ts
  return /^script-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]+\.ts$/.test(filename);
}

/**
 * Extract likely resource types from a script filename.
 * Only used for manually named scripts, NOT for auto-generated ones.
 * Examples:
 *   "get-pod-logs.ts" -> ["pod", "log", "logs"]
 *   "list-nodes.ts" -> ["node", "nodes"]
 */
function extractResourceTypesFromFilename(filename: string): string[] {
  // Skip auto-generated filenames - they have no meaningful resource info
  if (isAutoGeneratedScriptName(filename)) {
    return [];
  }

  // Remove extension
  const baseName = filename.replace(/\.ts$/, '');

  // Split by common separators and filter out action words
  const parts = baseName
    .split(/[-_]/)
    .filter(part => part.length > 0)
    .filter(part => !['get', 'list', 'create', 'delete', 'update', 'patch', 'watch'].includes(part.toLowerCase()));

  // Add singular/plural variants
  const resourceTypes: string[] = [];
  for (const part of parts) {
    resourceTypes.push(part.toLowerCase());
    // Add singular if plural
    if (part.endsWith('s') && part.length > 2) {
      resourceTypes.push(part.slice(0, -1).toLowerCase());
    }
  }

  return [...new Set(resourceTypes)];
}

/**
 * Extract K8s API signals from script content using TypeScript AST.
 * Extracts API class references and resource type references.
 */
function extractApiSignals(filePath: string): { apiClasses: string[]; resourceTypes: string[] } {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const apiClasses = new Set<string>();
    const resourceTypes = new Set<string>();

    // Known K8s API class names
    const knownApiClasses = new Set([
      'CoreV1Api', 'AppsV1Api', 'BatchV1Api', 'NetworkingV1Api',
      'RbacAuthorizationV1Api', 'StorageV1Api', 'CustomObjectsApi',
      'ApiextensionsV1Api', 'AutoscalingV1Api', 'PolicyV1Api',
    ]);

    function visit(node: ts.Node) {
      // Find type references (V1Pod, V1Deployment, etc.)
      if (ts.isTypeReferenceNode(node)) {
        const typeName = node.typeName.getText(sourceFile);
        // K8s types start with V followed by version number
        if (typeName.startsWith('V') && typeName.length > 2) {
          const secondChar = typeName.charAt(1);
          if (secondChar >= '0' && secondChar <= '9') {
            // Filter out Api and List types
            if (!typeName.includes('Api') && !typeName.includes('List') && typeName.length < 30) {
              resourceTypes.add(typeName);
            }
          }
        }
      }

      // Find identifier references to API classes
      if (ts.isIdentifier(node)) {
        const name = node.text;
        if (knownApiClasses.has(name)) {
          apiClasses.add(name);
        }
      }

      // Find property access like k8s.CoreV1Api
      if (ts.isPropertyAccessExpression(node)) {
        const propName = node.name.text;
        if (knownApiClasses.has(propName)) {
          apiClasses.add(propName);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return {
      apiClasses: [...apiClasses],
      resourceTypes: [...resourceTypes].slice(0, MAX_RESOURCE_TYPES_FROM_CONTENT),
    };
  } catch (error) {
    logger.debug(`Failed to extract API signals from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { apiClasses: [], resourceTypes: [] };
  }
}

/**
 * Parse a cached script file and extract searchable metadata.
 */
function parseScriptFile(filePath: string): CachedScript | null {
  try {
    const filename = basename(filePath);
    const description = extractFirstCommentBlock(filePath);
    const filenameResourceTypes = extractResourceTypesFromFilename(filename);
    const { apiClasses, resourceTypes: contentResourceTypes } = extractApiSignals(filePath);

    // Combine resource types from filename and content
    const resourceTypes = [...new Set([...filenameResourceTypes, ...contentResourceTypes.map(t => t.toLowerCase())])];

    // Extract additional keywords from description
    const keywords = description
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2)
      .filter(word => !['the', 'and', 'for', 'from', 'with', 'this', 'that'].includes(word));

    return {
      filename,
      filePath,
      description: description || `Script: ${filename.replace(/\.ts$/, '')}`,
      resourceTypes,
      apiClasses,
      keywords,
    };
  } catch (error) {
    logger.debug(`Failed to parse script ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Build an Orama document from a CachedScript
 */
function buildScriptDocument(script: CachedScript): OramaDocument {
  // For auto-generated scripts, don't include filename in search tokens
  // as it contains meaningless timestamp and hash
  const isAutoGenerated = isAutoGeneratedScriptName(script.filename);

  // Build search tokens from content analysis, NOT filename for auto-generated scripts
  const searchTokens = [
    'script', // Always include 'script' so scripts can be found with default query
    // Only include filename tokens for manually named scripts
    ...(isAutoGenerated ? [] : [script.filename.replace(/\.ts$/, '').replace(/[-_]/g, ' ')]),
    ...script.resourceTypes,
    script.description,
    ...script.apiClasses,
    ...script.keywords,
  ].join(' ');

  return {
    id: `script:${script.filename}`,
    documentType: 'script',
    name: isAutoGenerated
      ? (script.apiClasses.length > 0 ? script.apiClasses[0]!.toLowerCase() : 'sandbox-script')
      : script.filename.replace(/\.ts$/, ''),
    description: script.description,
    searchTokens,
    library: script.apiClasses.length > 0 ? script.apiClasses[0]! : 'CachedScript',
    category: 'script',
    // Method-specific
    resourceType: script.resourceTypes.join(' '),
    scope: 'script',
    filePath: script.filePath,
    // Type fields (empty for scripts)
    properties: '',
    typeDefinition: '',
    nestedTypes: '',
    typeKind: '',
  };
}

// ============================================================================
// End Script Parsing Functions
// ============================================================================

/**
 * Initialize scripts directory with node_modules symlink for package resolution
 */
function initializeScriptsDirectory(scriptsDir: string): void {
  try {
    // Ensure scripts directory exists
    if (!existsSync(scriptsDir)) {
      mkdirSync(scriptsDir, { recursive: true });
    }

    // Create symlink to node_modules
    // When installed via npx: PACKAGE_ROOT = /path/npx/node_modules/@prodisco/k8s-mcp
    //   -> dependencies are in: /path/npx/node_modules (go up 2 levels)
    // When running in dev: PACKAGE_ROOT = /path/to/project
    //   -> dependencies are in: /path/to/project/node_modules
    const nodeModulesLink = join(scriptsDir, 'node_modules');

    // Detect if running from npx cache (path contains node_modules/@prodisco)
    const isNpxInstall = PACKAGE_ROOT.includes('node_modules/@prodisco') ||
                         PACKAGE_ROOT.includes('node_modules\\@prodisco');

    const nodeModulesTarget = isNpxInstall
      ? realpathSync(join(PACKAGE_ROOT, '../..'))  // npx: go up from node_modules/@prodisco/k8s-mcp
      : realpathSync(join(PACKAGE_ROOT, 'node_modules'));  // dev: use project's node_modules

    if (!existsSync(nodeModulesTarget)) {
      logger.warn(`node_modules target does not exist: ${nodeModulesTarget}`);
      return;
    }

    // Always remove existing symlink and recreate to ensure it points to current location
    try {
      unlinkSync(nodeModulesLink);
    } catch {
      // Ignore - doesn't exist
    }

    try {
      symlinkSync(nodeModulesTarget, nodeModulesLink, 'dir');
    } catch (err) {
      logger.warn(`Could not create symlink to node_modules: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    logger.warn(`Could not initialize scripts directory: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract type definition from a TypeScript file using TS compiler API
 */
function extractTypeFromFile(typeName: string): string | null {
  const basePath = process.cwd();
  const modelsPath = join(basePath, 'node_modules', '@kubernetes', 'client-node', 'dist', 'gen', 'models');
  const filePath = join(modelsPath, `${typeName}.d.ts`);
  
  if (!existsSync(filePath)) {
    return null;
  }
  
  try {
    const sourceCode = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );
    
    let result: string | null = null;
    
    function visit(node: ts.Node) {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && 
          node.name && node.name.text === typeName) {
        let def = `export class ${typeName} {\n`;
        
        node.members?.forEach((member) => {
          if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
            if (member.name) {
              const propName = member.name.getText(sourceFile).replace(/['"]/g, '');
              const propType = member.type?.getText(sourceFile) || 'any';
              const optional = member.questionToken ? '?' : '';
              def += `  ${propName}${optional}: ${propType};\n`;
            }
          }
        });
        
        def += `}`;
        result = def;
      }
      
      ts.forEachChild(node, visit);
    }
    
    visit(sourceFile);
    return result;
  } catch {
    return null;
  }
}

/**
 * Extract input and output type definitions for a method
 */
function extractMethodTypeDefinitions(apiClass: string, methodName: string, resourceType: string): { input?: string; output?: string } {
  const result: { input?: string; output?: string } = {};
  
  // Determine request type (for methods that take parameters)
  if (methodName.includes('create') || methodName.includes('replace') || methodName.includes('patch')) {
    const requestTypeName = `${apiClass}${methodName.charAt(0).toUpperCase() + methodName.slice(1)}Request`;
    result.input = extractTypeFromFile(requestTypeName) || undefined;
  }
  
  // Determine response type based on method
  if (methodName.startsWith('list')) {
    const listTypeName = `V1${resourceType}List`;
    result.output = extractTypeFromFile(listTypeName) || undefined;
  } else if (methodName.startsWith('read') || methodName.startsWith('create') || methodName.startsWith('replace')) {
    const singleTypeName = `V1${resourceType}`;
    result.output = extractTypeFromFile(singleTypeName) || undefined;
  }
  
  return result;
}

function extractResourceType(methodName: string): string {
  let resource = methodName
    .replace(/^(list|read|create|delete|patch|replace|connect|get|watch)/, '')
    .replace(/^Namespaced/, '')
    .replace(/^Cluster/, '')
    .replace(/ForAllNamespaces$/, '')
    .replace(/WithHttpInfo$/, '');

  if (resource.startsWith('Collection')) {
    resource = resource.replace(/^Collection/, '');
  }

  return resource || 'Resource';
}

function generateDescriptionFromMethodName(methodName: string, classDesc: string): string {
  const words = methodName.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  const resourceMatch = methodName.match(/(?:list|read|create|delete|patch|replace)(?:Namespaced)?(.+?)(?:ForAllNamespaces)?$/);
  const resource = resourceMatch ? resourceMatch[1] : '';

  let desc = words.charAt(0).toUpperCase() + words.slice(1);
  if (resource) desc += ` (${resource})`;
  desc += ` - ${classDesc}`;

  return desc;
}

function inferParameters(methodName: string, apiClass: string): Array<{ name: string; type: string; optional: boolean; description?: string }> {
  const parameters: Array<{ name: string; type: string; optional: boolean; description?: string }> = [];
  
  // CustomObjectsApi has special parameter requirements
  if (apiClass === 'CustomObjectsApi') {
    if (methodName.includes('CustomObject')) {
      parameters.push({ name: 'group', type: 'string', optional: false, description: 'API group (e.g., "webapp.example.com")' });
      parameters.push({ name: 'version', type: 'string', optional: false, description: 'API version (e.g., "v1")' });
      
      if (methodName.includes('Namespaced')) {
        parameters.push({ name: 'namespace', type: 'string', optional: false, description: 'Namespace scope' });
      }
      
      parameters.push({ name: 'plural', type: 'string', optional: false, description: 'Resource plural name (e.g., "guestbooks")' });
      
      if (methodName.includes('get') && !methodName.includes('list')) {
        parameters.push({ name: 'name', type: 'string', optional: false, description: 'Resource name' });
      }
      
      if (methodName.includes('create') || methodName.includes('replace')) {
        parameters.push({ name: 'body', type: 'object', optional: false, description: 'Custom resource object' });
      }
    }
    return parameters;
  }
  
  // Standard API classes (CoreV1Api, AppsV1Api, etc.)
  if (methodName.includes('Namespaced')) {
    if (methodName.startsWith('list')) {
      parameters.push({ name: 'namespace', type: 'string', optional: false, description: 'Namespace scope' });
    } else if (methodName.startsWith('read') || methodName.startsWith('delete') || methodName.startsWith('patch') || methodName.startsWith('replace')) {
      parameters.push({ name: 'name', type: 'string', optional: false, description: 'Resource name' });
      parameters.push({ name: 'namespace', type: 'string', optional: false, description: 'Namespace scope' });
    } else if (methodName.startsWith('create')) {
      parameters.push({ name: 'namespace', type: 'string', optional: false, description: 'Namespace scope' });
      parameters.push({ name: 'body', type: 'object', optional: false, description: 'Resource object' });
    }
  } else if (!methodName.includes('Namespaced')) {
    if (methodName.startsWith('read') || methodName.startsWith('delete') || methodName.startsWith('patch') || methodName.startsWith('replace')) {
      parameters.push({ name: 'name', type: 'string', optional: false, description: 'Resource name' });
    } else if (methodName.startsWith('create')) {
      parameters.push({ name: 'body', type: 'object', optional: false, description: 'Resource object' });
    }
  }
  
  return parameters;
}

function generateInputSchema(parameters: Array<{ name: string; type: string; optional: boolean; description?: string }>) {
  const properties: Record<string, { type: string; description?: string; required?: boolean }> = {};
  const required: string[] = [];
  
  for (const param of parameters) {
    properties[param.name] = {
      type: param.type,
      description: param.description,
      required: !param.optional,
    };
    if (!param.optional) {
      required.push(param.name);
    }
  }
  
  // CRITICAL: Always accept an object, even if empty
  const hasRequiredParams = required.length > 0;
  
  return {
    type: 'object' as const,
    properties,
    required,
    description: hasRequiredParams 
      ? `Parameters object. Required fields: ${required.join(', ')}`
      : 'Empty object {}. This method takes no required parameters, but you MUST still pass an empty object.',
  };
}

function generateOutputSchema(methodName: string, resourceType: string) {
  const isList = methodName.startsWith('list');
  const isRead = methodName.startsWith('read');
  const isCreate = methodName.startsWith('create');
  const isDelete = methodName.startsWith('delete');
  
  let description = 'Response from Kubernetes API';
  
  if (isList) {
    description = `Response has 'items' array containing ${resourceType} resources. Access: response.items[]`;
  } else if (isRead || isCreate) {
    description = `Response IS the ${resourceType} object. Access: response.metadata, response.spec, response.status`;
  } else if (isDelete) {
    description = 'Response IS the status object. Access: response.status';
  }
  
  return {
    type: 'object' as const,
    description,
    properties: {
      items: {
        type: isList ? 'array' : 'undefined',
        description: isList ? `Array of ${resourceType} objects` : 'Not applicable',
      },
    },
  };
}

function generateUsageExample(apiClass: string, methodName: string, parameters: Array<{ name: string; type: string; optional: boolean }>): string {
  const apiVar = apiClass.charAt(0).toLowerCase() + apiClass.slice(1);
  const requiredParams = parameters.filter(p => !p.optional);

  // Sandbox-compatible example: k8s and kc are pre-provided, no imports or main() wrapper needed
  let example = `// Sandbox provides: k8s, kc (pre-configured KubeConfig), console\nconst ${apiVar} = kc.makeApiClient(k8s.${apiClass});\n\n`;

  let paramStr = '{}';
  if (requiredParams.length > 0) {
    const paramPairs = requiredParams.map(p => {
      if (p.name === 'name') return `name: 'my-resource'`;
      if (p.name === 'namespace') return `namespace: 'default'`;
      if (p.name === 'body') return `body: { /* resource object */ }`;
      return `${p.name}: 'value'`;
    });
    paramStr = `{ ${paramPairs.join(', ')} }`;
  }

  example += `// IMPORTANT: Always pass object parameter (even if empty {})\nconst response = await ${apiVar}.${methodName}(${paramStr});\n\n`;

  if (methodName.startsWith('list')) {
    example += `// Response structure: response.items is an array\nconst items = response.items;\nconsole.log(\`Found \${items.length} resources\`);`;
  } else if (methodName.startsWith('read') || methodName.startsWith('get')) {
    example += `// Response IS the resource object\nconsole.log(\`Resource: \${response.metadata?.name}\`);`;
  } else if (methodName.startsWith('create')) {
    example += `// Response IS the created resource\nconsole.log(\`Created: \${response.metadata?.name}\`);`;
  } else if (methodName.startsWith('delete')) {
    example += `// Response IS the status object\nconsole.log(\`Status: \${response.status}\`);`;
  } else {
    example += `// Response contains the result directly\nconsole.log(response);`;
  }

  return example;
}

// ============================================================================
// Unified Search Mode Execution
// ============================================================================

/**
 * Execute unified search mode - searches all indexed documents with unified filters
 */
async function executeSearchMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<SearchToolsResult> {
  const {
    query = '',
    documentType = 'all',
    category,
    library,
    exclude,
    limit = 10,
    offset = 0
  } = input;

  const scriptsDirectory = SCRIPTS_CACHE_DIR;
  initializeScriptsDirectory(scriptsDirectory);

  // Use the unified search
  const searchResult = await searchToolsService.searchWithOrama({
    query: query || documentType, // Use documentType as fallback query for discovery
    documentType,
    category,
    library,
    exclude,
    limit,
    offset,
  });

  // Get method details from caches
  const allK8sMethods = searchToolsService.getApiMethods();
  const k8sMethodMap = new Map(allK8sMethods.map(m => [`${m.apiClass}.${m.methodName}`, m]));

  const allPrometheusMethods = getPrometheusMethods();
  const prometheusMethodMap = new Map(allPrometheusMethods.map(m =>
    [`prometheus:${m.library}:${m.className || 'fn'}:${m.methodName}`, m]
  ));

  const allLokiMethods = getLokiMethods();
  const lokiMethodMap = new Map(allLokiMethods.map(m =>
    [`loki:${m.library}:${m.className || 'fn'}:${m.methodName}`, m]
  ));

  const allAnalyticsFunctions = getAnalyticsFunctions();
  const analyticsMap = new Map(allAnalyticsFunctions.map(f =>
    [`analytics:${f.library}:${f.functionName}`, f]
  ));

  // Map results to unified format
  const results = searchResult.results.map(doc => {
    let parameters: Array<{ name: string; type: string; optional: boolean; description?: string }> | undefined;
    let returnType: string | undefined;
    let example: string | undefined;
    let properties: Array<{ name: string; type: string; optional: boolean; description?: string }> | undefined;
    let typeDefinition: string | undefined;
    let nestedTypes: string[] | undefined;
    let typeKind: string | undefined;

    if (doc.documentType === 'kubernetes') {
      const method = k8sMethodMap.get(doc.id);
      if (method) {
        parameters = method.parameters;
        returnType = method.returnType;
        example = method.example;
      }
    } else if (doc.documentType === 'prometheus') {
      const method = prometheusMethodMap.get(doc.id);
      if (method) {
        parameters = method.parameters;
        returnType = method.returnType;
        example = method.example;
      }
    } else if (doc.documentType === 'loki') {
      const method = lokiMethodMap.get(doc.id);
      if (method) {
        parameters = method.parameters;
        returnType = method.returnType;
        example = method.example;
      }
    } else if (doc.documentType === 'analytics') {
      const func = analyticsMap.get(doc.id);
      if (func) {
        parameters = func.parameters;
        returnType = func.returnType;
        example = func.example;
      }
    } else if (doc.documentType === 'type') {
      // Type documents have their info stored directly
      if (doc.properties) {
        try {
          properties = JSON.parse(doc.properties);
        } catch {
          properties = [];
        }
      }
      typeDefinition = doc.typeDefinition || undefined;
      nestedTypes = doc.nestedTypes ? doc.nestedTypes.split(',').filter(Boolean) : [];
      typeKind = doc.typeKind || undefined;
    }

    return {
      id: doc.id,
      documentType: doc.documentType,
      name: doc.name,
      description: doc.description,
      library: doc.library,
      category: doc.category,
      // Method-specific
      parameters,
      returnType,
      example,
      // Type-specific
      properties,
      typeDefinition,
      nestedTypes,
      typeKind,
    };
  });

  // Map script results
  const relevantScripts: RelevantScript[] = searchResult.scriptResults.map(doc => ({
    filename: doc.id.replace(/^script:/, ''),
    description: doc.description,
    apiClasses: doc.library !== 'CachedScript' ? [doc.library] : [],
  }));

  const hasMore = offset + results.length < searchResult.totalMatches;

  // Build summary
  let summary = `SEARCH RESULTS`;
  if (query) summary += ` for "${query}"`;
  if (documentType !== 'all') summary += ` (type: ${documentType})`;
  if (category) summary += ` (category: ${category})`;
  if (library) summary += ` (library: ${library})`;
  summary += `\n\nFound ${searchResult.totalMatches} result(s) (search: ${searchResult.searchTime.toFixed(2)}ms)`;
  if (offset > 0 || hasMore) {
    summary += ` | Page ${Math.floor(offset / limit) + 1}, showing ${offset + 1}-${offset + results.length} of ${searchResult.totalMatches}`;
  }
  summary += `\n\n`;

  // Show relevant scripts first if any
  if (relevantScripts.length > 0) {
    summary += `═══════════════════════════════════════════════════════════════\n`;
    summary += `CACHED SCRIPTS AVAILABLE - USE THESE FIRST!\n`;
    summary += `═══════════════════════════════════════════════════════════════\n`;
    relevantScripts.forEach((script, i) => {
      summary += `${i + 1}. ${script.filename}\n`;
      summary += `   ${script.description}\n`;
      summary += `   > runSandbox({ cached: "${script.filename}" })\n\n`;
    });
    summary += `═══════════════════════════════════════════════════════════════\n\n`;
  }

  // Show facets
  if (Object.keys(searchResult.facets.documentType).length > 0) {
    summary += `FACETS:\n`;
    summary += `   Document Types: ${Object.entries(searchResult.facets.documentType).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    if (Object.keys(searchResult.facets.library).length > 0) {
      summary += `   Libraries: ${Object.entries(searchResult.facets.library).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    }
    if (Object.keys(searchResult.facets.category).length > 0) {
      summary += `   Categories: ${Object.entries(searchResult.facets.category).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    }
    summary += `\n`;
  }

  // Show results
  summary += `RESULTS:\n\n`;
  results.forEach((result, i) => {
    summary += `${i + 1}. [${result.documentType}] ${result.library}:${result.name}\n`;
    summary += `   ${result.description}\n`;

    if (result.documentType === 'type') {
      // Show type-specific info
      if (result.typeKind) {
        summary += `   Kind: ${result.typeKind}\n`;
      }
      if (result.properties && result.properties.length > 0) {
        const props = result.properties.slice(0, 5).map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
        summary += `   Properties: ${props}${result.properties.length > 5 ? ` ... +${result.properties.length - 5} more` : ''}\n`;
      }
      if (result.nestedTypes && result.nestedTypes.length > 0) {
        summary += `   Nested types: ${result.nestedTypes.slice(0, 5).join(', ')}${result.nestedTypes.length > 5 ? ` ... +${result.nestedTypes.length - 5} more` : ''}\n`;
      }
    } else {
      // Show method-specific info
      if (result.parameters && result.parameters.length > 0) {
        const params = result.parameters.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
        summary += `   Params: (${params})\n`;
      }
      if (result.returnType) {
        summary += `   Returns: ${result.returnType}\n`;
      }
    }
    summary += `\n`;
  });

  if (results.length === 0) {
    summary += `No results found. Try:\n`;
    summary += `- Different query term\n`;
    summary += `- Omit filters to see more results\n`;
    summary += `- Use documentType filter: kubernetes, prometheus, loki, analytics, type\n`;
  }

  const usage =
    'USAGE:\n' +
    '- New code: runSandbox({ code: "..." })\n' +
    '- Cached script: runSandbox({ cached: "script-name.ts" })\n' +
    '- Execution modes: "execute" (blocking), "stream" (real-time), "async" (non-blocking)\n' +
    '\n' +
    'LIBRARY IMPORTS:\n' +
    '- Prometheus: const { PrometheusDriver } = require("prometheus-query"); const prom = new PrometheusDriver({ endpoint: process.env.PROMETHEUS_URL });\n' +
    '- Loki: const { LokiClient } = require("@prodisco/loki-client"); const client = new LokiClient({ baseUrl: process.env.LOKI_URL });\n' +
    '- Analytics: require("simple-statistics"), require("ml-regression"), require("mathjs"), require("fft-js")\n' +
    '- K8s: k8s and kc (KubeConfig) are pre-configured globals';

  return {
    summary,
    results,
    totalMatches: searchResult.totalMatches,
    relevantScripts,
    facets: {
      documentType: searchResult.facets.documentType,
      library: searchResult.facets.library,
      category: searchResult.facets.category,
    },
    pagination: {
      offset,
      limit,
      hasMore,
    },
    searchTime: searchResult.searchTime,
    usage,
    paths: {
      scriptsDirectory,
    },
  };
}

// ============================================================================
// Warmup Export
// ============================================================================

/**
 * Pre-warm the Orama search index during server startup.
 * This avoids the indexing delay on the first search request.
 */
export async function warmupSearchIndex(): Promise<void> {
  await searchToolsService.initialize();
}

/**
 * Shutdown the search tools service. Call this during graceful shutdown.
 */
export async function shutdownSearchIndex(): Promise<void> {
  await searchToolsService.shutdown();
}

// ============================================================================
// Main Tool Export
// ============================================================================

export const searchToolsTool: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'kubernetes.searchTools',
  description:
    'Unified search for methods AND types across all libraries. ' +
    'DOCUMENT TYPES: ' +
    '• kubernetes: K8s API methods (CoreV1Api, AppsV1Api, etc.) ' +
    '• prometheus: Prometheus client methods (query, metadata, alerts) ' +
    '• loki: Loki client methods (queryRange, labels, labelValues) ' +
    '• analytics: Analytics functions (simple-statistics, mathjs, ml-regression, fft-js) ' +
    '• type: TypeScript type definitions (classes, interfaces, enums) ' +
    '• prometheus-metric: Live Prometheus metrics (requires PROMETHEUS_URL) ' +
    '• script: Cached sandbox scripts ' +
    'EXAMPLES: ' +
    '{ query: "Pod" } - Find Pod-related methods AND types ' +
    '{ query: "Pod", documentType: "type" } - Find only Pod types (V1Pod, V1PodSpec, etc.) ' +
    '{ query: "V1Deployment", documentType: "type" } - Get V1Deployment type definition ' +
    '{ documentType: "kubernetes", category: "list" } - Find all K8s list methods ' +
    '{ query: "queryRange", library: "@prodisco/loki-client" } - Find Loki queryRange method ' +
    'FILTERS: ' +
    'documentType: kubernetes | prometheus | loki | analytics | type | script | prometheus-metric | all ' +
    'category: Method actions (list, create, read) or type kinds (class, interface, enum) ' +
    'library: @kubernetes/client-node, prometheus-query, @prodisco/loki-client, mathjs, etc. ' +
    'exclude: { categories: [...], libraries: [...] }',
  schema: SearchToolsInputSchema,
  async execute(input) {
    return executeSearchMode(input);
  },
};

