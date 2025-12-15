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
  // === Search parameters (work for all modes) ===
  query: z
    .string()
    .optional()
    .describe('Search term - searches method names, descriptions, and resource types'),

  // === Filter parameters (work for all document types) ===
  documentType: z
    .enum(['kubernetes', 'prometheus', 'prometheus-metric', 'loki', 'analytics', 'script', 'all'])
    .optional()
    .default('all')
    .describe('Filter by document type: "kubernetes" (K8s API methods), "prometheus" (Prometheus client methods), "prometheus-metric" (live Prometheus metrics - requires PROMETHEUS_URL), "loki", "analytics", "script", or "all"'),

  action: z
    .string()
    .optional()
    .describe('Filter by action/category: K8s actions (list, create, read, delete, patch, replace, connect, watch) or library categories (query, metadata, alerts, descriptive, regression, etc.)'),

  library: z
    .string()
    .optional()
    .describe('Filter by library/API class: K8s (CoreV1Api, AppsV1Api, etc.) or libraries (prometheus-query, @prodisco/loki-client, simple-statistics, ml-regression, mathjs, fft-js)'),

  scope: z
    .enum(['namespaced', 'cluster', 'all'])
    .optional()
    .default('all')
    .describe('Filter by scope: "namespaced", "cluster", or "all" (K8s methods only)'),

  exclude: z
    .object({
      actions: z
        .array(z.string())
        .optional()
        .describe('Actions/categories to exclude'),
      libraries: z
        .array(z.string())
        .optional()
        .describe('Libraries/API classes to exclude'),
    })
    .optional()
    .describe('Exclusion criteria - works for all document types'),

  // === Special modes ===
  mode: z
    .enum(['search', 'types'])
    .optional()
    .default('search')
    .describe('Mode: "search" (default) searches all indexed documents, "types" fetches TypeScript type definitions. For Prometheus metrics use documentType: "prometheus-metric"'),

  // === Type mode parameters ===
  types: z
    .array(z.string())
    .optional()
    .describe('(types mode) Type names or paths (e.g., ["V1Pod", "V1Deployment.spec.template.spec"])'),
  depth: z
    .number()
    .int()
    .positive()
    .max(2)
    .default(1)
    .optional()
    .describe('(types mode) Depth of nested type definitions (1-2, default: 1)'),

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

