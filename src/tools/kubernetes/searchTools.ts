import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import * as ts from 'typescript';
import { readFileSync, existsSync, readdirSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../types.js';
import { PACKAGE_ROOT } from '../../util/paths.js';
import { create, insert, search } from '@orama/orama';
import type { Orama, Results, SearchParams } from '@orama/orama';

const SearchToolsInputSchema = z.object({
  // Mode selection - determines which operation to perform
  mode: z
    .enum(['methods', 'types'])
    .default('methods')
    .optional()
    .describe('Search mode: "methods" to find API methods (default), "types" to get type definitions'),

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

// Union type for both modes
type SearchToolsResult = MethodModeResult | TypeModeResult;

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
function getJSDocDescription(node: ts.Node, _sourceFile: ts.SourceFile): string | undefined {
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
 * Extract nested type references from a type string
 */
function extractNestedTypeRefs(typeStr: string): string[] {
  const refs: string[] = [];
  const typeRefRegex = /\b([VK]\d+[A-Z][a-zA-Z0-9]*|Core[A-Z][a-zA-Z0-9]*)\b/g;
  let match;

  while ((match = typeRefRegex.exec(typeStr)) !== null) {
    const ref = match[1];
    if (ref && !refs.includes(ref)) {
      refs.push(ref);
    }
  }

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
      const description = getJSDocDescription(node, sourceFile);

      node.members?.forEach((member) => {
        if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
          if (member.name) {
            const propName = member.name.getText(sourceFile);
            const propType = member.type?.getText(sourceFile) || 'any';
            const isOptional = !!member.questionToken;
            const propDescription = getJSDocDescription(member, sourceFile);

            properties.push({
              name: propName.replace(/['"]/g, ''),
              type: propType,
              optional: isOptional,
              description: propDescription,
            });

            const typeRefs = extractNestedTypeRefs(propType);
            typeRefs.forEach(ref => {
              if (ref !== typeName) {
                nestedTypes.add(ref);
              }
            });
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
function formatTypeInfo(typeInfo: TypeInfo, maxProperties: number = 20): string {
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

// Cache for Kubernetes API methods
let apiMethodsCache: KubernetesApiMethod[] | null = null;

// ============================================================================
// Orama Search Engine Configuration
// ============================================================================

/**
 * Orama schema for Kubernetes API methods
 *
 * Design decisions based on Orama best practices:
 * - `string` types for full-text searchable fields (resourceType, methodName, description)
 * - `enum` types for exact-match filterable fields (action, scope, apiClass)
 * - stemmerSkipProperties for code identifiers that shouldn't be stemmed
 * - Boosting configured at search time for relevance tuning
 */
const oramaSchema = {
  // Full-text searchable fields
  resourceType: 'string',        // "Pod", "Deployment" - boosted 3x
  methodName: 'string',          // "listNamespacedPod" - boosted 2x
  description: 'string',         // Full description text - boosted 1x

  // Enhanced search field: CamelCase split for better matching
  // e.g., "PodExec" becomes "Pod Exec", "ServiceAccountToken" becomes "Service Account Token"
  searchTokens: 'string',

  // Filterable enum fields (exact match, used in where clause)
  action: 'enum',                // "list", "create", "read", "delete", "patch", "replace", "connect", "watch"
  scope: 'enum',                 // "namespaced", "cluster", "forAllNamespaces"
  apiClass: 'enum',              // "CoreV1Api", "AppsV1Api", etc.

  // Stored metadata (for display, not heavily searched)
  id: 'string',                  // Unique identifier: apiClass.methodName
} as const;

type OramaK8sDocument = {
  id: string;
  resourceType: string;
  methodName: string;
  description: string;
  searchTokens: string;
  action: string;
  scope: string;
  apiClass: string;
};

/**
 * Split CamelCase into searchable tokens
 * e.g., "PodExec" -> "Pod Exec", "ServiceAccountToken" -> "Service Account Token"
 */
function splitCamelCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// Orama database instance cache
let oramaDb: Orama<typeof oramaSchema> | null = null;

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

/**
 * Initialize and populate the Orama search database
 */
async function initializeOramaDb(): Promise<Orama<typeof oramaSchema>> {
  if (oramaDb) {
    return oramaDb;
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
  const methods = extractKubernetesApiMethods();

  for (const method of methods) {
    // Skip WithHttpInfo variants
    if (method.methodName.toLowerCase().includes('withhttpinfo')) {
      continue;
    }

    // Build searchTokens: CamelCase split of resourceType and methodName for better matching
    // This helps match "Pod" when searching for "PodExec", "PodBinding", etc.
    const searchTokens = [
      splitCamelCase(method.resourceType),
      splitCamelCase(method.methodName),
      method.apiClass,
    ].join(' ');

    const doc: OramaK8sDocument = {
      id: `${method.apiClass}.${method.methodName}`,
      resourceType: method.resourceType,
      methodName: method.methodName,
      description: method.description,
      searchTokens,
      action: extractAction(method.methodName),
      scope: extractScope(method.methodName),
      apiClass: method.apiClass,
    };

    await insert(db, doc);
  }

  oramaDb = db;
  console.error(`Orama: Indexed ${methods.length} Kubernetes API methods with full-text search`);
  return db;
}

/**
 * Search using Orama with advanced features:
 * - Full-text search with typo tolerance
 * - Field boosting (resourceType 3x, methodName 2x)
 * - Post-search filtering for action/scope (Orama enum filters are limited)
 * - Faceted results for discovery
 */
async function searchWithOrama(
  resourceType: string,
  action: string | undefined,
  scope: string,
  exclude: { actions?: string[]; apiClasses?: string[] } | undefined,
  limit: number,
  offset: number = 0
): Promise<{
  results: OramaK8sDocument[];
  totalFilteredCount: number;
  facets: {
    apiClass: Record<string, number>;
    action: Record<string, number>;
    scope: Record<string, number>;
  };
  searchTime: number;
}> {
  const db = await initializeOramaDb();

  // Build search params with Orama best practices
  // Note: We do filtering post-search because Orama's where clause has limitations
  // with enum types and multiple conditions
  const searchParams: SearchParams<Orama<typeof oramaSchema>, OramaK8sDocument> = {
    term: resourceType,

    // Search in these properties (searchTokens helps match CamelCase splits)
    properties: ['resourceType', 'methodName', 'description', 'searchTokens'],

    // Boost field importance: resourceType matches are 3x more important
    // searchTokens gets high boost because it contains the split CamelCase terms
    boost: {
      resourceType: 3,
      searchTokens: 2.5,
      methodName: 2,
      description: 1,
    },

    // Typo tolerance: allow 1 typo per word for better UX
    tolerance: 1,

    // Get more results initially to allow for post-search filtering and offset
    limit: Math.max((offset + limit) * 3, 100),

    // Generate facets for discovery
    facets: {
      apiClass: {},
      action: {},
      scope: {},
    },
  };

  const startTime = performance.now();
  const searchResult: Results<OramaK8sDocument> = await search(db, searchParams);
  const searchTime = performance.now() - startTime;

  // Apply post-search filtering for action, scope, and exclusions
  let filteredHits = searchResult.hits;

  // Filter by action if provided
  if (action) {
    const lowerAction = action.toLowerCase();
    filteredHits = filteredHits.filter(hit =>
      hit.document.action === lowerAction
    );
  }

  // Filter by scope
  if (scope === 'namespaced') {
    filteredHits = filteredHits.filter(hit =>
      hit.document.scope === 'namespaced'
    );
  } else if (scope === 'cluster') {
    // Cluster scope includes both 'cluster' and 'forAllNamespaces'
    filteredHits = filteredHits.filter(hit =>
      hit.document.scope === 'cluster' || hit.document.scope === 'forAllNamespaces'
    );
  }
  // scope === 'all' means no filtering

  // Apply exclusions
  if (exclude) {
    filteredHits = filteredHits.filter(hit => {
      const doc = hit.document;
      const hasActions = exclude.actions && exclude.actions.length > 0;
      const hasApiClasses = exclude.apiClasses && exclude.apiClasses.length > 0;

      if (hasActions && hasApiClasses) {
        // AND logic: both must match to exclude
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

  // Extract facets (from the full result set, not filtered)
  const facets = {
    apiClass: {} as Record<string, number>,
    action: {} as Record<string, number>,
    scope: {} as Record<string, number>,
  };

  if (searchResult.facets) {
    if (searchResult.facets.apiClass?.values) {
      for (const [key, value] of Object.entries(searchResult.facets.apiClass.values)) {
        facets.apiClass[key] = value as number;
      }
    }
    if (searchResult.facets.action?.values) {
      for (const [key, value] of Object.entries(searchResult.facets.action.values)) {
        facets.action[key] = value as number;
      }
    }
    if (searchResult.facets.scope?.values) {
      for (const [key, value] of Object.entries(searchResult.facets.scope.values)) {
        facets.scope[key] = value as number;
      }
    }
  }

  // Sort results to prioritize exact resourceType matches
  // This ensures that searching for "Namespace" returns Namespace resources first
  const sortedHits = filteredHits.sort((a, b) => {
    const aExact = a.document.resourceType.toLowerCase() === resourceType.toLowerCase();
    const bExact = b.document.resourceType.toLowerCase() === resourceType.toLowerCase();

    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    // If both are exact or both are partial, maintain Orama's relevance score order
    return (b.score || 0) - (a.score || 0);
  });

  // Total count of filtered results (before applying offset/limit) for pagination
  const totalFilteredCount = sortedHits.length;

  return {
    results: sortedHits.slice(offset, offset + limit).map(hit => hit.document),
    totalFilteredCount,
    facets,
    searchTime,
  };
}

/**
 * Initialize scripts directory with node_modules symlink for package resolution
 */
function initializeScriptsDirectory(scriptsDir: string): void {
  try {
    // Ensure scripts directory exists
    if (!existsSync(scriptsDir)) {
      mkdirSync(scriptsDir, { recursive: true });
    }
    
    // Create symlink to node_modules if it doesn't exist
    // When installed via npx, dependencies are hoisted to the cache root
    // PACKAGE_ROOT is like: /path/to/npx/cache/node_modules/@prodisco/k8s-mcp
    // Dependencies are in: /path/to/npx/cache/node_modules
    const nodeModulesLink = join(scriptsDir, 'node_modules');
    const nodeModulesTarget = join(PACKAGE_ROOT, '../..');
    
    if (!existsSync(nodeModulesLink) && existsSync(nodeModulesTarget)) {
      try {
        symlinkSync(nodeModulesTarget, nodeModulesLink, 'dir');
      } catch (err) {
        // Symlink creation might fail on some systems, that's okay
        console.error('Could not create symlink to node_modules:', err);
      }
    }
  } catch (err) {
    // If initialization fails, scripts can still work with NODE_PATH
    console.error('Could not initialize scripts directory:', err);
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

/**
 * Extract all API methods from @kubernetes/client-node
 */
function extractKubernetesApiMethods(): KubernetesApiMethod[] {
  if (apiMethodsCache) {
    return apiMethodsCache;
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
      const description = generateDescriptionFromMethodName(methodName, className, classDesc);
      const parameters = inferParameters(methodName, className);
      const example = generateUsageExample(className, methodName, parameters);
      const inputSchema = generateInputSchema(methodName, parameters);
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

  apiMethodsCache = methods;
  console.error(`Indexed ${methods.length} Kubernetes API methods`);
  return methods;
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

function generateDescriptionFromMethodName(methodName: string, apiClass: string, classDesc: string): string {
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

function generateInputSchema(methodName: string, parameters: Array<{ name: string; type: string; optional: boolean; description?: string }>) {
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
      pagination: { offset: 0, limit: 10, hasMore: false },
    };
  }

  const { results: oramaResults, totalFilteredCount, facets, searchTime } = await searchWithOrama(
    resourceType,
    action,
    scope,
    exclude,
    limit,
    offset
  );

  const allMethods = extractKubernetesApiMethods();
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

  const hasMore = offset + results.length < totalFilteredCount;

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
    summary += ` | Page: ${Math.floor(offset / limit) + 1}, showing ${offset + 1}-${offset + results.length} of ${totalFilteredCount}`;
  }
  summary += `\n\n`;

  if (Object.keys(facets.apiClass).length > 0) {
    summary += `FACETS (refine your search):\n`;
    summary += `   API Classes: ${Object.entries(facets.apiClass).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    summary += `   Actions: ${Object.entries(facets.action).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    summary += `   Scopes: ${Object.entries(facets.scope).map(([k, v]) => `${k}(${v})`).join(', ')}\n\n`;
  }

  if (cachedScripts.length > 0) {
    summary += `EXISTING CACHED SCRIPTS (${cachedScripts.length}):\n`;
    cachedScripts.forEach(script => {
      summary += `   - ${script}\n`;
    });
    summary += `   (Location: ${scriptsDirectory})\n\n`;
  }

  summary += `Write scripts to: ${scriptsDirectory}/<name>.ts\n`;
  summary += `Run with: npx tsx ${scriptsDirectory}/<name>.ts\n`;
  summary += `For type definitions: use mode: "types" with types: ["V1Pod"]\n\n`;

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
    totalMatches: totalFilteredCount,
    usage,
    paths: {
      scriptsDirectory,
    },
    cachedScripts,
    facets,
    searchTime,
    pagination: {
      offset,
      limit,
      hasMore,
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
  await initializeOramaDb();
}

// ============================================================================
// Main Tool Export
// ============================================================================

export const searchToolsTool: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'kubernetes.searchTools',
  description:
    'Find Kubernetes API methods or get type definitions. ' +
    'MODES: ' +
    '• methods (default): Search for API methods by resource type. ' +
    'Params: resourceType (required), action, scope, exclude, limit, offset. ' +
    'Example: { resourceType: "Pod", action: "list" } ' +
    '• types: Get TypeScript type definitions with path navigation. ' +
    'Params: types (required), depth. ' +
    'Example: { mode: "types", types: ["V1Pod", "V1Deployment.spec.template.spec"] } ' +
    'Actions: list, read, create, delete, patch, replace, connect, get, watch. ' +
    'Scopes: namespaced, cluster, all.',
  schema: SearchToolsInputSchema,
  async execute(input) {
    const { mode = 'methods' } = input;

    if (mode === 'types') {
      return executeTypeMode(input);
    } else {
      return executeMethodMode(input);
    }
  },
};

