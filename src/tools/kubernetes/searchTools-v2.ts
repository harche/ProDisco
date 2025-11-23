import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import type { ToolDefinition } from '../types.js';

const SearchToolsInputSchema = z.object({
  query: z
    .string()
    .describe('Search query to find Kubernetes API methods (e.g., "pod", "deployment", "create namespace")'),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(20)
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
};

type SearchToolsResult = {
  summary: string;
  tools: KubernetesApiMethod[];
  totalMatches: number;
  usage: string;
};

// Cache for Kubernetes API methods
let apiMethodsCache: KubernetesApiMethod[] | null = null;

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
      const parameters = inferParameters(methodName);
      const example = generateUsageExample(className, methodName, parameters);

      methods.push({
        apiClass: className,
        methodName,
        resourceType,
        description,
        parameters,
        returnType: 'Promise<any>',
        example,
      });
    }
  }

  apiMethodsCache = methods;
  console.error(`✅ Indexed ${methods.length} Kubernetes API methods`);
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

function inferParameters(methodName: string): Array<{ name: string; type: string; optional: boolean; description?: string }> {
  const parameters: Array<{ name: string; type: string; optional: boolean; description?: string }> = [];
  
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

function generateUsageExample(apiClass: string, methodName: string, parameters: Array<{ name: string; type: string; optional: boolean }>): string {
  const apiVar = apiClass.charAt(0).toLowerCase() + apiClass.slice(1);
  const requiredParams = parameters.filter(p => !p.optional);
  
  let example = `// Initialize the Kubernetes client\nconst kc = new k8s.KubeConfig();\nkc.loadFromDefault();\nconst ${apiVar} = kc.makeApiClient(k8s.${apiClass});\n\n`;
  
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
  
  example += `// Call the API method (ALWAYS uses object parameters - even if empty {})\nconst response = await ${apiVar}.${methodName}(${paramStr});\n\n`;
  
  if (methodName.startsWith('list')) {
    example += `// Response structure:\n// response.body.items = array of resources\nconst items = response.body.items;\nconsole.log(\`Found \${items.length} resources\`);`;
  } else if (methodName.startsWith('read') || methodName.startsWith('get')) {
    example += `// Response structure:\n// response.body = single resource object\nconst resource = response.body;\nconsole.log(\`Resource: \${resource.metadata?.name}\`);`;
  } else if (methodName.startsWith('create')) {
    example += `// Response structure:\n// response.body = created resource\nconst created = response.body;\nconsole.log(\`Created: \${created.metadata?.name}\`);`;
  } else if (methodName.startsWith('delete')) {
    example += `// Response structure:\n// response.body = status info\nconst status = response.body;\nconsole.log(\`Status: \${status.status}\`);`;
  } else {
    example += `// Response: response.body contains the result\nconsole.log(response.body);`;
  }
  
  return example;
}

/**
 * Simple, direct search without fuzzy matching
 */
function searchMethods(query: string, methods: KubernetesApiMethod[], limit: number): KubernetesApiMethod[] {
  const lowerQuery = query.toLowerCase();
  const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 1);
  
  // Map action words to method prefixes
  const actionMap: Record<string, string[]> = {
    'get': ['read'],
    'read': ['read'],
    'fetch': ['read', 'list'],
    'list': ['list'],
    'show': ['list', 'read'],
    'create': ['create'],
    'make': ['create'],
    'add': ['create'],
    'delete': ['delete'],
    'remove': ['delete'],
    'update': ['patch', 'replace'],
    'patch': ['patch'],
    'replace': ['replace'],
    'edit': ['patch'],
  };
  
  // Extract action and resource words
  let expectedActions: string[] = [];
  const resourceWords: string[] = [];
  
  for (const word of queryWords) {
    if (actionMap[word]) {
      expectedActions = actionMap[word];
    } else {
      resourceWords.push(word, word.replace(/s$/, '')); // Add singular form
    }
  }
  
  // Score each method
  const scored = methods.map(method => {
    const lowerMethod = method.methodName.toLowerCase();
    const lowerResource = method.resourceType.toLowerCase();
    let score = 0;
    
    // Factor 1: Resource type matching (most important)
    let resourceMatches = 0;
    for (const word of resourceWords) {
      if (word.length < 3) continue;
      
      // Exact match
      if (lowerResource === word || lowerResource === word.replace(/s$/, '')) {
        resourceMatches += 1000;
      }
      // Starts with
      else if (lowerResource.startsWith(word)) {
        resourceMatches += 100;
      }
      // Contains
      else if (lowerResource.includes(word)) {
        resourceMatches += 10;
      }
    }
    
    score += resourceMatches;
    
    // Factor 2: Action matching
    if (expectedActions.length > 0) {
      const hasMatchingAction = expectedActions.some(action => lowerMethod.startsWith(action));
      if (hasMatchingAction) {
        score += 500;
      }
    }
    
    // Factor 3: Penalize unwanted patterns
    if (lowerMethod.includes('withhttpinfo')) score -= 1000;
    if (lowerMethod.includes('connect') || lowerMethod.includes('proxy')) {
      if (!lowerQuery.includes('proxy') && !lowerQuery.includes('connect')) {
        score -= 500;
      }
    }
    
    // Factor 4: Prefer namespaced methods
    if (lowerMethod.includes('namespaced')) score += 50;
    
    // Factor 5: Prefer simpler resource types (shorter names)
    score -= lowerResource.length;
    
    return { method, score };
  });
  
  // Sort by score (higher = better) and return top results
  return scored
    .filter(s => s.score > 0) // Only include methods with positive scores
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.method);
}

export const searchToolsToolV2: ToolDefinition<SearchToolsResult, typeof SearchToolsInputSchema> = {
  name: 'kubernetes.searchTools',
  description: 
    'Search the Kubernetes API to find methods for working with resources. ' +
    'Returns API methods from @kubernetes/client-node that you can use directly in your scripts. ' +
    'Example queries: "list pods", "create deployment", "delete service", "get pod logs".',
  schema: SearchToolsInputSchema,
  async execute(input) {
    const { query, limit = 20 } = input;

    const methods = extractKubernetesApiMethods();
    const results = searchMethods(query, methods, limit);

    // Create summary
    let summary = `Found ${results.length} Kubernetes API method(s) matching "${query}":\n\n`;
    results.forEach((method, i) => {
      summary += `${i + 1}. ${method.apiClass}.${method.methodName}\n`;
      summary += `   ${method.description}\n`;
    });

    const usage = 
      '⚠️  CRITICAL: All methods use OBJECT PARAMETERS, not positional!\n\n' +
      '1. API method signature (IMPORTANT):\n' +
      '   ✅ CORRECT:   await api.listNamespacedPod({ namespace: \'default\' })\n' +
      '   ❌ WRONG:     await api.listNamespacedPod(\'default\')\n\n' +
      '2. All API methods return a response object:\n' +
      '   { body: <resource>, response: <http response> }\n' +
      '   - For list operations: response.body.items = array\n' +
      '   - For single resource: response.body = resource object\n\n' +
      '3. See the "example" field in each method for complete, working code.';

    return {
      summary,
      tools: results,
      totalMatches: results.length,
      usage,
    };
  },
};

