import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import * as ts from 'typescript';
import { readFileSync, existsSync, readdirSync, mkdirSync, symlinkSync, realpathSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../types.js';
import { PACKAGE_ROOT } from '../../util/paths.js';
import { create, insert, search, remove } from '@orama/orama';
import type { Orama, Results, SearchParams } from '@orama/orama';
import chokidar from 'chokidar';
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
  // Mode selection - determines which operation to perform
  mode: z
    .enum(['methods', 'types', 'scripts', 'prometheus'])
    .default('methods')
    .optional()
    .describe('Search mode: "methods" for K8s API, "types" for type defs, "scripts" for cached scripts, "prometheus" for metrics/analytics libraries'),

  // === Method mode parameters (mode: 'methods') ===
  resourceType: z
    .string()
    .optional()
    .describe('(methods mode) Kubernetes resource type (e.g., "Pod", "Deployment", "Service", "ConfigMap")'),
  action: z
    .string()
    .optional()
    .describe('(methods mode) API action: list, read, create, delete, patch, replace, connect, get, watch'),
  scope: z
    .enum(['namespaced', 'cluster', 'all'])
    .optional()
    .default('all')
    .describe('(methods mode) Resource scope: "namespaced", "cluster", or "all"'),
  exclude: z
    .object({
      actions: z
        .array(z.string())
        .optional()
        .describe('Actions to exclude (e.g., ["connect", "watch"])'),
      apiClasses: z
        .array(z.string())
        .optional()
        .describe('API classes to exclude (e.g., ["CustomObjectsApi"])'),
    })
    .optional()
    .describe('(methods mode) Exclusion criteria'),

  // === Type mode parameters (mode: 'types') ===
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

  // === Script mode parameters (mode: 'scripts') ===
  searchTerm: z
    .string()
    .optional()
    .describe('(scripts mode) Search term to find cached scripts (e.g., "pod", "logs"). If omitted, shows all scripts.'),

  // === Prometheus mode parameters (mode: 'prometheus') ===
  category: z
    .enum(['query', 'metadata', 'alerts', 'all'])
    .optional()
    .default('all')
    .describe('(prometheus mode) Filter by category: "query" (PromQL), "metadata" (labels/series), or "alerts"'),
  methodPattern: z
    .string()
    .optional()
    .describe('(prometheus mode) Search pattern for method names (e.g., "mean", "query", "percentile")'),

  // === Shared parameters ===
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

// Result type for methods mode
type MethodModeResult = {
  mode: 'methods';
  summary: string;
  tools: KubernetesApiMethod[];
  totalMatches: number;
  usage: string;
  paths: {
    scriptsDirectory: string;
  };
  cachedScripts: string[];
  relevantScripts: RelevantScript[];
  facets?: {
    apiClass: Record<string, number>;
    action: Record<string, number>;
    scope: Record<string, number>;
  };
  searchTime?: number;
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
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

// Relevant script for display
type RelevantScript = {
  filename: string;
  filePath: string;
  description: string;
  apiClasses: string[];
};

// Result type for scripts mode
type ScriptModeResult = {
  mode: 'scripts';
  summary: string;
  scripts: RelevantScript[];
  totalMatches: number;
  paths: {
    scriptsDirectory: string;
  };
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
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

// Result type for prometheus mode
type PrometheusModeResult = {
  mode: 'prometheus';
  summary: string;
  methods: PrometheusMethod[];
  totalMatches: number;
  libraries: {
    'prometheus-query': { installed: boolean; version: string };
  };
  usage: string;
  paths: {
    scriptsDirectory: string;
  };
  facets: {
    library: Record<string, number>;
    category: Record<string, number>;
  };
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
};

// Prometheus error result when PROMETHEUS_URL is not configured
type PrometheusErrorResult = {
  mode: 'prometheus';
  error: string;
  message: string;
  example: string;
  methods: PrometheusMethod[];
  totalMatches: number;
  libraries: {
    'prometheus-query': { installed: boolean; version: string };
  };
  paths: {
    scriptsDirectory: string;
  };
  facets: {
    library: Record<string, number>;
    category: Record<string, number>;
  };
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
};

// Union type for all modes
type SearchToolsResult = MethodModeResult | TypeModeResult | ScriptModeResult | PrometheusModeResult | PrometheusErrorResult;

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

  /** Filesystem watcher instance */
  private scriptWatcher: ReturnType<typeof chokidar.watch> | null = null;

  /** Whether the service has been initialized */
  private initialized = false;

  /**
   * Initialize the search index and start the script watcher.
   * This is called automatically on first use, but can be called explicitly
   * for pre-warming during server startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.initializeOramaDb();
    this.initialized = true;
  }

  /**
   * Shutdown the service, stopping the script watcher.
   * Call this during graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.scriptWatcher) {
      await this.scriptWatcher.close();
      this.scriptWatcher = null;
      logger.info('Orama: Stopped script watcher');
    }
    this.oramaDb = null;
    this.apiMethodsCache = null;
    this.indexedScriptPaths.clear();
    this.initialized = false;
    // Clear module-level caches
    clearPrometheusMethodsCache();
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
        documentType: 'method',
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

    // Start filesystem watcher for script changes
    this.startScriptWatcher(db);

    this.oramaDb = db;
    logger.info(`Orama: Indexed ${methods.length} API methods, ${scriptCount} cached scripts, and ${prometheusCount} prometheus methods`);
    return db;
  }

  /**
   * Index cached scripts into the Orama database.
   */
  private async indexCachedScripts(db: Orama<typeof oramaSchema>): Promise<number> {
    const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');
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
        method.methodName,
        method.className || '',
        method.library,
        method.category,
        method.description,
      ].join(' ');

      const doc: OramaDocument = {
        id: `prometheus:${method.library}:${method.className || 'fn'}:${method.methodName}`,
        documentType: 'prometheus',
        resourceType: method.category, // Use category as resourceType for search
        methodName: method.methodName,
        description: method.description,
        searchTokens,
        action: 'prometheus',
        scope: 'prometheus',
        apiClass: method.library,
        filePath: '',
        library: method.library,
        category: method.category,
      };

      await insert(db, doc);
      indexedCount++;
    }

    return indexedCount;
  }

  /**
   * Start filesystem watcher for cached scripts directory.
   */
  private startScriptWatcher(db: Orama<typeof oramaSchema>): void {
    const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');

    // Ensure directory exists before watching
    if (!existsSync(scriptsDirectory)) {
      try {
        mkdirSync(scriptsDirectory, { recursive: true });
      } catch {
        return;
      }
    }

    this.scriptWatcher = chokidar.watch(join(scriptsDirectory, '*.ts'), {
      persistent: true,
      ignoreInitial: true,
    });

    this.scriptWatcher.on('add', async (filePath: string) => {
      const script = parseScriptFile(filePath);
      if (script) {
        const doc = buildScriptDocument(script);
        await insert(db, doc);
        this.indexedScriptPaths.add(filePath);
        logger.debug(`Orama: Indexed new script ${basename(filePath)}`);
      }
    });

    this.scriptWatcher.on('unlink', async (filePath: string) => {
      const docId = `script:${basename(filePath)}`;
      try {
        await remove(db, docId);
        this.indexedScriptPaths.delete(filePath);
        logger.debug(`Orama: Removed script ${basename(filePath)} from index`);
      } catch (error) {
        logger.debug(`Could not remove script ${basename(filePath)} from index: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    this.scriptWatcher.on('change', async (filePath: string) => {
      const docId = `script:${basename(filePath)}`;
      try {
        await remove(db, docId);
      } catch (error) {
        logger.debug(`Script ${basename(filePath)} was not in index, will add: ${error instanceof Error ? error.message : String(error)}`);
      }
      const script = parseScriptFile(filePath);
      if (script) {
        const doc = buildScriptDocument(script);
        await insert(db, doc);
        logger.debug(`Orama: Re-indexed modified script ${basename(filePath)}`);
      }
    });

    logger.info(`Orama: Watching for script changes in ${scriptsDirectory}`);
  }

  /**
   * Search using Orama with advanced features
   */
  async searchWithOrama(
    resourceType: string,
    action: string | undefined,
    scope: string,
    exclude: { actions?: string[]; apiClasses?: string[] } | undefined,
    limit: number,
    offset: number = 0
  ): Promise<{
    methodResults: OramaDocument[];
    scriptResults: OramaDocument[];
    totalMethodCount: number;
    totalScriptCount: number;
    facets: {
      apiClass: Record<string, number>;
      action: Record<string, number>;
      scope: Record<string, number>;
    };
    searchTime: number;
  }> {
    const db = await this.getOramaDb();

    const searchParams: SearchParams<Orama<typeof oramaSchema>, OramaDocument> = {
      term: resourceType,
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
        apiClass: {},
        action: {},
        scope: {},
      },
    };

    const startTime = performance.now();
    const searchResult: Results<OramaDocument> = await search(db, searchParams);
    const searchTime = performance.now() - startTime;

    // Separate results by documentType FIRST
    const allScriptHits = searchResult.hits.filter(hit => hit.document.documentType === 'script');
    let methodHits = searchResult.hits.filter(hit => hit.document.documentType === 'method');

    // Apply method-specific filters to methods only
    if (action) {
      const lowerAction = action.toLowerCase();
      methodHits = methodHits.filter(hit => hit.document.action === lowerAction);
    }

    if (scope === 'namespaced') {
      methodHits = methodHits.filter(hit => hit.document.scope === 'namespaced');
    } else if (scope === 'cluster') {
      methodHits = methodHits.filter(hit =>
        hit.document.scope === 'cluster' || hit.document.scope === 'forAllNamespaces'
      );
    }

    // Apply exclusions to methods only
    if (exclude) {
      methodHits = methodHits.filter(hit => {
        const doc = hit.document;
        const hasActions = exclude.actions && exclude.actions.length > 0;
        const hasApiClasses = exclude.apiClasses && exclude.apiClasses.length > 0;

        if (hasActions && hasApiClasses) {
          const matchesAction = exclude.actions!.some(a =>
            doc.action === a.toLowerCase() || doc.methodName.toLowerCase().includes(a.toLowerCase())
          );
          const matchesApiClass = exclude.apiClasses!.includes(doc.apiClass);
          return !(matchesAction && matchesApiClass);
        } else if (hasActions) {
          const matchesAction = exclude.actions!.some(a =>
            doc.action === a.toLowerCase() || doc.methodName.toLowerCase().includes(a.toLowerCase())
          );
          return !matchesAction;
        } else if (hasApiClasses) {
          return !exclude.apiClasses!.includes(doc.apiClass);
        }
        return true;
      });
    }

    // Extract facets (filter out script-related values)
    const facets = {
      apiClass: {} as Record<string, number>,
      action: {} as Record<string, number>,
      scope: {} as Record<string, number>,
    };

    if (searchResult.facets) {
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

    // Sort methods to prioritize exact resourceType matches
    const sortedMethodHits = methodHits.sort((a, b) => {
      const aExact = a.document.resourceType.toLowerCase() === resourceType.toLowerCase();
      const bExact = b.document.resourceType.toLowerCase() === resourceType.toLowerCase();

      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      return (b.score || 0) - (a.score || 0);
    });

    // Sort scripts by relevance score
    const sortedScriptHits = allScriptHits.sort((a, b) => (b.score || 0) - (a.score || 0));

    const totalMethodCount = sortedMethodHits.length;
    const totalScriptCount = sortedScriptHits.length;

    return {
      methodResults: sortedMethodHits.slice(offset, offset + limit).map(hit => hit.document),
      scriptResults: sortedScriptHits.slice(0, MAX_RELEVANT_SCRIPTS).map(hit => hit.document),
      totalMethodCount,
      totalScriptCount,
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
  documentType: 'enum',          // "method" | "script" | "prometheus"

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

  // Prometheus-specific fields
  library: 'enum',               // "prometheus-query" (empty for non-prometheus)
  category: 'enum',              // "query" | "metadata" | "alerts" (empty for non-prometheus)
} as const;

type OramaDocument = {
  id: string;
  documentType: 'method' | 'script' | 'prometheus';
  resourceType: string;
  methodName: string;
  description: string;
  searchTokens: string;
  action: string;
  scope: string;
  apiClass: string;
  filePath: string;
  library?: string;
  category?: string;
};

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

  return `import { PrometheusDriver } from 'prometheus-query';

const prom = new PrometheusDriver({ endpoint: process.env.PROMETHEUS_URL || 'http://prometheus:9090' });
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
 * Extract likely resource types from a script filename.
 * Examples:
 *   "get-pod-logs.ts" -> ["pod", "log", "logs"]
 *   "list-nodes.ts" -> ["node", "nodes"]
 */
function extractResourceTypesFromFilename(filename: string): string[] {
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
  // Build search tokens from filename, description, and API signals
  const searchTokens = [
    script.filename.replace(/\.ts$/, '').replace(/[-_]/g, ' '),
    ...script.resourceTypes,
    script.description,
    ...script.apiClasses,
    ...script.keywords,
  ].join(' ');

  return {
    id: `script:${script.filename}`,
    documentType: 'script',
    resourceType: script.resourceTypes.join(' '),
    methodName: script.filename.replace(/\.ts$/, ''),
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
  
  // Start with import and async function wrapper to avoid top-level await issues
  let example = `import * as k8s from '@kubernetes/client-node';\n\nasync function main() {\n  // Initialize the Kubernetes client\n  const kc = new k8s.KubeConfig();\n  kc.loadFromDefault();\n  const ${apiVar} = kc.makeApiClient(k8s.${apiClass});\n\n`;
  
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
  
  example += `  // IMPORTANT: Always pass object parameter (even if empty {})\n  const response = await ${apiVar}.${methodName}(${paramStr});\n\n`;
  
  if (methodName.startsWith('list')) {
    example += `  // Response structure: response.items is an array\n  const items = response.items;\n  console.log(\`Found \${items.length} resources\`);\n  // Access: items[0].metadata.name`;
  } else if (methodName.startsWith('read') || methodName.startsWith('get')) {
    example += `  // Response IS the resource object\n  console.log(\`Resource: \${response.metadata?.name}\`);\n  // Access: response.spec, response.status, etc.`;
  } else if (methodName.startsWith('create')) {
    example += `  // Response IS the created resource\n  console.log(\`Created: \${response.metadata?.name}\`);`;
  } else if (methodName.startsWith('delete')) {
    example += `  // Response IS the status object\n  console.log(\`Status: \${response.status}\`);`;
  } else {
    example += `  // Response contains the result directly\n  console.log(response);`;
  }
  
  // Close the function and add the call
  example += `\n}\n\n// Execute the function\nmain();`;
  
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

/**
 * Execute method search mode
 */
async function executeMethodMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<MethodModeResult> {
  const { resourceType, action, scope = 'all', exclude, limit = 10, offset = 0 } = input;

  if (!resourceType) {
    return {
      mode: 'methods',
      summary: 'Error: resourceType parameter is required when mode is "methods"',
      tools: [],
      totalMatches: 0,
      usage: '',
      paths: { scriptsDirectory: '' },
      cachedScripts: [],
      relevantScripts: [],
      pagination: { offset: 0, limit: 10, hasMore: false },
    };
  }

  const {
    methodResults: oramaResults,
    scriptResults,
    totalMethodCount,
    facets,
    searchTime
  } = await searchToolsService.searchWithOrama(
    resourceType,
    action,
    scope,
    exclude,
    limit,
    offset
  );

  const allMethods = searchToolsService.getApiMethods();
  const methodMap = new Map(allMethods.map(m => [`${m.apiClass}.${m.methodName}`, m]));

  const results: KubernetesApiMethod[] = oramaResults
    .map(doc => methodMap.get(doc.id))
    .filter((m): m is KubernetesApiMethod => m !== undefined);

  const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');
  initializeScriptsDirectory(scriptsDirectory);

  let cachedScripts: string[] = [];
  try {
    if (existsSync(scriptsDirectory)) {
      cachedScripts = readdirSync(scriptsDirectory)
        .filter(f => f.endsWith('.ts'))
        .sort();
    }
  } catch {
    // Ignore errors
  }

  // Build relevant scripts array from search results
  const relevantScripts: RelevantScript[] = scriptResults.map(doc => ({
    filename: doc.methodName + '.ts',
    filePath: doc.filePath,
    description: doc.description,
    apiClasses: doc.apiClass !== 'CachedScript' ? [doc.apiClass] : [],
  }));

  const hasMore = offset + results.length < totalMethodCount;

  let summary = `Found ${results.length} method(s) for resource "${resourceType}"`;
  if (action) summary += `, action "${action}"`;
  if (scope !== 'all') summary += `, scope "${scope}"`;
  if (exclude) {
    if (exclude.actions && exclude.actions.length > 0) {
      summary += `, excluding actions: [${exclude.actions.join(', ')}]`;
    }
    if (exclude.apiClasses && exclude.apiClasses.length > 0) {
      summary += `, excluding API classes: [${exclude.apiClasses.join(', ')}]`;
    }
  }
  summary += ` (search: ${searchTime.toFixed(2)}ms)`;

  if (offset > 0 || hasMore) {
    summary += ` | Page: ${Math.floor(offset / limit) + 1}, showing ${offset + 1}-${offset + results.length} of ${totalMethodCount}`;
  }
  summary += `\n\n`;

  // ========== RELEVANT CACHED SCRIPTS (shown FIRST) ==========
  if (relevantScripts.length > 0) {
    summary += `RELEVANT CACHED SCRIPTS (${relevantScripts.length} matching "${resourceType}"):\n`;
    relevantScripts.forEach((script, i) => {
      summary += `   ${i + 1}. ${script.filename}\n`;
      summary += `      ${script.description}\n`;
      if (script.apiClasses.length > 0) {
        summary += `      APIs: ${script.apiClasses.join(', ')}\n`;
      }
      summary += `      Path: ${script.filePath}\n`;
      summary += `      Run: npx tsx ${script.filePath}\n\n`;
    });
  }

  // ========== FACETS ==========
  if (Object.keys(facets.apiClass).length > 0) {
    summary += `FACETS (refine your search):\n`;
    summary += `   API Classes: ${Object.entries(facets.apiClass).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    summary += `   Actions: ${Object.entries(facets.action).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    summary += `   Scopes: ${Object.entries(facets.scope).map(([k, v]) => `${k}(${v})`).join(', ')}\n\n`;
  }

  // ========== API METHODS ==========
  summary += `API METHODS:\n\n`;

  results.forEach((method, i) => {
    summary += `${i + 1}. ${method.apiClass}.${method.methodName}\n`;

    if (method.inputSchema.required.length > 0) {
      const params = method.inputSchema.required.map(r =>
        `${r}: "${method.inputSchema.properties[r]?.type || 'string'}"`
      ).join(', ');
      summary += `   method_args: { ${params} }\n`;
    } else {
      summary += `   method_args: {} (empty object - required)\n`;
    }

    const isList = method.methodName.startsWith('list');
    if (isList) {
      summary += `   return_values: response.items (array of ${method.resourceType})\n`;
    } else {
      summary += `   return_values: response (${method.resourceType} object)\n`;
    }

    summary += `\n`;
  });

  if (results.length === 0) {
    summary += `No methods found. Try:\n`;
    summary += `- Different resourceType (e.g., "Pod", "Deployment", "Service")\n`;
    summary += `- Omit action to see all available methods\n`;
    summary += `- Use scope: "all" to see both namespaced and cluster methods\n`;
  }

  summary += `Write scripts to: ${scriptsDirectory}/<name>.ts\n`;
  summary += `Run with: npx tsx ${scriptsDirectory}/<name>.ts\n`;
  summary += `For type definitions: use mode: "types" with types: ["V1Pod"]\n\n`;

  const usage =
    'USAGE:\n' +
    '- All methods require object parameter: await api.method({ param: value })\n' +
    '- List operations return: response.items (array)\n' +
    '- Single resource operations return: response (object)\n' +
    `- Write scripts to: ${scriptsDirectory}/<yourscript>.ts\n` +
    `- Import: import * as k8s from '@kubernetes/client-node';\n` +
    `- Run: npx tsx ${scriptsDirectory}/<yourscript>.ts`;

  return {
    mode: 'methods',
    summary,
    tools: results,
    totalMatches: totalMethodCount,
    usage,
    paths: {
      scriptsDirectory,
    },
    cachedScripts,
    relevantScripts,
    facets,
    searchTime,
    pagination: {
      offset,
      limit,
      hasMore,
    },
  };
}

/**
 * Execute script search mode
 */
async function executeScriptMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<ScriptModeResult> {
  const { searchTerm, limit = 10, offset = 0 } = input;

  const db = await searchToolsService.getOramaDb();

  const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');
  initializeScriptsDirectory(scriptsDirectory);

  let scripts: RelevantScript[] = [];
  let totalMatches = 0;

  if (searchTerm) {
    // Search for scripts matching the term
    const searchParams: SearchParams<Orama<typeof oramaSchema>, OramaDocument> = {
      term: searchTerm,
      properties: ['resourceType', 'methodName', 'description', 'searchTokens'],
      boost: {
        resourceType: 3,
        searchTokens: 2.5,
        methodName: 2,
        description: 1,
      },
      tolerance: 1,
      limit: 100, // Get all matches for filtering
    };

    const searchResult: Results<OramaDocument> = await search(db, searchParams);

    // Filter to only scripts
    const scriptHits = searchResult.hits
      .filter(hit => hit.document.documentType === 'script')
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    totalMatches = scriptHits.length;

    // Filter out scripts that no longer exist on disk, and clean up stale index entries
    const validScriptHits: typeof scriptHits = [];
    for (const hit of scriptHits) {
      if (existsSync(hit.document.filePath)) {
        validScriptHits.push(hit);
      } else {
        // Clean up stale index entry
        try {
          await remove(db, hit.document.id);
          logger.debug(`Orama: Removed stale script ${hit.document.methodName} from index`);
        } catch {
          // Ignore removal errors
        }
      }
    }
    totalMatches = validScriptHits.length;

    scripts = validScriptHits
      .slice(offset, offset + limit)
      .map(hit => ({
        filename: hit.document.methodName + '.ts',
        filePath: hit.document.filePath,
        description: hit.document.description,
        apiClasses: hit.document.apiClass !== 'CachedScript' ? [hit.document.apiClass] : [],
      }));
  } else {
    // List all scripts
    try {
      if (existsSync(scriptsDirectory)) {
        const allScripts = readdirSync(scriptsDirectory)
          .filter(f => f.endsWith('.ts'))
          .sort();

        totalMatches = allScripts.length;

        scripts = allScripts
          .slice(offset, offset + limit)
          .map(filename => {
            const filePath = join(scriptsDirectory, filename);
            const parsed = parseScriptFile(filePath);
            return {
              filename,
              filePath,
              description: parsed?.description || `Script: ${filename.replace(/\.ts$/, '')}`,
              apiClasses: parsed?.apiClasses || [],
            };
          });
      }
    } catch {
      // Ignore errors
    }
  }

  const hasMore = offset + scripts.length < totalMatches;

  let summary = searchTerm
    ? `CACHED SCRIPTS (${totalMatches} matching "${searchTerm}")`
    : `CACHED SCRIPTS (${totalMatches} total)`;

  if (offset > 0 || hasMore) {
    summary += ` | Page ${Math.floor(offset / limit) + 1}, showing ${offset + 1}-${offset + scripts.length} of ${totalMatches}`;
  }
  summary += `\n\n`;

  if (scripts.length > 0) {
    scripts.forEach((script, i) => {
      summary += `${i + 1}. ${script.filename}\n`;
      summary += `   ${script.description}\n`;
      if (script.apiClasses.length > 0) {
        summary += `   APIs: ${script.apiClasses.join(', ')}\n`;
      }
      summary += `   Path: ${script.filePath}\n`;
      summary += `   Run: npx tsx ${script.filePath}\n\n`;
    });
  } else {
    summary += `No scripts found.`;
    if (searchTerm) {
      summary += ` Try a different search term or omit searchTerm to list all scripts.\n`;
    } else {
      summary += ` Scripts directory: ${scriptsDirectory}\n`;
    }
  }

  summary += `\nScripts directory: ${scriptsDirectory}\n`;

  return {
    mode: 'scripts',
    summary,
    scripts,
    totalMatches,
    paths: {
      scriptsDirectory,
    },
    pagination: {
      offset,
      limit,
      hasMore,
    },
  };
}

/**
 * Execute prometheus mode - search for prometheus-query library methods
 */
async function executePrometheusMode(input: z.infer<typeof SearchToolsInputSchema>): Promise<PrometheusModeResult | PrometheusErrorResult> {
  const { category = 'all', methodPattern, limit = 10, offset = 0 } = input;

  const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');
  initializeScriptsDirectory(scriptsDirectory);

  // Get all prometheus methods
  let methods = getPrometheusMethods();

  // Filter by category
  if (category !== 'all') {
    methods = methods.filter(m => m.category === category);
  }

  // Filter by method pattern
  if (methodPattern) {
    const pattern = methodPattern.toLowerCase();
    methods = methods.filter(m =>
      m.methodName.toLowerCase().includes(pattern) ||
      m.description.toLowerCase().includes(pattern)
    );
  }

  const totalMatches = methods.length;

  // Apply pagination
  const paginatedMethods = methods.slice(offset, offset + limit);
  const hasMore = offset + paginatedMethods.length < totalMatches;

  // Build facets
  const facets = {
    library: {} as Record<string, number>,
    category: {} as Record<string, number>,
  };

  for (const m of methods) {
    facets.library[m.library] = (facets.library[m.library] || 0) + 1;
    facets.category[m.category] = (facets.category[m.category] || 0) + 1;
  }

  // Library info
  const libraries = {
    'prometheus-query': { installed: true, version: '^3.3.2' },
  };

  // Check if PROMETHEUS_URL is configured
  const prometheusUrl = process.env.PROMETHEUS_URL;

  // Build summary
  let summary = `PROMETHEUS METHODS`;
  if (category !== 'all') summary += ` (category: ${category})`;
  if (methodPattern) summary += ` (pattern: "${methodPattern}")`;
  summary += `\n\nFound ${totalMatches} method(s)`;
  if (offset > 0 || hasMore) {
    summary += ` | Page ${Math.floor(offset / limit) + 1}, showing ${offset + 1}-${offset + paginatedMethods.length} of ${totalMatches}`;
  }
  summary += `\n\n`;

  // Show PROMETHEUS_URL status
  if (!prometheusUrl) {
    summary += `⚠️  PROMETHEUS_URL not configured - prometheus-query methods require this environment variable\n`;
    summary += `   Set via: PROMETHEUS_URL="http://prometheus:9090"\n\n`;
  } else {
    summary += `✓ PROMETHEUS_URL: ${prometheusUrl}\n\n`;
  }

  // Show facets
  if (Object.keys(facets.category).length > 0) {
    summary += `FACETS:\n`;
    summary += `   Categories: ${Object.entries(facets.category).map(([k, v]) => `${k}(${v})`).join(', ')}\n\n`;
  }

  // Show methods
  summary += `METHODS:\n\n`;
  paginatedMethods.forEach((method, i) => {
    const className = method.className ? `${method.className}.` : '';
    summary += `${i + 1}. ${method.library}: ${className}${method.methodName}\n`;
    summary += `   Category: ${method.category}\n`;
    summary += `   ${method.description}\n`;
    if (method.parameters.length > 0) {
      const params = method.parameters.map(p =>
        `${p.name}${p.optional ? '?' : ''}: ${p.type}`
      ).join(', ');
      summary += `   Params: (${params})\n`;
    }
    summary += `   Returns: ${method.returnType}\n\n`;
  });

  if (paginatedMethods.length === 0) {
    summary += `No methods found. Try:\n`;
    summary += `- Different category filter\n`;
    summary += `- Different methodPattern\n`;
  }

  summary += `\nWrite scripts to: ${scriptsDirectory}/<name>.ts\n`;
  summary += `Run with: npx tsx ${scriptsDirectory}/<name>.ts\n`;

  const usage =
    'USAGE:\n' +
    '- import { PrometheusDriver } from \'prometheus-query\';\n' +
    `- Write scripts to: ${scriptsDirectory}/<yourscript>.ts\n` +
    `- Run: npx tsx ${scriptsDirectory}/<yourscript>.ts`;

  // If PROMETHEUS_URL is not set, return error result
  if (!prometheusUrl) {
    return {
      mode: 'prometheus',
      error: 'PROMETHEUS_URL_NOT_CONFIGURED',
      message: 'The PROMETHEUS_URL environment variable is not set. prometheus-query methods require this to connect to a Prometheus server.',
      example: 'PROMETHEUS_URL="http://prometheus:9090" npx tsx script.ts',
      methods: paginatedMethods,
      totalMatches,
      libraries,
      paths: { scriptsDirectory },
      facets,
      pagination: { offset, limit, hasMore },
    };
  }

  return {
    mode: 'prometheus',
    summary,
    methods: paginatedMethods,
    totalMatches,
    libraries,
    usage,
    paths: { scriptsDirectory },
    facets,
    pagination: { offset, limit, hasMore },
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
    'Find Kubernetes API methods, get type definitions, or search cached scripts. ' +
    'MODES: ' +
    '• methods (default): Search for API methods by resource type. Also shows relevant cached scripts first. ' +
    'Params: resourceType (required), action, scope, exclude, limit, offset. ' +
    'Example: { resourceType: "Pod", action: "list" } ' +
    '• types: Get TypeScript type definitions with path navigation. ' +
    'Params: types (required), depth. ' +
    'Example: { mode: "types", types: ["V1Pod", "V1Deployment.spec.template.spec"] } ' +
    '• scripts: Search or list cached scripts. ' +
    'Params: searchTerm (optional), limit, offset. ' +
    'Example: { mode: "scripts", searchTerm: "pod" } ' +
    '• prometheus: Search Prometheus API methods (prometheus-query). ' +
    'Params: category (optional), methodPattern (optional), limit, offset. ' +
    'Example: { mode: "prometheus", category: "query" } ' +
    'Actions: list, read, create, delete, patch, replace, connect, get, watch. ' +
    'Scopes: namespaced, cluster, all. ' +
    'Docs: https://github.com/harche/ProDisco/blob/main/docs/search-tools.md',
  schema: SearchToolsInputSchema,
  async execute(input) {
    const { mode = 'methods' } = input;

    if (mode === 'types') {
      return executeTypeMode(input);
    } else if (mode === 'scripts') {
      return executeScriptMode(input);
    } else if (mode === 'prometheus') {
      return executePrometheusMode(input);
    } else {
      return executeMethodMode(input);
    }
  },
};

