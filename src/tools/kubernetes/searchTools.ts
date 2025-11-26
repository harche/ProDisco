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
  resourceType: z
    .string()
    .describe('Kubernetes resource type (e.g., "Pod", "Deployment", "Service", "ConfigMap")'),
  action: z
    .string()
    .optional()
    .describe('API action: list, read, create, delete, patch, replace, connect, get, watch. Omit to return all actions for the resource.'),
  scope: z
    .enum(['namespaced', 'cluster', 'all'])
    .optional()
    .default('all')
    .describe('Resource scope: "namespaced" for namespace-scoped resources, "cluster" for cluster-wide resources, "all" for both'),
  exclude: z
    .object({
      actions: z
        .array(z.string())
        .optional()
        .describe('Actions to exclude (e.g., ["connect", "watch"]). Filters out methods with these action prefixes.'),
      apiClasses: z
        .array(z.string())
        .optional()
        .describe('API classes to exclude (e.g., ["CustomObjectsApi"]). Filters out methods from these API classes.'),
    })
    .optional()
    .describe('Exclusion criteria. If both actions and apiClasses are specified, both must match (AND logic) to exclude a method.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .optional()
    .describe('Maximum number of results to return'),
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

type SearchToolsResult = {
  summary: string;
  tools: KubernetesApiMethod[];
  totalMatches: number;
  usage: string;
  paths: {
    scriptsDirectory: string;
  };
  cachedScripts: string[];
  // New: Orama-powered facets for discovery
  facets?: {
    apiClass: Record<string, number>;
    action: Record<string, number>;
    scope: Record<string, number>;
  };
  searchTime?: number;
};

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
  limit: number
): Promise<{
  results: OramaK8sDocument[];
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

    // Get more results initially to allow for post-search filtering
    limit: Math.max(limit * 5, 50),

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

  return {
    results: sortedHits.slice(0, limit).map(hit => hit.document),
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

/**
 * Match methods based on structured parameters: resourceType, action, scope, exclude
 */
function matchMethods(
  resourceType: string,
  action: string | undefined,
  scope: string,
  exclude: { actions?: string[]; apiClasses?: string[] } | undefined,
  methods: KubernetesApiMethod[],
  limit: number
): KubernetesApiMethod[] {
  const lowerResourceType = resourceType.toLowerCase();
  
  // Filter methods based on criteria
  const filtered = methods.filter(method => {
    const lowerMethod = method.methodName.toLowerCase();
    const lowerResource = method.resourceType.toLowerCase();
    
    // 1. Exclude WithHttpInfo variants (duplicates)
    if (lowerMethod.includes('withhttpinfo')) {
      return false;
    }
    
    // 2. Apply exclusion criteria
    if (exclude) {
      const hasActions = exclude.actions && exclude.actions.length > 0;
      const hasApiClasses = exclude.apiClasses && exclude.apiClasses.length > 0;
      
      if (hasActions || hasApiClasses) {
        const matchesActionExclusion = hasActions && 
          exclude.actions!.some(a => lowerMethod.startsWith(a.toLowerCase()) || lowerMethod.includes(a.toLowerCase()));
        const matchesApiClassExclusion = hasApiClasses && 
          exclude.apiClasses!.includes(method.apiClass);
        
        // If both specified, must match both (AND logic) to be excluded
        if (hasActions && hasApiClasses) {
          if (matchesActionExclusion && matchesApiClassExclusion) {
            return false;
          }
        }
        // If only actions specified, exclude if action matches
        else if (hasActions && matchesActionExclusion) {
          return false;
        }
        // If only apiClasses specified, exclude if apiClass matches
        else if (hasApiClasses && matchesApiClassExclusion) {
          return false;
        }
      }
    }
    
    // 3. Match resource type (case-insensitive)
    // Support both exact match and partial match (e.g., "pod" matches "Pod", "PodTemplate")
    const resourceMatches = 
      lowerResource === lowerResourceType || 
      lowerResource === lowerResourceType.replace(/s$/, '') || // handle plurals
      lowerResourceType === lowerResource.replace(/s$/, '') ||
      lowerResource.includes(lowerResourceType) ||
      lowerResourceType.includes(lowerResource);
    
    if (!resourceMatches) {
      return false;
    }
    
    // 4. Match action if provided
    if (action) {
      const lowerAction = action.toLowerCase();
      // Flexible matching: method can start with action or contain it early (for compound actions)
      // e.g., "delete" matches both "deleteNamespacedPod" and "deleteCollectionNamespacedPod"
      const actionMatches = 
        lowerMethod.startsWith(lowerAction) ||
        lowerMethod.includes(lowerAction);
      
      if (!actionMatches) {
        return false;
      }
    }
    
    // 5. Match scope
    const hasNamespaced = lowerMethod.includes('namespaced');
    const hasForAllNamespaces = lowerMethod.includes('forallnamespaces');
    
    if (scope === 'namespaced' && !hasNamespaced) {
      return false;
    }
    if (scope === 'cluster' && hasNamespaced && !hasForAllNamespaces) {
      return false;
    }
    // scope === 'all' means no filtering
    
    return true;
  });
  
  // Sort: prefer exact resource matches, then by method name alphabetically
  const sorted = filtered.sort((a, b) => {
    const aExact = a.resourceType.toLowerCase() === lowerResourceType;
    const bExact = b.resourceType.toLowerCase() === lowerResourceType;
    
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    
    // Both exact or both partial: sort alphabetically
    return a.methodName.localeCompare(b.methodName);
  });
  
  return sorted.slice(0, limit);
}

export const searchToolsTool: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'kubernetes.searchTools',
  description: 
    'Find Kubernetes API methods by resource type and action. ' +
    'Returns API methods from @kubernetes/client-node that you can use directly in your scripts. ' +
    'Parameters: resourceType (e.g., "Pod", "Deployment"), action (optional: list, read, create, delete, patch, replace), scope (namespaced/cluster/all), exclude (optional: filter out by actions and/or apiClasses). ' +
    'Available actions: list (list resources), read (get single resource), create (create resource), delete (delete resource), patch (update resource), replace (replace resource), connect (exec/logs/proxy), get, watch. ' +
    'COMMON SEARCH PATTERNS: (1) Pod logs: use resourceType "Log" or "PodLog" (NOT "Pod" with action "connect"). Example: { resourceType: "Log" } returns CoreV1Api.readNamespacedPodLog. ' +
    '(2) Pod exec/attach: use { resourceType: "Pod", action: "connect" } returns connectGetNamespacedPodExec, connectPostNamespacedPodAttach. ' +
    '(3) Pod eviction (drain nodes): use { resourceType: "Eviction" } or { resourceType: "PodEviction" } returns CoreV1Api.createNamespacedPodEviction. ' +
    '(4) Binding pods to nodes: use { resourceType: "Binding" } or { resourceType: "PodBinding" } returns CoreV1Api.createNamespacedPodBinding. ' +
    '(5) Service account tokens: use { resourceType: "ServiceAccountToken" } returns CoreV1Api.createNamespacedServiceAccountToken. ' +
    '(6) Cluster health: use { resourceType: "ComponentStatus" } returns CoreV1Api.listComponentStatus. ' +
    '(7) Status subresources: use full resource name like { resourceType: "DeploymentStatus" }. ' +
    '(8) Scale subresources: use full resource name like { resourceType: "DeploymentScale" }. ' +
    'TIP: Use the exclude parameter to get more precise results by filtering out unwanted methods. ' +
    'Exclude examples: (1) Only action: { actions: ["delete"] } excludes all delete methods. ' +
    '(2) Multiple actions: { actions: ["delete", "create"] } excludes both delete and create methods. ' +
    '(3) By API class: { apiClasses: ["CoreV1Api"] } excludes all CoreV1Api methods. ' +
    '(4) Both action and apiClass (AND logic): { actions: ["delete"], apiClasses: ["CoreV1Api"] } excludes only delete methods from CoreV1Api, keeping other CoreV1Api methods and delete methods from other API classes. ' +
    'Exclude is especially useful when searching broad resource types (e.g., "Pod" returns methods from CoreV1Api, AutoscalingV1Api, PolicyV1Api). ' +
    'CUSTOM SCRIPTS: Before writing new scripts, check scripts/cache/ directory for existing implementations. ' +
    'When creating custom scripts in scripts/cache/, follow Kubernetes library naming pattern to make them easily discoverable: ' +
    'use action-scope-resource format (e.g., "list-namespaced-pod", "read-namespaced-pod-log", "create-namespaced-deployment"). ' +
    'Example: For listing etcd pods in kube-system, name it "list-namespaced-etcd-pods.ts" NOT "get-etcd-pods.ts". ' +
    'This naming convention makes scripts searchable and helps avoid duplicates.',
  schema: SearchToolsInputSchema,
  async execute(input) {
    const { resourceType, action, scope = 'all', exclude, limit = 10 } = input;

    // Use Orama for intelligent full-text search with typo tolerance and relevance scoring
    const { results: oramaResults, facets, searchTime } = await searchWithOrama(
      resourceType,
      action,
      scope,
      exclude,
      limit
    );

    // Get full method details for the matched results
    const allMethods = extractKubernetesApiMethods();
    const methodMap = new Map(allMethods.map(m => [`${m.apiClass}.${m.methodName}`, m]));

    const results: KubernetesApiMethod[] = oramaResults
      .map(doc => methodMap.get(doc.id))
      .filter((m): m is KubernetesApiMethod => m !== undefined);

    // Define paths early so they can be used in summary
    const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');

    // Initialize scripts directory with node_modules symlink
    initializeScriptsDirectory(scriptsDirectory);

    // List existing cached scripts
    let cachedScripts: string[] = [];
    try {
      if (existsSync(scriptsDirectory)) {
        cachedScripts = readdirSync(scriptsDirectory)
          .filter(f => f.endsWith('.ts'))
          .sort();
      }
    } catch {
      // Ignore errors if directory doesn't exist or can't be read
    }

    // Structured output - clear and unambiguous
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
    summary += ` (search: ${searchTime.toFixed(2)}ms)\n\n`;

    // Show facets for discovery (what else is available)
    if (Object.keys(facets.apiClass).length > 0) {
      summary += `📊 FACETS (refine your search):\n`;
      summary += `   API Classes: ${Object.entries(facets.apiClass).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
      summary += `   Actions: ${Object.entries(facets.action).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
      summary += `   Scopes: ${Object.entries(facets.scope).map(([k, v]) => `${k}(${v})`).join(', ')}\n\n`;
    }

    // Show existing cached scripts if any
    if (cachedScripts.length > 0) {
      summary += `📝 EXISTING CACHED SCRIPTS (${cachedScripts.length}):\n`;
      cachedScripts.forEach(script => {
        summary += `   - ${script}\n`;
      });
      summary += `   (Location: ${scriptsDirectory})\n\n`;
    }

    summary += `Write scripts to: ${scriptsDirectory}/<name>.ts and run with: npx tsx ${scriptsDirectory}/<name>.ts\n`;
    summary += `IMPORTANT: Check existing cached scripts above before creating new ones to avoid duplicates\n`;
    summary += `Custom script naming convention: Use k8s library pattern (e.g., list-namespaced-pod, read-namespaced-pod-log)\n`;
    summary += `For detailed type definitions: use kubernetes.getTypeDefinition tool\n\n`;

    results.forEach((method, i) => {
      summary += `${i + 1}. ${method.apiClass}.${method.methodName}\n`;

      // Method arguments
      if (method.inputSchema.required.length > 0) {
        const params = method.inputSchema.required.map(r =>
          `${r}: "${method.inputSchema.properties[r]?.type || 'string'}"`
        ).join(', ');
        summary += `   method_args: { ${params} }\n`;
      } else {
        summary += `   method_args: {} (empty object - required)\n`;
      }

      // Return values
      const isList = method.methodName.startsWith('list');
      if (isList) {
        summary += `   return_values: response.items (array of ${method.resourceType})\n`;
      } else {
        summary += `   return_values: response (${method.resourceType} object)\n`;
      }

      // Include inline type definitions if available (brief overview)
      if (method.typeDefinitions && method.typeDefinitions.output) {
        const lines = method.typeDefinitions.output.split('\n');
        const typeName = lines[0]?.trim() || 'unknown';

        // Extract key properties (just first 2-3)
        const propertyLines = lines.slice(1, 4).filter(l => l.trim() && !l.includes('}'));

        summary += `   return_types: ${typeName}\n`;
        if (propertyLines.length > 0) {
          summary += `     key properties: ${propertyLines.map(l => l.trim()).join(', ')}\n`;
        }
        summary += `     (use kubernetes.getTypeDefinition for complete type details)\n`;
      }

      summary += `\n`;
    });

    if (results.length === 0) {
      summary += `No methods found. Try:\n`;
      summary += `- Different resourceType (e.g., "Pod", "Deployment", "Service")\n`;
      summary += `- Check for typos - Orama has typo tolerance but needs a close match\n`;
      summary += `- Omit action to see all available methods\n`;
      summary += `- Use scope: "all" to see both namespaced and cluster methods\n`;
    }

    const usage =
      'USAGE:\n' +
      '- All methods require object parameter: await api.method({ param: value })\n' +
      '- No required params: await api.method({})\n' +
      '- List operations return: response.items (array)\n' +
      '- Single resource operations return: response (object)\n' +
      `- Write scripts to: ${scriptsDirectory}/<yourscript>.ts\n` +
      `- IMPORTANT: Import using package name: import * as k8s from '@kubernetes/client-node';\n` +
      `- Run with: npx tsx ${scriptsDirectory}/<yourscript>.ts\n` +
      `- The @kubernetes/client-node package is available (installed with this MCP server)`;

    return {
      summary,
      tools: results,
      totalMatches: results.length,
      usage,
      paths: {
        scriptsDirectory,
      },
      cachedScripts,
      facets,
      searchTime,
    };
  },
};