// Result type for types mode
type TypeModeResult = {
  mode: 'types';
  summary: string;
  types: Record<string, {
    name: string;
    definition: string;
    file: string;
    nestedTypes: string[];
  }>;
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

// Unified search result type for the new search mode
type SearchModeResult = {
  mode: 'search';
  summary: string;
  results: Array<{
    id: string;
    documentType: string;
    name: string;
    description: string;
    library: string;
    action: string;
    parameters?: Array<{ name: string; type: string; optional: boolean; description?: string }>;
    returnType?: string;
    example?: string;
  }>;
  totalMatches: number;
  relevantScripts: RelevantScript[];
  facets: {
    documentType: Record<string, number>;
    library: Record<string, number>;
    action: Record<string, number>;
    scope: Record<string, number>;
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

// Union type for all modes
type SearchToolsResult = SearchModeResult | TypeModeResult;

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
 * Extract type definition from TypeScript declaration file using TypeScript compiler API
 */
function extractTypeDefinitionWithTS(typeName: string, filePath: string): { typeInfo: TypeInfo; nestedTypes: string[] } | null {
  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  let typeInfo: TypeInfo | null = null;
  const nestedTypes = new Set<string>();

  function visit(node: ts.Node) {
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && node.name.text === typeName) {
      const properties: PropertyInfo[] = [];
      const description = getJSDocDescription(node);

      node.members?.forEach((member) => {
        if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
          if (member.name) {
            const propName = member.name.getText(sourceFile);
            const propType = member.type?.getText(sourceFile) || 'any';
            const isOptional = !!member.questionToken;
            const propDescription = getJSDocDescription(member);

            properties.push({
              name: propName.replace(/['"]/g, ''),
              type: propType,
              optional: isOptional,
              description: propDescription,
            });

            const typeRefs = extractNestedTypeRefsFromNode(member.type);
            for (const ref of typeRefs) {
              if (ref !== typeName) {
                nestedTypes.add(ref);
              }
            }
          }
        }
      });

      typeInfo = {
        name: typeName,
        properties,
        description,
      };
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!typeInfo) {
    return null;
  }

  return {
    typeInfo,
    nestedTypes: Array.from(nestedTypes),
  };
}

/**
 * Extract the main type identifier from a TypeScript type node
 * Handles: Array<V1Pod>, V1PodSpec | undefined, V1Container[], etc.
 */
function extractTypeIdentifier(typeNode: ts.TypeNode): string | null {
  if (ts.isUnionTypeNode(typeNode)) {
    for (const type of typeNode.types) {
      if (type.kind === ts.SyntaxKind.UndefinedKeyword || type.kind === ts.SyntaxKind.NullKeyword) {
        continue;
      }
      return extractTypeIdentifier(type);
    }
    return null;
  }

  if (ts.isArrayTypeNode(typeNode)) {
    return extractTypeIdentifier(typeNode.elementType);
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();

    if (typeName === 'Array' && typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      const firstArg = typeNode.typeArguments[0];
      if (firstArg) {
        return extractTypeIdentifier(firstArg);
      }
    }

    return typeName;
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return null;
  }

  return null;
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

/**
 * Find type definition file in Kubernetes client-node package
 */
function findTypeDefinitionFile(typeName: string, basePath: string): string | null {
  const k8sPath = join(basePath, 'node_modules', '@kubernetes', 'client-node', 'dist', 'gen', 'models');
  const filePath = join(k8sPath, `${typeName}.d.ts`);

  if (existsSync(filePath)) {
    return filePath;
  }

  return null;
}

/**
 * Parse a type path into base type and property path
 * e.g., "V1Deployment.spec.template" -> { baseType: "V1Deployment", path: ["spec", "template"] }
 */
function parseTypePath(typePath: string): { baseType: string; path: string[] } | null {
  const parts = typePath.split('.');
  const baseType = parts[0];
  if (!baseType) {
    return null;
  }
  const path = parts.slice(1);
  return { baseType, path };
}

/**
 * Navigate through type properties to find a subtype
 */
function navigateToSubtype(
  typeInfo: TypeInfo,
  propertyPath: string[],
  basePath: string,
  cache: Map<string, TypeInfo>
): { typeInfo: TypeInfo; propertyPath: string; typeName: string } | null {
  if (propertyPath.length === 0) {
    return null;
  }

  let currentTypeInfo = typeInfo;
  let currentTypeName = typeInfo.name;
  const pathSegments: string[] = [currentTypeName];

  for (let i = 0; i < propertyPath.length; i++) {
    const propertyName = propertyPath[i];
    if (!propertyName) {
      return null;
    }

    const property = currentTypeInfo.properties.find(p => p.name === propertyName);

    if (!property) {
      return null;
    }

    pathSegments.push(propertyName);

    const filePath = findTypeDefinitionFile(currentTypeName, basePath);
    if (!filePath) {
      return null;
    }

    const sourceCode = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    let propertyTypeNode: ts.TypeNode | null = null;

    function findPropertyType(node: ts.Node) {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
          node.name && node.name.text === currentTypeName) {
        node.members?.forEach((member) => {
          if ((ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
              member.name && member.type) {
            const memberName = member.name.getText(sourceFile).replace(/['"]/g, '');
            if (memberName === propertyName) {
              propertyTypeNode = member.type;
            }
          }
        });
      }
      if (!propertyTypeNode) {
        ts.forEachChild(node, findPropertyType);
      }
    }

    findPropertyType(sourceFile);

    if (!propertyTypeNode) {
      return null;
    }

    const nextTypeName = extractTypeIdentifier(propertyTypeNode);
    if (!nextTypeName) {
      return null;
    }

    if (i === propertyPath.length - 1) {
      return {
        typeInfo: currentTypeInfo,
        propertyPath: pathSegments.join('.'),
        typeName: nextTypeName,
      };
    }

    let nextTypeInfo = cache.get(nextTypeName);

    if (!nextTypeInfo) {
      const filePath = findTypeDefinitionFile(nextTypeName, basePath);
      if (!filePath) {
        return null;
      }

      const extracted = extractTypeDefinitionWithTS(nextTypeName, filePath);
      if (!extracted) {
        return null;
      }

      nextTypeInfo = extracted.typeInfo;
      cache.set(nextTypeName, nextTypeInfo);
    }

    currentTypeInfo = nextTypeInfo;
    currentTypeName = nextTypeName;
  }

  return null;
}

/**
 * Get type information for a subtype at a specific path
 */
function getSubtypeInfo(
  baseTypeName: string,
  propertyPath: string[],
  basePath: string,
  cache: Map<string, TypeInfo>
): { typeInfo: TypeInfo; fullPath: string; originalType: string } | null {
  let baseTypeInfo = cache.get(baseTypeName);

  if (!baseTypeInfo) {
    const filePath = findTypeDefinitionFile(baseTypeName, basePath);
    if (!filePath) {
      return null;
    }

    const extracted = extractTypeDefinitionWithTS(baseTypeName, filePath);
    if (!extracted) {
      return null;
    }

    baseTypeInfo = extracted.typeInfo;
    cache.set(baseTypeName, baseTypeInfo);
  }

  if (propertyPath.length === 0) {
    return {
      typeInfo: baseTypeInfo,
      fullPath: baseTypeName,
      originalType: baseTypeName,
    };
  }

  const result = navigateToSubtype(baseTypeInfo, propertyPath, basePath, cache);
  if (!result) {
    return null;
  }

  const targetTypeName = result.typeName;
  let targetTypeInfo = cache.get(targetTypeName);

  if (!targetTypeInfo) {
    const filePath = findTypeDefinitionFile(targetTypeName, basePath);
    if (filePath) {
      const extracted = extractTypeDefinitionWithTS(targetTypeName, filePath);
      if (extracted) {
        targetTypeInfo = extracted.typeInfo;
        cache.set(targetTypeName, targetTypeInfo);
      }
    }
  }

  if (!targetTypeInfo) {
    const lastProp = propertyPath[propertyPath.length - 1];
    if (!lastProp) {
      return null;
    }

    const property = result.typeInfo.properties.find(p => p.name === lastProp);
    if (property) {
      targetTypeInfo = {
        name: `${result.propertyPath}`,
        properties: [{
          name: lastProp,
          type: property.type,
          optional: property.optional,
          description: property.description || undefined,
        }],
        description: `Property type: ${property.type}`,
      };
    } else {
      return null;
    }
  }

  return {
    typeInfo: targetTypeInfo,
    fullPath: result.propertyPath,
    originalType: targetTypeName,
  };
}

// ============================================================================
// End Type Definition Helper Functions
// ============================================================================

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
      resourceType: '',
      methodName: 'sandbox-script',
      description: entry.description,
      searchTokens,
      action: 'script',
      scope: 'script',
      apiClass: 'CachedScript',
      filePath: entry.name, // Use name as path since cache is remote
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
          stemmerSkipProperties: ['methodName', 'resourceType', 'apiClass', 'id'],
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
      ].join(' ');

      const doc: OramaDocument = {
        id: `${method.apiClass}.${method.methodName}`,
        documentType: 'kubernetes',
        resourceType: method.resourceType,
        methodName: method.methodName,
        description: method.description,
        searchTokens,
        action: extractAction(method.methodName),
        scope: extractScope(method.methodName),
        apiClass: method.apiClass,
        filePath: '',
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

    this.oramaDb = db;
    logger.info(`Orama: Indexed ${methods.length} API methods, ${scriptCount} cached scripts, ${prometheusCount} prometheus methods, ${lokiCount} loki methods, and ${analyticsCount} analytics functions`);
    return db;
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
      // Include 'prometheus' so searching with documentType finds all methods
      const searchTokens = [
        'prometheus',
        method.methodName,
        method.className || '',
        method.library,
        method.category,
        method.description,
      ].join(' ');

      const doc: OramaDocument = {
        id: `prometheus:${method.library}:${method.className || 'fn'}:${method.methodName}`,
        documentType: 'prometheus',
        resourceType: method.category,
        methodName: method.methodName,
        description: method.description,
        searchTokens,
        action: method.category,      // Use category as action for unified filtering
        scope: 'library',
        apiClass: method.library,     // Use library as apiClass for unified filtering
        filePath: '',
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
      // Build searchTokens from identifiers for better matching
      // Include 'loki' so searching with documentType finds all methods
      // Split camelCase method names for partial matching (e.g., "queryRange" -> "query Range")
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
        resourceType: method.category, // Use category as resourceType for search
        methodName: method.methodName,
        description: method.description,
        searchTokens,
        action: method.category,      // Use category as action for unified filtering
        scope: 'library',
        apiClass: method.library,     // Use library as apiClass for unified filtering
        filePath: '',
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
      // Build searchTokens from identifiers for better matching
      // Include 'analytics' so searching with documentType finds all methods
      const searchTokens = [
        'analytics',
        func.functionName,
        func.library,
        func.category,
        func.description,
      ].join(' ');

      const doc: OramaDocument = {
        id: `analytics:${func.library}:${func.functionName}`,
        documentType: 'analytics',
        resourceType: func.category, // Use category as resourceType for search
        methodName: func.functionName,
        description: func.description,
        searchTokens,
        action: func.category,        // Use category as action for unified filtering
        scope: 'library',
        apiClass: func.library,       // Use library as apiClass for unified filtering
        filePath: '',
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
        resourceType: '',
        methodName: name,
        description,
        searchTokens: `${name.replace(/_/g, ' ')} ${metricType} ${description}`,
        action: 'metric',
        scope: 'prometheus',
        apiClass: 'prometheus-metric',
        filePath: '',
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
        properties: ['methodName'],
        limit: 10000,
      });

      const existingMetrics = new Map<string, string>();
      for (const hit of existingResults.hits) {
        if (hit.document.documentType === 'prometheus-metric') {
          existingMetrics.set(hit.document.methodName, hit.document.id);
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
            resourceType: '',
            methodName: name,
            description,
            searchTokens: `${name.replace(/_/g, ' ')} ${metricType} ${description}`,
            action: 'metric',
            scope: 'prometheus',
            apiClass: 'prometheus-metric',
            filePath: '',
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
   * Unified search using Orama - works for all document types
   */
  async searchWithOrama(options: {
    query: string;
    documentType?: 'kubernetes' | 'prometheus' | 'prometheus-metric' | 'loki' | 'analytics' | 'script' | 'all';
    action?: string;
    library?: string;
    scope?: 'namespaced' | 'cluster' | 'all';
    exclude?: { actions?: string[]; libraries?: string[] };
    limit: number;
    offset: number;
  }): Promise<{
    results: OramaDocument[];
    scriptResults: OramaDocument[];
    totalMatches: number;
    facets: {
      documentType: Record<string, number>;
      apiClass: Record<string, number>;
      action: Record<string, number>;
      scope: Record<string, number>;
    };
    searchTime: number;
  }> {
    const { query, documentType = 'all', action, library, scope = 'all', exclude, limit, offset } = options;
    const db = await this.getOramaDb();

    const searchParams: SearchParams<Orama<typeof oramaSchema>, OramaDocument> = {
      term: query,
      properties: ['resourceType', 'methodName', 'description', 'searchTokens'],
      boost: {
        resourceType: 3,
        searchTokens: 2.5,
        methodName: 2,
        description: 1,
      },
      tolerance: 1,
      limit: Math.max((offset + limit) * SEARCH_RESULTS_MULTIPLIER, MIN_SEARCH_RESULTS),
      facets: {
        documentType: {},
        apiClass: {},
        action: {},
        scope: {},
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

    // Apply action filter
    if (action) {
      const lowerAction = action.toLowerCase();
      nonScriptHits = nonScriptHits.filter(hit => hit.document.action === lowerAction);
    }

    // Apply library filter (using apiClass field)
    if (library) {
      nonScriptHits = nonScriptHits.filter(hit => hit.document.apiClass === library);
    }

    // Apply scope filter (only affects K8s methods)
    if (scope === 'namespaced') {
      nonScriptHits = nonScriptHits.filter(hit =>
        hit.document.documentType !== 'kubernetes' || hit.document.scope === 'namespaced'
      );
    } else if (scope === 'cluster') {
      nonScriptHits = nonScriptHits.filter(hit =>
        hit.document.documentType !== 'kubernetes' ||
        hit.document.scope === 'cluster' || hit.document.scope === 'forAllNamespaces'
      );
    }

    // Apply exclusions
    if (exclude) {
      nonScriptHits = nonScriptHits.filter(hit => {
        const doc = hit.document;
        const hasActions = exclude.actions && exclude.actions.length > 0;
        const hasLibraries = exclude.libraries && exclude.libraries.length > 0;

        if (hasActions && hasLibraries) {
          const matchesAction = exclude.actions!.some(a =>
            doc.action === a.toLowerCase() || doc.methodName.toLowerCase().includes(a.toLowerCase())
          );
          const matchesLibrary = exclude.libraries!.includes(doc.apiClass);
          return !(matchesAction && matchesLibrary);
        } else if (hasActions) {
          const matchesAction = exclude.actions!.some(a =>
            doc.action === a.toLowerCase() || doc.methodName.toLowerCase().includes(a.toLowerCase())
          );
          return !matchesAction;
        } else if (hasLibraries) {
          return !exclude.libraries!.includes(doc.apiClass);
        }
        return true;
      });
    }

    // Extract facets
    const facets = {
      documentType: {} as Record<string, number>,
      apiClass: {} as Record<string, number>,
      action: {} as Record<string, number>,
      scope: {} as Record<string, number>,
    };

    if (searchResult.facets) {
      if (searchResult.facets.documentType?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.documentType.values)) {
          facets.documentType[key] = value as number;
        }
      }
      if (searchResult.facets.apiClass?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.apiClass.values)) {
          if (key !== 'CachedScript') {
            facets.apiClass[key] = value as number;
          }
        }
      }
      if (searchResult.facets.action?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.action.values)) {
          if (key !== 'script') {
            facets.action[key] = value as number;
          }
        }
      }
      if (searchResult.facets.scope?.values) {
        for (const [key, value] of Object.entries(searchResult.facets.scope.values)) {
          if (key !== 'script') {
            facets.scope[key] = value as number;
          }
        }
      }
    }

    // Sort by relevance, prioritizing exact matches
    const sortedNonScriptHits = nonScriptHits.sort((a, b) => {
      const aExact = a.document.resourceType.toLowerCase() === query.toLowerCase() ||
                     a.document.methodName.toLowerCase() === query.toLowerCase();
      const bExact = b.document.resourceType.toLowerCase() === query.toLowerCase() ||
                     b.document.methodName.toLowerCase() === query.toLowerCase();

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
 * Orama schema for Kubernetes API methods and Prometheus library methods
 *
 * Design decisions based on Orama best practices:
 * - `string` types for full-text searchable fields (resourceType, methodName, description)
 * - `enum` types for exact-match filterable fields (action, scope, apiClass)
 * - stemmerSkipProperties for code identifiers that shouldn't be stemmed
 * - Boosting configured at search time for relevance tuning
 */
const oramaSchema = {
  // Document type discriminator
  documentType: 'enum',          // "kubernetes" | "script" | "prometheus" | "prometheus-metric" | "loki" | "analytics"

  // Full-text searchable fields
  resourceType: 'string',        // "Pod", "Deployment" - boosted 3x
  methodName: 'string',          // "listNamespacedPod" or script filename - boosted 2x
  description: 'string',         // Full description text - boosted 1x

  // Enhanced search field: CamelCase split for better matching
  // e.g., "PodExec" becomes "Pod Exec", "ServiceAccountToken" becomes "Service Account Token"
  searchTokens: 'string',

  // Filterable enum fields (exact match, used in where clause)
  action: 'enum',                // "list", "create", "read", "delete", "patch", "replace", "connect", "watch", "script", "prometheus"
  scope: 'enum',                 // "namespaced", "cluster", "forAllNamespaces", "script", "prometheus"
  apiClass: 'enum',              // "CoreV1Api", "AppsV1Api", "CachedScript", "prometheus-query"

  // Stored metadata
  id: 'string',                  // Unique identifier: apiClass.methodName or script:filename
  filePath: 'string',            // Full path for scripts (empty for methods)

  // Prometheus metric fields (for prometheus-metric documentType)
  metricType: 'enum',            // "gauge" | "counter" | "histogram" | "summary" | "unknown"
} as const;

type OramaDocument = {
  id: string;
  documentType: 'kubernetes' | 'script' | 'prometheus' | 'prometheus-metric' | 'loki' | 'analytics';
  resourceType: string;
  methodName: string;
  description: string;
  searchTokens: string;
  action: string;       // K8s action (list, create, etc.) OR library category (query, metadata, descriptive, etc.)
  scope: string;
  apiClass: string;     // K8s API class OR library name (unified for filtering)
  filePath: string;
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
    resourceType: script.resourceTypes.join(' '),
    // For auto-generated scripts, use first API class or 'sandbox-script' as display name
    methodName: isAutoGenerated
      ? (script.apiClasses.length > 0 ? script.apiClasses[0]!.toLowerCase() : 'sandbox-script')
      : script.filename.replace(/\.ts$/, ''),
    description: script.description,
    searchTokens,
    action: 'script',
    scope: 'script',
    apiClass: script.apiClasses.length > 0 ? script.apiClasses[0]! : 'CachedScript',
    filePath: script.filePath,
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
// Execute Functions for Each Mode
// ============================================================================

/**
 * Execute type definition lookup mode
 */
async function executeTypeMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<TypeModeResult> {
  const { types, depth = 1 } = input;

  if (!types || types.length === 0) {
    return {
      mode: 'types',
      summary: 'Error: types parameter is required when mode is "types"',
      types: {},
    };
  }

  const basePath = process.cwd();

  const results: Record<string, {
    name: string;
    definition: string;
    file: string;
    nestedTypes: string[];
  }> = {};

  const typesToProcess = new Set(types);
  const processedTypes = new Set<string>();
  let currentDepth = 0;

  while (typesToProcess.size > 0 && currentDepth < depth) {
    const currentBatch = Array.from(typesToProcess);
    typesToProcess.clear();

    for (const typePath of currentBatch) {
      if (processedTypes.has(typePath)) {
        continue;
      }

      processedTypes.add(typePath);

      const parsedPath = parseTypePath(typePath);
      if (!parsedPath) {
        results[typePath] = {
          name: typePath,
          definition: `// Invalid type path: ${typePath}`,
          file: 'error',
          nestedTypes: [],
        };
        continue;
      }

      const { baseType, path: propertyPath } = parsedPath;

      if (propertyPath.length > 0) {
        const cache = new Map<string, TypeInfo>();
        const subtypeInfo = getSubtypeInfo(baseType, propertyPath, basePath, cache);

        if (subtypeInfo) {
          const definition = formatTypeInfo(subtypeInfo.typeInfo);
          results[typePath] = {
            name: subtypeInfo.typeInfo.name,
            definition,
            file: findTypeDefinitionFile(subtypeInfo.originalType, basePath)?.replace(basePath, '.') || 'resolved',
            nestedTypes: [],
          };
        } else {
          results[typePath] = {
            name: typePath,
            definition: `// Could not resolve property path: ${typePath}`,
            file: 'not found',
            nestedTypes: [],
          };
        }
      } else {
        const filePath = findTypeDefinitionFile(baseType, basePath);

        if (filePath) {
          try {
            const extracted = extractTypeDefinitionWithTS(baseType, filePath);

            if (extracted) {
              const definition = formatTypeInfo(extracted.typeInfo);
              results[typePath] = {
                name: baseType,
                definition,
                file: filePath.replace(basePath, '.'),
                nestedTypes: extracted.nestedTypes,
              };

              if (currentDepth < depth - 1) {
                for (const nestedType of extracted.nestedTypes) {
                  if (!processedTypes.has(nestedType)) {
                    typesToProcess.add(nestedType);
                  }
                }
              }
            } else {
              results[typePath] = {
                name: baseType,
                definition: `// Type ${baseType} not found in file ${filePath}`,
                file: filePath.replace(basePath, '.'),
                nestedTypes: [],
              };
            }
          } catch (error) {
            results[typePath] = {
              name: baseType,
              definition: `// Error extracting type ${baseType}: ${error instanceof Error ? error.message : String(error)}`,
              file: filePath.replace(basePath, '.'),
              nestedTypes: [],
            };
          }
        } else {
          results[typePath] = {
            name: baseType,
            definition: `// Type ${baseType} not found in @kubernetes/client-node type definitions`,
            file: 'not found',
            nestedTypes: [],
          };
        }
      }
    }

    currentDepth++;
  }

  const foundCount = Object.values(results).filter(r => r.file !== 'not found').length;
  const totalTypes = Object.keys(results).length;

  let summary = `Fetched ${foundCount} type definition(s)`;
  if (totalTypes > types.length) {
    summary += ` (${types.length} requested, ${totalTypes - types.length} nested)\n\n`;
  } else {
    summary += `\n\n`;
  }

  for (const typeName of types) {
    const typeInfo = results[typeName];
    if (typeInfo && typeInfo.file !== 'not found') {
      summary += `${typeName}: ${typeInfo.nestedTypes.length} nested type(s)\n`;
    }
  }

  return {
    mode: 'types',
    summary,
    types: results,
  };
}

// ============================================================================
// Unified Search Mode Execution
// ============================================================================

/**
 * Execute unified search mode - searches all indexed documents with unified filters
 */
async function executeSearchMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<SearchModeResult> {
  const {
    query = '',
    documentType = 'all',
    action,
    library,
    scope = 'all',
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
    action,
    library,
    scope,
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
    }

    return {
      id: doc.id,
      documentType: doc.documentType,
      name: doc.methodName,
      description: doc.description,
      library: doc.apiClass,
      action: doc.action,
      parameters,
      returnType,
      example,
    };
  });

  // Map script results
  const relevantScripts: RelevantScript[] = searchResult.scriptResults.map(doc => ({
    filename: doc.id.replace(/^script:/, ''),
    description: doc.description,
    apiClasses: doc.apiClass !== 'CachedScript' ? [doc.apiClass] : [],
  }));

  const hasMore = offset + results.length < searchResult.totalMatches;

  // Build summary
  let summary = `SEARCH RESULTS`;
  if (query) summary += ` for "${query}"`;
  if (documentType !== 'all') summary += ` (type: ${documentType})`;
  if (action) summary += ` (action: ${action})`;
  if (library) summary += ` (library: ${library})`;
  if (scope !== 'all') summary += ` (scope: ${scope})`;
  summary += `\n\nFound ${searchResult.totalMatches} result(s) (search: ${searchResult.searchTime.toFixed(2)}ms)`;
  if (offset > 0 || hasMore) {
    summary += ` | Page ${Math.floor(offset / limit) + 1}, showing ${offset + 1}-${offset + results.length} of ${searchResult.totalMatches}`;
  }
  summary += `\n\n`;

  // Show relevant scripts first if any
  if (relevantScripts.length > 0) {
    summary += `═══════════════════════════════════════════════════════════════\n`;
    summary += `⚡ CACHED SCRIPTS AVAILABLE - USE THESE FIRST!\n`;
    summary += `═══════════════════════════════════════════════════════════════\n`;
    relevantScripts.forEach((script, i) => {
      summary += `${i + 1}. ${script.filename}\n`;
      summary += `   ${script.description}\n`;
      summary += `   ➤ runSandbox({ cached: "${script.filename}" })\n\n`;
    });
    summary += `═══════════════════════════════════════════════════════════════\n\n`;
  }

  // Show facets
  if (Object.keys(searchResult.facets.documentType).length > 0) {
    summary += `FACETS:\n`;
    summary += `   Types: ${Object.entries(searchResult.facets.documentType).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    if (Object.keys(searchResult.facets.apiClass).length > 0) {
      summary += `   Libraries: ${Object.entries(searchResult.facets.apiClass).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    }
    if (Object.keys(searchResult.facets.action).length > 0) {
      summary += `   Actions: ${Object.entries(searchResult.facets.action).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    }
    summary += `\n`;
  }

  // Show results
  summary += `RESULTS:\n\n`;
  results.forEach((result, i) => {
    summary += `${i + 1}. [${result.documentType}] ${result.library}.${result.name}\n`;
    summary += `   ${result.description}\n`;
    if (result.parameters && result.parameters.length > 0) {
      const params = result.parameters.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
      summary += `   Params: (${params})\n`;
    }
    if (result.returnType) {
      summary += `   Returns: ${result.returnType}\n`;
    }
    summary += `\n`;
  });

  if (results.length === 0) {
    summary += `No results found. Try:\n`;
    summary += `- Different query term\n`;
    summary += `- Omit filters to see more results\n`;
    summary += `- Use documentType filter to narrow by type (kubernetes, prometheus, loki, analytics)\n`;
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
    mode: 'search',
    summary,
    results,
    totalMatches: searchResult.totalMatches,
    relevantScripts,
    facets: {
      documentType: searchResult.facets.documentType,
      library: searchResult.facets.apiClass,
      action: searchResult.facets.action,
      scope: searchResult.facets.scope,
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
    'Unified search tool for discovering methods across all supported libraries. ' +
    'MODES: ' +
    '• search (default): Search all indexed methods - K8s API, Prometheus, Loki, Analytics. ' +
    'Mix and match libraries in sandbox scripts. ' +
    'Filters: query, documentType (kubernetes/prometheus/loki/analytics/script/all), action, library, scope, exclude. ' +
    'Example: { query: "Pod" } or { query: "query", documentType: "loki" } or { documentType: "kubernetes", action: "list" } ' +
    '• types: Get TypeScript type definitions with path navigation. ' +
    'Params: types (required), depth. ' +
    'Example: { mode: "types", types: ["V1Pod", "V1Deployment.spec.template.spec"] } ' +
    '• metrics: Discover Prometheus cluster metrics (requires PROMETHEUS_URL). ' +
    'Example: { mode: "metrics", query: "cpu" } ' +
    'LIBRARIES: ' +
    'K8s: CoreV1Api, AppsV1Api, BatchV1Api, NetworkingV1Api, etc. ' +
    'Prometheus: prometheus-query (query, metadata, alerts). ' +
    'Loki: @prodisco/loki-client (queryRange, labels, labelValues, series, ready). ' +
    'Analytics: simple-statistics, ml-regression, mathjs, fft-js. ' +
    'FILTERS: ' +
    'action: K8s actions (list, create, read, delete, patch) or library categories (query, labels, descriptive, regression). ' +
    'library: Filter by specific library/API class. ' +
    'scope: namespaced, cluster, all (K8s methods only). ' +
    'exclude: { actions: [...], libraries: [...] } ' +
    'Docs: https://github.com/harche/ProDisco/blob/main/docs/search-tools.md',
  schema: SearchToolsInputSchema,
  async execute(input) {
    const { mode = 'search' } = input;

    if (mode === 'types') {
      return executeTypeMode(input);
    } else {
      // Default: unified search mode - handles all document types including prometheus-metric
      return executeSearchMode(input);
    }
  },
};

