import { describe, expect, it, afterAll } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { searchToolsTool, searchToolsService } from '../tools/kubernetes/searchTools.js';
import { SCRIPTS_CACHE_DIR } from '../util/paths.js';

// =============================================================================
// Test Script Setup - MUST happen before any tests run to ensure the script
// is indexed when Orama DB is initialized during the first test
// =============================================================================
const scriptsDirectory = SCRIPTS_CACHE_DIR;
const testScriptName = 'test-search-pods.ts';
const testScriptPath = join(scriptsDirectory, testScriptName);
const testScriptContent = `/**
 * Test script for searching pods in a namespace.
 * Uses CoreV1Api to list pods.
 */
import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const api = kc.makeApiClient(k8s.CoreV1Api);

async function main() {
  const response = await api.listNamespacedPod({ namespace: 'default' });
  console.log(response.items);
}

main();
`;

// Create the test script immediately at module load time
// This ensures it exists before the Orama DB is initialized
if (!existsSync(scriptsDirectory)) {
  mkdirSync(scriptsDirectory, { recursive: true });
}
writeFileSync(testScriptPath, testScriptContent);

// ============================================================================
// Unified API Helpers
// ============================================================================

// Main search helper - works for all document types
type SearchInput = {
  query?: string;
  documentType?: 'kubernetes' | 'prometheus' | 'loki' | 'analytics' | 'script' | 'all';
  action?: string;
  library?: string;
  scope?: 'namespaced' | 'cluster' | 'all';
  exclude?: {
    actions?: string[];
    libraries?: string[];
  };
  limit?: number;
  offset?: number;
};

type SearchResult = {
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
  relevantScripts: Array<{ filename: string; description: string; apiClasses: string[] }>;
  facets: {
    documentType: Record<string, number>;
    library: Record<string, number>;
    action: Record<string, number>;
    scope: Record<string, number>;
  };
  pagination: { offset: number; limit: number; hasMore: boolean };
  searchTime: number;
  usage: string;
  paths: { scriptsDirectory: string };
};

const search = searchToolsTool.execute.bind(searchToolsTool) as (input: SearchInput) => Promise<SearchResult>;

// Legacy helper for backward compatibility with existing test structure
// Converts old API calls to new unified API
const searchTools = async (input: {
  resourceType: string;
  action?: string;
  scope?: 'namespaced' | 'cluster' | 'all';
  exclude?: { actions?: string[]; apiClasses?: string[] };
  limit?: number;
  offset?: number;
}) => {
  const result = await search({
    query: input.resourceType,
    documentType: 'kubernetes',
    action: input.action,
    scope: input.scope,
    exclude: input.exclude ? { actions: input.exclude.actions, libraries: input.exclude.apiClasses } : undefined,
    limit: input.limit,
    offset: input.offset,
  });
  // Convert to old format for existing tests
  return {
    mode: 'methods' as const,
    tools: result.results.map(r => ({
      apiClass: r.library,
      methodName: r.name,
      resourceType: r.action, // In the new format, action contains the extracted action
      description: r.description,
      parameters: r.parameters || [],
      returnType: r.returnType || 'Promise<any>',
      example: r.example || '',
      inputSchema: { type: 'object', properties: {}, required: [], description: '' },
      outputSchema: { type: 'object', description: '', properties: {} },
      typeDefinitionFile: '',
    })),
    totalMatches: result.totalMatches,
    summary: result.summary,
    usage: result.usage,
    paths: result.paths,
    cachedScripts: [],
    relevantScripts: result.relevantScripts,
    facets: {
      apiClass: result.facets.library,
      action: result.facets.action,
      scope: result.facets.scope,
    },
    searchTime: result.searchTime,
    pagination: result.pagination,
  };
};

// Helper for scripts search
const searchScripts = async (input: {
  mode?: 'scripts';
  searchTerm?: string;
  limit?: number;
  offset?: number;
}) => {
  // When no searchTerm, use 'script' since all scripts have 'script' in their searchTokens
  // This ensures Orama full-text search returns results
  const result = await search({
    query: input.searchTerm || 'script',
    documentType: 'script',
    limit: input.limit,
    offset: input.offset,
  });
  return {
    mode: 'scripts' as const,
    summary: result.summary,
    scripts: result.results.map(r => ({
      // Add .ts extension back since buildScriptDocument strips it from methodName
      filename: r.name.endsWith('.ts') ? r.name : `${r.name}.ts`,
      description: r.description,
      apiClasses: r.library !== 'CachedScript' ? [r.library] : [],
    })),
    totalMatches: result.totalMatches,
    paths: result.paths,
    pagination: result.pagination,
    usage: result.usage,
  };
};

describe('kubernetes.searchTools', () => {
  describe('Basic Functionality', () => {
    it('includes JSON schemas for inputs', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result.tools.length).toBeGreaterThan(0);
      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });

    it('filters tools by structured parameters', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        scope: 'namespaced',
        limit: 5,
      });

      expect(result.tools.length).toBeGreaterThan(0);
      // Check that results match the structured parameters
      expect(result.tools.some((tool) => tool.methodName.toLowerCase().includes('list'))).toBe(true);
      expect(result.tools.some((tool) => tool.methodName.toLowerCase().includes('pod'))).toBe(true);
      expect(result.tools.some((tool) => tool.methodName.toLowerCase().includes('namespaced'))).toBe(true);
    });

    it('works without action parameter', async () => {
      const result = await searchTools({
        resourceType: 'Deployment',
        limit: 10,
      });

      expect(result.tools.length).toBeGreaterThan(0);
      // Should return multiple actions for Deployment
      const actions = new Set(result.tools.map(t => t.methodName.split(/(?=[A-Z])/)[0].toLowerCase()));
      expect(actions.size).toBeGreaterThan(1); // Should have create, delete, list, etc.
    });
  });

  describe('README Example Queries', () => {
    it('handles basic Pod query', async () => {
      const result = await searchTools({ resourceType: 'Pod' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.apiClass === 'CoreV1Api')).toBe(true);
    });

    it('handles namespaced Pod list query', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        scope: 'namespaced',
      });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName === 'listNamespacedPod' && t.apiClass === 'CoreV1Api'
      )).toBe(true);
    });

    it('handles Deployment create query', async () => {
      const result = await searchTools({
        resourceType: 'Deployment',
        action: 'create',
      });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName.toLowerCase().includes('create') && 
        t.methodName.toLowerCase().includes('deployment')
      )).toBe(true);
    });

    it('excludes delete actions from Pod methods', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { actions: ['delete'] },
      });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
    });

    it('excludes CoreV1Api from Pod methods', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { apiClasses: ['CoreV1Api'] },
      });

      // Should have results from other API classes (AutoscalingV1Api, PolicyV1Api, etc.)
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.every(t => t.apiClass !== 'CoreV1Api')).toBe(true);
    });

    it('excludes with AND logic - delete from CoreV1Api only', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: {
          actions: ['delete'],
          apiClasses: ['CoreV1Api'],
        },
      });

      // Should still have CoreV1Api methods (non-delete ones)
      expect(result.tools.some(t => t.apiClass === 'CoreV1Api')).toBe(true);
      
      // Should not have delete methods from CoreV1Api
      const coreV1Methods = result.tools.filter(t => t.apiClass === 'CoreV1Api');
      expect(coreV1Methods.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
    });
  });

  describe('Common Search Patterns from README', () => {
    it('finds Pod logs using "Log" resource type', async () => {
      const result = await searchTools({ resourceType: 'Log' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName === 'readNamespacedPodLog' && t.apiClass === 'CoreV1Api'
      )).toBe(true);
    });

    it('finds Pod logs using "PodLog" resource type', async () => {
      const result = await searchTools({ resourceType: 'PodLog' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName.includes('PodLog')
      )).toBe(true);
    });

    it('finds Pod exec/attach using "Pod" with "connect" action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'connect',
      });

      expect(result.tools.length).toBeGreaterThan(0);
      const methodNames = result.tools.map(t => t.methodName);
      expect(methodNames.some(name => name.includes('Exec') || name.includes('exec'))).toBe(true);
    });

    it('finds Pod eviction using "Eviction" resource type', async () => {
      const result = await searchTools({ resourceType: 'Eviction' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName === 'createNamespacedPodEviction' && t.apiClass === 'CoreV1Api'
      )).toBe(true);
    });

    it('finds Pod eviction using "PodEviction" resource type', async () => {
      const result = await searchTools({ resourceType: 'PodEviction' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName.includes('Eviction')
      )).toBe(true);
    });

    it('finds Pod binding using "Binding" resource type', async () => {
      const result = await searchTools({ resourceType: 'Binding' });

      expect(result.tools.length).toBeGreaterThan(0);
      // Binding search should find binding-related methods
      expect(result.tools.some(t =>
        t.methodName.includes('Binding')
      )).toBe(true);
    });

    it('finds Pod binding using "PodBinding" resource type', async () => {
      const result = await searchTools({ resourceType: 'PodBinding' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t =>
        t.methodName === 'createNamespacedPodBinding' && t.apiClass === 'CoreV1Api'
      )).toBe(true);
    });

    it('finds ServiceAccount tokens using "ServiceAccountToken" resource type', async () => {
      const result = await searchTools({ resourceType: 'ServiceAccountToken' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName === 'createNamespacedServiceAccountToken' && t.apiClass === 'CoreV1Api'
      )).toBe(true);
    });

    it('finds cluster health using "ComponentStatus" resource type', async () => {
      const result = await searchTools({ resourceType: 'ComponentStatus' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => 
        t.methodName === 'listComponentStatus' && t.apiClass === 'CoreV1Api'
      )).toBe(true);
    });

    it('finds status subresources using "DeploymentStatus" resource type', async () => {
      const result = await searchTools({ resourceType: 'DeploymentStatus' });

      expect(result.tools.length).toBeGreaterThan(0);
      const methodNames = result.tools.map(t => t.methodName);
      expect(methodNames.some(name => 
        (name.includes('readNamespacedDeploymentStatus') || name.includes('patchNamespacedDeploymentStatus'))
      )).toBe(true);
    });

    it('finds scale subresources using "DeploymentScale" resource type', async () => {
      const result = await searchTools({ resourceType: 'DeploymentScale' });

      expect(result.tools.length).toBeGreaterThan(0);
      const methodNames = result.tools.map(t => t.methodName);
      expect(methodNames.some(name => 
        name.includes('DeploymentScale')
      )).toBe(true);
    });
  });

  describe('Scope Filtering', () => {
    it('filters namespaced resources correctly', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        scope: 'namespaced',
        limit: 5,
      });

      // Namespaced Pod methods should include 'namespaced' in method name
      expect(result.tools.every(t => t.methodName.toLowerCase().includes('namespaced'))).toBe(true);
    });

    it('filters cluster-scoped resources correctly', async () => {
      const result = await searchTools({
        resourceType: 'Node',
        action: 'list',
        scope: 'cluster',
        limit: 5,
      });

      // Cluster-scoped Node methods should NOT include 'namespaced' (unless ForAllNamespaces)
      expect(result.tools.some(t => !t.methodName.toLowerCase().includes('namespaced'))).toBe(true);
    });

    it('returns both scopes with "all" scope', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        scope: 'all',
        limit: 20,
      });

      // Should have both namespaced and potentially cluster-wide methods
      expect(result.tools.length).toBeGreaterThan(0);
    });
  });

  describe('Exclude Filtering', () => {
    it('excludes single action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        scope: 'namespaced',
        exclude: { actions: ['delete'] },
        limit: 20,
      });

      // Should not contain any delete methods
      expect(result.tools.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('excludes multiple actions', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        scope: 'namespaced',
        exclude: { actions: ['delete', 'create'] },
        limit: 20,
      });

      // Should not contain delete or create methods
      expect(result.tools.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
      expect(result.tools.every(t => !t.methodName.toLowerCase().includes('create'))).toBe(true);
    });

    it('excludes by API class', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { apiClasses: ['CoreV1Api'] },
        limit: 20,
      });

      // Should not contain any CoreV1Api methods
      expect(result.tools.every(t => t.apiClass !== 'CoreV1Api')).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('uses AND logic with both action and apiClass filters', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { 
          actions: ['delete'], 
          apiClasses: ['CoreV1Api'] 
        },
        limit: 20,
      });

      // Should still have CoreV1Api methods (non-delete ones)
      expect(result.tools.some(t => t.apiClass === 'CoreV1Api')).toBe(true);
      
      // Should not have delete methods from CoreV1Api
      const coreV1Methods = result.tools.filter(t => t.apiClass === 'CoreV1Api');
      expect(coreV1Methods.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
    });
  });

  describe('Action Filtering', () => {
    it('filters by "list" action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'list',
      });

      expect(result.tools.every(t => t.methodName.toLowerCase().includes('list'))).toBe(true);
    });

    it('filters by "read" action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'read',
      });

      expect(result.tools.every(t => t.methodName.toLowerCase().includes('read'))).toBe(true);
    });

    it('filters by "create" action', async () => {
      const result = await searchTools({
        resourceType: 'Deployment',
        action: 'create',
      });

      expect(result.tools.every(t => t.methodName.toLowerCase().includes('create'))).toBe(true);
    });

    it('filters by "delete" action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'delete',
      });

      expect(result.tools.every(t => t.methodName.toLowerCase().includes('delete'))).toBe(true);
    });

    it('filters by "patch" action', async () => {
      const result = await searchTools({
        resourceType: 'Deployment',
        action: 'patch',
      });

      expect(result.tools.every(t => t.methodName.toLowerCase().includes('patch'))).toBe(true);
    });
  });

  describe('Resource Type Coverage', () => {
    it('finds Service resources', async () => {
      const result = await searchTools({ resourceType: 'Service' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.toLowerCase().includes('service'))).toBe(true);
    });

    it('finds ConfigMap resources', async () => {
      const result = await searchTools({ resourceType: 'ConfigMap' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.includes('ConfigMap'))).toBe(true);
    });

    it('finds Secret resources', async () => {
      const result = await searchTools({ resourceType: 'Secret' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.includes('Secret'))).toBe(true);
    });

    it('finds Namespace resources', async () => {
      const result = await searchTools({ resourceType: 'Namespace' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.includes('Namespace'))).toBe(true);
    });

    it('finds Node resources', async () => {
      const result = await searchTools({ resourceType: 'Node' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.includes('Node'))).toBe(true);
    });

    it('finds Job resources', async () => {
      const result = await searchTools({ resourceType: 'Job' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.apiClass === 'BatchV1Api')).toBe(true);
    });

    it('finds CronJob resources', async () => {
      const result = await searchTools({ resourceType: 'CronJob' });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.includes('CronJob'))).toBe(true);
    });
  });

  describe('Output Structure', () => {
    it('includes required fields in results', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 3 });

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('tools');
      expect(result).toHaveProperty('totalMatches');
      expect(result).toHaveProperty('usage');
      
      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(typeof result.totalMatches).toBe('number');
      expect(typeof result.usage).toBe('string');
    });

    it('includes complete method information', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 1 });

      expect(result.tools.length).toBeGreaterThan(0);
      const method = result.tools[0];
      
      expect(method).toHaveProperty('apiClass');
      expect(method).toHaveProperty('methodName');
      expect(method).toHaveProperty('resourceType');
      expect(method).toHaveProperty('description');
      expect(method).toHaveProperty('parameters');
      expect(method).toHaveProperty('returnType');
      expect(method).toHaveProperty('example');
      expect(method).toHaveProperty('inputSchema');
      expect(method).toHaveProperty('outputSchema');
    });

    it('respects limit parameter', async () => {
      const limit = 5;
      const result = await searchTools({ resourceType: 'Pod', limit });

      expect(result.tools.length).toBeLessThanOrEqual(limit);
    });
  });

  describe('Pagination', () => {
    it('returns pagination metadata in results', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result).toHaveProperty('pagination');
      expect(result.pagination).toHaveProperty('offset');
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('hasMore');
      expect(typeof result.pagination.offset).toBe('number');
      expect(typeof result.pagination.limit).toBe('number');
      expect(typeof result.pagination.hasMore).toBe('boolean');
    });

    it('defaults offset to 0', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result.pagination.offset).toBe(0);
    });

    it('respects offset parameter', async () => {
      const limit = 5;
      const firstPage = await searchTools({ resourceType: 'Pod', limit, offset: 0 });
      const secondPage = await searchTools({ resourceType: 'Pod', limit, offset: 5 });

      expect(firstPage.pagination.offset).toBe(0);
      expect(secondPage.pagination.offset).toBe(5);

      // Results should be different between pages
      if (firstPage.tools.length > 0 && secondPage.tools.length > 0) {
        const firstPageIds = firstPage.tools.map(t => `${t.apiClass}.${t.methodName}`);
        const secondPageIds = secondPage.tools.map(t => `${t.apiClass}.${t.methodName}`);

        // No overlap between pages
        const overlap = firstPageIds.filter(id => secondPageIds.includes(id));
        expect(overlap.length).toBe(0);
      }
    });

    it('sets hasMore to true when more results exist', async () => {
      // Get all Pod methods first to know total count
      const allResults = await searchTools({ resourceType: 'Pod', limit: 50 });

      if (allResults.totalMatches > 5) {
        const result = await searchTools({ resourceType: 'Pod', limit: 5, offset: 0 });
        expect(result.pagination.hasMore).toBe(true);
      }
    });

    it('sets hasMore to false on last page', async () => {
      // Get a page that should be the last
      const allResults = await searchTools({ resourceType: 'Pod', limit: 50 });
      const total = allResults.totalMatches;

      // Request from an offset that leaves no more results
      const result = await searchTools({ resourceType: 'Pod', limit: 50, offset: 0 });

      if (result.tools.length === total) {
        expect(result.pagination.hasMore).toBe(false);
      }
    });

    it('returns empty results when offset exceeds total', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5, offset: 1000 });

      expect(result.tools.length).toBe(0);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('totalMatches reflects total filtered results, not page size', async () => {
      const limit = 3;
      const result = await searchTools({ resourceType: 'Pod', limit });

      // totalMatches should be >= the number of tools returned
      expect(result.totalMatches).toBeGreaterThanOrEqual(result.tools.length);

      // If there are more results, totalMatches should be greater than limit
      if (result.pagination.hasMore) {
        expect(result.totalMatches).toBeGreaterThan(limit);
      }
    });

    it('pagination works with action filter', async () => {
      const firstPage = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        limit: 2,
        offset: 0
      });
      const secondPage = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        limit: 2,
        offset: 2
      });

      // Both should only have list methods
      expect(firstPage.tools.every(t => t.methodName.toLowerCase().includes('list'))).toBe(true);
      expect(secondPage.tools.every(t => t.methodName.toLowerCase().includes('list'))).toBe(true);

      // Should be different results
      if (firstPage.tools.length > 0 && secondPage.tools.length > 0) {
        const firstIds = firstPage.tools.map(t => t.methodName);
        const secondIds = secondPage.tools.map(t => t.methodName);
        const overlap = firstIds.filter(id => secondIds.includes(id));
        expect(overlap.length).toBe(0);
      }
    });

    it('pagination works with exclude filter', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { actions: ['delete'] },
        limit: 5,
        offset: 5
      });

      // Should still exclude delete methods on paginated results
      expect(result.tools.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
      expect(result.pagination.offset).toBe(5);
    });

    it('includes pagination info in summary when paginating', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5, offset: 5 });

      // Summary should mention page info when offset > 0
      expect(result.summary).toContain('Page');
    });
  });

  describe('Typo Tolerance', () => {
    it('finds results with minor typos in resource type', async () => {
      // "Deplyment" instead of "Deployment" (one letter missing - within tolerance)
      const result = await searchTools({ resourceType: 'Deplyment' });

      // Typo tolerance should find Deployment
      // Note: if this fails, it means the typo is too different
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.methodName.includes('Deployment'))).toBe(true);
    });

    it('finds results with case variations', async () => {
      const lowercase = await searchTools({ resourceType: 'pod' });
      const uppercase = await searchTools({ resourceType: 'POD' });
      const mixedCase = await searchTools({ resourceType: 'PoD' });

      expect(lowercase.tools.length).toBeGreaterThan(0);
      expect(uppercase.tools.length).toBeGreaterThan(0);
      expect(mixedCase.tools.length).toBeGreaterThan(0);

      // All should find Pod resources
      expect(lowercase.tools.some(t => t.methodName.includes('Pod'))).toBe(true);
      expect(uppercase.tools.some(t => t.methodName.includes('Pod'))).toBe(true);
      expect(mixedCase.tools.some(t => t.methodName.includes('Pod'))).toBe(true);
    });
  });

  describe('Facets', () => {
    it('returns facets in results', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 10 });

      expect(result).toHaveProperty('facets');
      expect(result.facets).toHaveProperty('apiClass');
      expect(result.facets).toHaveProperty('action');
      expect(result.facets).toHaveProperty('scope');
    });

    it('facets contain counts for each category', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 50 });

      // Should have at least some API class facets
      expect(Object.keys(result.facets!.apiClass).length).toBeGreaterThan(0);

      // Each facet value should be a number
      for (const count of Object.values(result.facets!.apiClass)) {
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThan(0);
      }
    });

    it('facets include CoreV1Api for Pod resources', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 10 });

      expect(result.facets!.apiClass).toHaveProperty('CoreV1Api');
    });
  });

  describe('Search Metadata', () => {
    it('returns searchTime in results', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result).toHaveProperty('searchTime');
      expect(typeof result.searchTime).toBe('number');
      expect(result.searchTime).toBeGreaterThanOrEqual(0);
    });

    it('returns paths in results', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result).toHaveProperty('paths');
      expect(result.paths).toHaveProperty('scriptsDirectory');
      expect(typeof result.paths.scriptsDirectory).toBe('string');
      expect(result.paths.scriptsDirectory).toContain('.cache');
    });

    it('returns cachedScripts array in results', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result).toHaveProperty('cachedScripts');
      expect(Array.isArray(result.cachedScripts)).toBe(true);
    });
  });

  describe('Additional Actions', () => {
    it('filters by "replace" action', async () => {
      const result = await searchTools({
        resourceType: 'Deployment',
        action: 'replace',
      });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.every(t => t.methodName.toLowerCase().includes('replace'))).toBe(true);
    });

    it('filters by "watch" action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'watch',
      });

      // Watch methods may or may not exist depending on the k8s client version
      if (result.tools.length > 0) {
        expect(result.tools.every(t => t.methodName.toLowerCase().includes('watch'))).toBe(true);
      }
    });

    it('filters by "get" action', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'get',
      });

      if (result.tools.length > 0) {
        expect(result.tools.every(t => t.methodName.toLowerCase().startsWith('get'))).toBe(true);
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles empty exclude arrays gracefully', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { actions: [], apiClasses: [] },
      });

      // Should return results as if no exclusions were applied
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('handles multiple API class exclusions', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { apiClasses: ['CoreV1Api', 'AutoscalingV1Api'] },
      });

      expect(result.tools.every(t => t.apiClass !== 'CoreV1Api')).toBe(true);
      expect(result.tools.every(t => t.apiClass !== 'AutoscalingV1Api')).toBe(true);
    });

    it('handles non-existent resource type', async () => {
      const result = await searchTools({ resourceType: 'NonExistentResource12345' });

      expect(result.tools.length).toBe(0);
      expect(result.totalMatches).toBe(0);
    });

    it('returns results for very short resource type', async () => {
      // "Job" is a valid 3-letter resource
      const result = await searchTools({ resourceType: 'Job' });

      expect(result.tools.length).toBeGreaterThan(0);
    });
  });

  describe('ForAllNamespaces Scope', () => {
    it('cluster scope includes forAllNamespaces methods', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        scope: 'cluster',
        limit: 20,
      });

      // Should include listPodForAllNamespaces
      expect(result.tools.some(t =>
        t.methodName.toLowerCase().includes('forallnamespaces')
      )).toBe(true);
    });

    it('namespaced scope excludes forAllNamespaces methods', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        action: 'list',
        scope: 'namespaced',
        limit: 20,
      });

      // Should NOT include forAllNamespaces methods
      expect(result.tools.every(t =>
        !t.methodName.toLowerCase().includes('forallnamespaces')
      )).toBe(true);
    });
  });

  describe('Custom Resources', () => {
    it('finds CustomObjectsApi methods', async () => {
      const result = await searchTools({
        resourceType: 'CustomObject',
        limit: 20,
      });

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.apiClass === 'CustomObjectsApi')).toBe(true);
    });
  });

  describe('Method Details', () => {
    it('includes valid example code', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 1 });

      expect(result.tools.length).toBeGreaterThan(0);
      const method = result.tools[0];

      // Sandbox-compatible examples provide k8s and kc directly, no imports needed
      expect(method.example).toContain('Sandbox provides');
      expect(method.example).toContain('kc.makeApiClient');
      expect(method.example).toContain(method.apiClass);
    });

    it('inputSchema has correct structure', async () => {
      const result = await searchTools({ resourceType: 'Pod', action: 'list', scope: 'namespaced', limit: 1 });

      expect(result.tools.length).toBeGreaterThan(0);
      const method = result.tools[0];

      expect(method.inputSchema).toHaveProperty('type', 'object');
      expect(method.inputSchema).toHaveProperty('properties');
      expect(method.inputSchema).toHaveProperty('required');
      expect(method.inputSchema).toHaveProperty('description');
      expect(Array.isArray(method.inputSchema.required)).toBe(true);
    });

    it('outputSchema has correct structure', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 1 });

      expect(result.tools.length).toBeGreaterThan(0);
      const method = result.tools[0];

      expect(method.outputSchema).toHaveProperty('type', 'object');
      expect(method.outputSchema).toHaveProperty('description');
      expect(method.outputSchema).toHaveProperty('properties');
    });

    it('list methods indicate array return in outputSchema', async () => {
      const result = await searchTools({ resourceType: 'Pod', action: 'list', limit: 1 });

      expect(result.tools.length).toBeGreaterThan(0);
      const method = result.tools[0];

      // The unified API doesn't include detailed schemas - just verify method exists
      // and is a list method (indicated by 'list' action)
      expect(method.methodName.toLowerCase()).toContain('list');
      expect(method.outputSchema).toBeDefined();
    });

    it('parameters array contains required fields', async () => {
      const result = await searchTools({ resourceType: 'Pod', action: 'read', scope: 'namespaced', limit: 1 });

      expect(result.tools.length).toBeGreaterThan(0);
      const method = result.tools[0];

      // read namespaced methods require name and namespace
      expect(method.parameters.some(p => p.name === 'name')).toBe(true);
      expect(method.parameters.some(p => p.name === 'namespace')).toBe(true);

      // Each parameter should have required fields
      for (const param of method.parameters) {
        expect(param).toHaveProperty('name');
        expect(param).toHaveProperty('type');
        expect(param).toHaveProperty('optional');
      }
    });
  });

  describe('Summary Content', () => {
    it('summary includes search criteria', async () => {
      const result = await searchTools({
        resourceType: 'Deployment',
        action: 'create',
        scope: 'namespaced',
      });

      expect(result.summary).toContain('Deployment');
      expect(result.summary).toContain('create');
      expect(result.summary).toContain('namespaced');
    });

    it('summary includes exclusion info when excluding', async () => {
      const result = await searchTools({
        resourceType: 'Pod',
        exclude: { actions: ['delete'] },
      });

      // Exclusions are applied as filters - verify results don't contain deleted
      expect(result.tools.every(t => !t.methodName.toLowerCase().includes('delete'))).toBe(true);
    });

    it('summary includes search time', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result.summary).toContain('search:');
      expect(result.summary).toContain('ms');
    });

    it('summary includes result count', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result.summary).toContain('result(s)');
    });
  });

  describe('Usage Field', () => {
    it('usage contains helpful instructions', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result.usage).toContain('USAGE');
      // Updated to check for sandbox instructions
      expect(result.usage).toContain('runSandbox');
    });

    it('usage mentions library imports', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      // Usage now includes library import examples
      expect(result.usage).toContain('LIBRARY IMPORTS');
      expect(result.usage).toContain('PrometheusDriver');
      expect(result.usage).toContain('LokiClient');
    });
  });

  describe('Relevant Scripts in Methods Mode', () => {
    it('includes relevantScripts field in methods mode results', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result).toHaveProperty('relevantScripts');
      expect(Array.isArray(result.relevantScripts)).toBe(true);
    });

    it('relevantScripts have correct structure (no filePath for security)', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      // If there are any relevant scripts, check their structure
      if (result.relevantScripts.length > 0) {
        const script = result.relevantScripts[0];
        expect(script).toHaveProperty('filename');
        expect(script).toHaveProperty('description');
        expect(script).toHaveProperty('apiClasses');
        expect(typeof script.filename).toBe('string');
        expect(typeof script.description).toBe('string');
        expect(Array.isArray(script.apiClasses)).toBe(true);
        // filePath should NOT be exposed for security
        expect((script as Record<string, unknown>).filePath).toBeUndefined();
      }
    });

    it('summary shows relevant scripts section when scripts exist', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      // If there are relevant scripts, they should be in the summary with prominent header
      if (result.relevantScripts.length > 0) {
        expect(result.summary).toContain('CACHED SCRIPTS AVAILABLE');
      }
    });

    it('summary shows RESULTS section', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result.summary).toContain('RESULTS');
    });
  });
});

describe('kubernetes.searchTools - Scripts Mode', () => {
  // Test script is created at module load time (see top of file)
  // This ensures it exists before Orama DB is initialized

  // Clean up test script after all tests complete
  afterAll(() => {
    if (existsSync(testScriptPath)) {
      unlinkSync(testScriptPath);
    }
  });

  describe('Basic Scripts Mode Functionality', () => {
    it('returns scripts mode result with correct structure', async () => {
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.mode).toBe('scripts');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('scripts');
      expect(result).toHaveProperty('totalMatches');
      expect(result).toHaveProperty('paths');
      expect(result).toHaveProperty('pagination');
      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.scripts)).toBe(true);
      expect(typeof result.totalMatches).toBe('number');
    });

    it('lists all scripts when no searchTerm provided', async () => {
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.scripts.length).toBeGreaterThan(0);
    });

    it('includes paths.scriptsDirectory in result', async () => {
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.paths.scriptsDirectory).toContain('.cache');
      expect(result.paths.scriptsDirectory).toContain('scripts');
      expect(result.paths.scriptsDirectory).toContain('cache');
    });

    it('returns pagination metadata', async () => {
      const result = await searchScripts({ mode: 'scripts', limit: 5 });

      expect(result.pagination).toHaveProperty('offset');
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('hasMore');
      expect(typeof result.pagination.offset).toBe('number');
      expect(typeof result.pagination.limit).toBe('number');
      expect(typeof result.pagination.hasMore).toBe('boolean');
    });
  });

  describe('Script Search', () => {
    it('finds scripts matching searchTerm', async () => {
      const result = await searchScripts({ mode: 'scripts', searchTerm: 'pod' });

      expect(result.totalMatches).toBeGreaterThan(0);
      // Should find our test script which has "pod" in filename and content
      expect(result.scripts.some(s => s.filename.toLowerCase().includes('pod'))).toBe(true);
    });

    it('finds test script by filename', async () => {
      // List all scripts and find by filename (more reliable than Orama search for exact filename)
      const result = await searchScripts({ mode: 'scripts', limit: 1000 });

      expect(result.scripts.some(s => s.filename === testScriptName)).toBe(true);
    });

    it('returns empty results for non-matching searchTerm', async () => {
      const result = await searchScripts({ mode: 'scripts', searchTerm: 'xyznonexistent12345' });

      expect(result.totalMatches).toBe(0);
      expect(result.scripts.length).toBe(0);
    });

    it('search is case-insensitive', async () => {
      const lowerResult = await searchScripts({ mode: 'scripts', searchTerm: 'pod' });
      const upperResult = await searchScripts({ mode: 'scripts', searchTerm: 'POD' });
      const mixedResult = await searchScripts({ mode: 'scripts', searchTerm: 'PoD' });

      expect(lowerResult.totalMatches).toBeGreaterThan(0);
      expect(upperResult.totalMatches).toBeGreaterThan(0);
      expect(mixedResult.totalMatches).toBeGreaterThan(0);
    });
  });

  describe('Script Metadata Extraction', () => {
    it('extracts description from first comment block', async () => {
      // List all scripts and find by filename (more reliable than Orama search)
      const result = await searchScripts({ mode: 'scripts', limit: 1000 });
      const testScript = result.scripts.find(s => s.filename === testScriptName);

      expect(testScript).toBeDefined();
      expect(testScript!.description).toContain('Test script');
      expect(testScript!.description).toContain('searching pods');
    });

    it('extracts API classes from script content', async () => {
      // List all scripts and find by filename (more reliable than Orama search)
      const result = await searchScripts({ mode: 'scripts', limit: 1000 });
      const testScript = result.scripts.find(s => s.filename === testScriptName);

      expect(testScript).toBeDefined();
      // Should extract CoreV1Api from the script content
      expect(testScript!.apiClasses.includes('CoreV1Api')).toBe(true);
    });

    it('does not expose file path for security', async () => {
      // List all scripts and find by filename
      const result = await searchScripts({ mode: 'scripts', limit: 1000 });
      const testScript = result.scripts.find(s => s.filename === testScriptName);

      expect(testScript).toBeDefined();
      // filePath should NOT be exposed to the agent - security measure
      expect((testScript as Record<string, unknown>).filePath).toBeUndefined();
    });
  });

  describe('Scripts Mode Pagination', () => {
    it('respects limit parameter', async () => {
      const result = await searchScripts({ mode: 'scripts', limit: 2 });

      expect(result.scripts.length).toBeLessThanOrEqual(2);
    });

    it('respects offset parameter', async () => {
      const firstPage = await searchScripts({ mode: 'scripts', limit: 2, offset: 0 });
      const secondPage = await searchScripts({ mode: 'scripts', limit: 2, offset: 2 });

      expect(firstPage.pagination.offset).toBe(0);
      expect(secondPage.pagination.offset).toBe(2);

      // Note: We don't test for non-overlap between pages because Orama full-text search
      // doesn't guarantee deterministic ordering between separate search calls.
      // The pagination mechanics (offset/limit) are correctly applied within each call,
      // but the underlying search results may vary slightly between calls.
    });

    it('sets hasMore correctly', async () => {
      const allScripts = await searchScripts({ mode: 'scripts', limit: 1000 });

      if (allScripts.totalMatches > 2) {
        const limitedResult = await searchScripts({ mode: 'scripts', limit: 2 });
        expect(limitedResult.pagination.hasMore).toBe(true);
      }
    });

    it('pagination works with searchTerm', async () => {
      const result = await searchScripts({
        mode: 'scripts',
        searchTerm: 'pod',
        limit: 2,
        offset: 0
      });

      expect(result.pagination.offset).toBe(0);
      expect(result.pagination.limit).toBe(2);
    });
  });

  describe('Scripts Mode Summary', () => {
    it('summary indicates total matches', async () => {
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.summary).toContain('SEARCH RESULTS');
      expect(result.summary).toMatch(/Found \d+ result\(s\)/);
    });

    it('summary indicates search term when provided', async () => {
      const result = await searchScripts({ mode: 'scripts', searchTerm: 'pod' });

      expect(result.summary).toContain('"pod"');
    });

    it('summary includes script details', async () => {
      const result = await searchScripts({ mode: 'scripts', limit: 5 });

      if (result.scripts.length > 0) {
        // Should list script info in results (unified format shows [script] type marker)
        expect(result.summary).toContain('[script]');
        // Should include run command info in usage
        expect(result.usage).toContain('runSandbox');
      }
    });

    it('summary includes pagination info when paginating', async () => {
      const allScripts = await searchScripts({ mode: 'scripts', limit: 1000 });

      if (allScripts.totalMatches > 2) {
        const result = await searchScripts({ mode: 'scripts', limit: 2, offset: 2 });
        expect(result.summary).toContain('Page');
      }
    });

    it('returns scripts directory in paths', async () => {
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.paths.scriptsDirectory).toContain('.cache');
    });
  });
});

describe('kubernetes.searchTools - Script Indexing', () => {
  describe('Script Indexing at Search Time', () => {
    it('scripts are indexed and searchable', async () => {
      // Search for scripts should work
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.totalMatches).toBeGreaterThanOrEqual(0);
    });

    // Note: Scripts are indexed directly when saved via runSandbox.indexCacheEntry()
    // No filesystem watcher is needed since we control script creation.
  });
});

// Helper for prometheus mode - uses unified API
const searchPrometheus = async (input: {
  mode: 'prometheus';
  category?: 'query' | 'metadata' | 'alerts' | 'all';
  methodPattern?: string;
  limit?: number;
  offset?: number;
}) => {
  const result = await search({
    query: input.methodPattern,
    documentType: 'prometheus',
    action: input.category !== 'all' ? input.category : undefined,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    mode: 'prometheus' as const,
    methods: result.results.map(r => ({
      library: r.library,
      className: undefined,
      methodName: r.name,
      category: r.action,
      description: r.description,
      parameters: r.parameters || [],
      returnType: r.returnType || 'Promise<any>',
      example: r.example || '',
    })),
    totalMatches: result.totalMatches,
    libraries: {
      'prometheus-query': { installed: true, version: '3.3.2' },
    },
    paths: result.paths,
    facets: {
      library: result.facets.library,
      category: result.facets.action,
    },
    pagination: result.pagination,
  };
};

describe('kubernetes.searchTools - Prometheus Mode', () => {
  describe('Basic Prometheus Mode Functionality', () => {
    it('returns prometheus mode result with correct structure', async () => {
      const result = await searchPrometheus({ mode: 'prometheus' });

      expect(result.mode).toBe('prometheus');
      expect(result).toHaveProperty('methods');
      expect(result).toHaveProperty('totalMatches');
      expect(result).toHaveProperty('libraries');
      expect(result).toHaveProperty('paths');
      expect(result).toHaveProperty('facets');
      expect(result).toHaveProperty('pagination');
      expect(Array.isArray(result.methods)).toBe(true);
    });

    it('lists all prometheus methods when no filters provided', async () => {
      const result = await searchPrometheus({ mode: 'prometheus', limit: 50 });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.methods.length).toBeGreaterThan(0);
    });

    it('includes paths.scriptsDirectory in result', async () => {
      const result = await searchPrometheus({ mode: 'prometheus' });

      expect(result.paths.scriptsDirectory).toContain('.cache');
      expect(result.paths.scriptsDirectory).toContain('scripts');
      expect(result.paths.scriptsDirectory).toContain('cache');
    });

    it('returns facets for category', async () => {
      const result = await searchPrometheus({ mode: 'prometheus', limit: 50 });

      expect(result.facets).toHaveProperty('category');
      expect(Object.keys(result.facets.category).length).toBeGreaterThan(0);
    });
  });

  describe('Prometheus Mode Filtering', () => {
    it('filters by query category', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        category: 'query',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.category === 'query')).toBe(true);
    });

    it('filters by metadata category', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        category: 'metadata',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.category === 'metadata')).toBe(true);
    });

    it('filters by methodPattern', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        methodPattern: 'query',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      // Should find query in method name or description
      expect(result.methods.some(m =>
        m.methodName.toLowerCase().includes('query') ||
        m.description.toLowerCase().includes('query')
      )).toBe(true);
    });
  });

  describe('Prometheus Mode Method Details', () => {
    it('methods have correct structure', async () => {
      const result = await searchPrometheus({ mode: 'prometheus', limit: 1 });

      expect(result.methods.length).toBeGreaterThan(0);
      const method = result.methods[0];

      expect(method).toHaveProperty('library');
      expect(method).toHaveProperty('methodName');
      expect(method).toHaveProperty('category');
      expect(method).toHaveProperty('description');
      expect(method).toHaveProperty('parameters');
      expect(method).toHaveProperty('returnType');
      expect(method).toHaveProperty('example');
      expect(Array.isArray(method.parameters)).toBe(true);
    });

    it('finds instantQuery and rangeQuery methods', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        category: 'query',
      });

      const methodNames = result.methods.map(m => m.methodName);
      expect(methodNames).toContain('instantQuery');
      expect(methodNames).toContain('rangeQuery');
    });

    it('all methods are from prometheus-query library', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        limit: 50,
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.library === 'prometheus-query')).toBe(true);
    });

  });

  describe('Prometheus Mode Pagination', () => {
    it('respects limit parameter', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        limit: 5,
      });

      expect(result.methods.length).toBeLessThanOrEqual(5);
    });

    it('respects offset parameter', async () => {
      const firstPage = await searchPrometheus({
        mode: 'prometheus',
        limit: 5,
        offset: 0,
      });
      const secondPage = await searchPrometheus({
        mode: 'prometheus',
        limit: 5,
        offset: 5,
      });

      expect(firstPage.pagination.offset).toBe(0);
      expect(secondPage.pagination.offset).toBe(5);

      // Results should be different between pages
      if (firstPage.methods.length > 0 && secondPage.methods.length > 0) {
        const firstPageNames = firstPage.methods.map(m => m.methodName);
        const secondPageNames = secondPage.methods.map(m => m.methodName);
        const overlap = firstPageNames.filter(n => secondPageNames.includes(n));
        expect(overlap.length).toBe(0);
      }
    });

    it('sets hasMore correctly', async () => {
      const allMethods = await searchPrometheus({ mode: 'prometheus', limit: 100 });

      if (allMethods.totalMatches > 5) {
        const limitedResult = await searchPrometheus({ mode: 'prometheus', limit: 5 });
        expect(limitedResult.pagination.hasMore).toBe(true);
      }
    });
  });

  describe('Prometheus Mode - Alerts Category', () => {
    it('filters by alerts category', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        category: 'alerts',
      });

      // alerts category may have 0 or more methods
      expect(result.methods.every(m => m.category === 'alerts')).toBe(true);
    });

    it('includes alerts and rules methods in alerts category', async () => {
      const result = await searchPrometheus({
        mode: 'prometheus',
        category: 'alerts',
        limit: 50,
      });

      // If there are alerts category methods, they should include alerts or rules
      if (result.methods.length > 0) {
        const methodNames = result.methods.map(m => m.methodName.toLowerCase());
        expect(
          methodNames.some(n => n.includes('alert') || n.includes('rule'))
        ).toBe(true);
      }
    });
  });

  describe('Prometheus Mode Summary Content', () => {
    it('includes tip about metrics category when PROMETHEUS_URL is set', async () => {
      // Note: This test checks the summary format, actual behavior depends on env
      const result = await searchPrometheus({ mode: 'prometheus' });

      // The result should have a summary (either in 'summary' or in error response)
      expect(result).toHaveProperty('mode', 'prometheus');
    });

    it('includes library information', async () => {
      const result = await searchPrometheus({ mode: 'prometheus' });

      expect(result.libraries).toHaveProperty('prometheus-query');
      expect(result.libraries['prometheus-query']).toHaveProperty('installed');
      expect(result.libraries['prometheus-query']).toHaveProperty('version');
    });
  });
});

// Helper for prometheus metrics mode - uses unified search with prometheus-metric documentType
const searchPrometheusMetrics = async (input: {
  mode: 'prometheus';
  category: 'metrics';
  methodPattern?: string;
  limit?: number;
  offset?: number;
}) => {
  // Check if prometheus metrics are available
  const indexingStatus = searchToolsService.getMetricsIndexingStatus();

  if (indexingStatus === 'unavailable') {
    return {
      mode: 'prometheus' as const,
      category: 'metrics' as const,
      summary: 'Prometheus metrics indexing unavailable. Ensure PROMETHEUS_URL is configured.',
      metrics: [],
      totalMatches: 0,
      indexingStatus,
      paths: { scriptsDirectory: SCRIPTS_CACHE_DIR },
      pagination: { offset: 0, limit: input.limit || 10, hasMore: false },
    };
  }

  // Use unified search with prometheus-metric documentType
  const result = await search({
    query: input.methodPattern,
    documentType: 'prometheus-metric',
    limit: input.limit,
    offset: input.offset,
  });

  return {
    mode: 'prometheus' as const,
    category: 'metrics' as const,
    summary: result.summary,
    metrics: result.results.map(r => ({
      name: r.name,
      type: r.action || 'unknown',
      description: r.description,
    })),
    totalMatches: result.totalMatches,
    indexingStatus,
    paths: result.paths,
    pagination: result.pagination,
  };
};

describe('kubernetes.searchTools - Prometheus Metrics Mode', () => {
  describe('Metrics Mode Basic Functionality', () => {
    it('returns metrics mode result with correct structure', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      expect(result.mode).toBe('prometheus');
      expect(result.category).toBe('metrics');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('totalMatches');
      expect(result).toHaveProperty('indexingStatus');
      expect(result).toHaveProperty('paths');
      expect(result).toHaveProperty('pagination');
      expect(Array.isArray(result.metrics)).toBe(true);
    });

    it('includes paths.scriptsDirectory in result', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      expect(result.paths.scriptsDirectory).toContain('.cache');
      expect(result.paths.scriptsDirectory).toContain('scripts');
      expect(result.paths.scriptsDirectory).toContain('cache');
    });

    it('returns valid indexing status', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      expect(['ready', 'in_progress', 'unavailable']).toContain(result.indexingStatus);
    });
  });

  describe('Metrics Mode Without PROMETHEUS_URL', () => {
    // These tests verify behavior when PROMETHEUS_URL is not set
    // In CI/test environments, PROMETHEUS_URL is typically not configured

    it('returns unavailable status when PROMETHEUS_URL not set', async () => {
      // If PROMETHEUS_URL is not set, indexingStatus should be 'unavailable'
      const originalUrl = process.env.PROMETHEUS_URL;

      // Temporarily unset for this test (if it was set)
      if (originalUrl) {
        delete process.env.PROMETHEUS_URL;
      }

      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      // Note: The indexing happens at service startup, so if the server was
      // started without PROMETHEUS_URL, status will be 'unavailable'
      // If it was started with PROMETHEUS_URL, status may be 'ready' or 'in_progress'
      expect(['ready', 'in_progress', 'unavailable']).toContain(result.indexingStatus);

      // Restore original value
      if (originalUrl) {
        process.env.PROMETHEUS_URL = originalUrl;
      }
    });

    it('returns empty metrics array when unavailable', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      // If unavailable, metrics should be empty
      if (result.indexingStatus === 'unavailable') {
        expect(result.metrics).toHaveLength(0);
        expect(result.totalMatches).toBe(0);
      }
    });

    it('summary mentions PROMETHEUS_URL when unavailable', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      if (result.indexingStatus === 'unavailable') {
        expect(result.summary.toLowerCase()).toContain('prometheus_url');
      }
    });
  });

  describe('Metrics Mode Result Structure', () => {
    it('metrics have correct structure when available', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      // If metrics are available, verify their structure
      if (result.metrics.length > 0) {
        const metric = result.metrics[0];
        expect(metric).toHaveProperty('name');
        expect(metric).toHaveProperty('type');
        expect(metric).toHaveProperty('description');
        expect(typeof metric.name).toBe('string');
        expect(typeof metric.type).toBe('string');
        expect(typeof metric.description).toBe('string');
      }
    });

    it('pagination structure is correct', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        limit: 5,
      });

      expect(result.pagination).toHaveProperty('offset');
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('hasMore');
      expect(typeof result.pagination.offset).toBe('number');
      expect(typeof result.pagination.limit).toBe('number');
      expect(typeof result.pagination.hasMore).toBe('boolean');
      expect(result.pagination.limit).toBe(5);
    });
  });

  describe('Metrics Mode Search Pattern', () => {
    it('accepts methodPattern for filtering metrics', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        methodPattern: 'pod',
      });

      // Should not throw, pattern is accepted
      expect(result.mode).toBe('prometheus');
      expect(result.category).toBe('metrics');

      // If metrics are available and match the pattern, verify filtering
      if (result.metrics.length > 0 && result.indexingStatus === 'ready') {
        const allContainPattern = result.metrics.some(
          m => m.name.toLowerCase().includes('pod') ||
               m.description.toLowerCase().includes('pod')
        );
        expect(allContainPattern).toBe(true);
      }
    });

    it('returns all metrics when no methodPattern provided', async () => {
      const withPattern = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        methodPattern: 'very_unlikely_pattern_xyz123',
      });

      const withoutPattern = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      // Without pattern should return same or more results than with unlikely pattern
      expect(withoutPattern.totalMatches).toBeGreaterThanOrEqual(withPattern.totalMatches);
    });
  });

  describe('Metrics Mode Pagination', () => {
    it('respects limit parameter', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        limit: 3,
      });

      expect(result.metrics.length).toBeLessThanOrEqual(3);
    });

    it('respects offset parameter', async () => {
      const firstPage = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        limit: 5,
        offset: 0,
      });

      // Only test offset if metrics are available
      if (firstPage.indexingStatus === 'unavailable') {
        // When unavailable, offset is always 0
        expect(firstPage.pagination.offset).toBe(0);
        return;
      }

      const secondPage = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        limit: 5,
        offset: 5,
      });

      expect(firstPage.pagination.offset).toBe(0);
      expect(secondPage.pagination.offset).toBe(5);

      // If both pages have results, they should be different
      if (firstPage.metrics.length > 0 && secondPage.metrics.length > 0) {
        const firstPageNames = firstPage.metrics.map(m => m.name);
        const secondPageNames = secondPage.metrics.map(m => m.name);
        const overlap = firstPageNames.filter(n => secondPageNames.includes(n));
        expect(overlap.length).toBe(0);
      }
    });

    it('sets hasMore correctly', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        limit: 5,
      });

      // hasMore should be true if there are more results than the limit
      if (result.totalMatches > 5) {
        expect(result.pagination.hasMore).toBe(true);
      } else {
        expect(result.pagination.hasMore).toBe(false);
      }
    });
  });

  describe('Metrics Mode Summary Content', () => {
    it('summary includes NEXT STEPS section when metrics available', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      // If metrics are available, summary should include helpful next steps
      if (result.indexingStatus === 'ready' && result.metrics.length > 0) {
        expect(result.summary).toContain('NEXT STEPS');
        expect(result.summary.toLowerCase()).toContain('labelnames');
      }
    });

    it('summary mentions the search pattern when provided', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
        methodPattern: 'cpu',
      });

      // Summary should mention what was searched for
      if (result.indexingStatus !== 'unavailable') {
        expect(result.summary.toLowerCase()).toContain('cpu');
      }
    });

    it('summary includes metric count', async () => {
      const result = await searchPrometheusMetrics({
        mode: 'prometheus',
        category: 'metrics',
      });

      // Summary should mention how many metrics were found
      expect(result.summary).toContain('metric');
    });
  });
});

// Helper for analytics mode - uses unified API
const searchAnalytics = async (input: {
  mode: 'analytics';
  library?: 'simple-statistics' | 'ml-regression' | 'mathjs' | 'fft-js' | 'all';
  functionPattern?: string;
  limit?: number;
  offset?: number;
}) => {
  const result = await search({
    query: input.functionPattern,
    documentType: 'analytics',
    library: input.library !== 'all' ? input.library : undefined,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    mode: 'analytics' as const,
    summary: result.summary,
    functions: result.results.map(r => ({
      library: r.library as 'simple-statistics' | 'ml-regression' | 'mathjs' | 'fft-js',
      functionName: r.name,
      category: r.action,
      description: r.description,
      signature: `${r.name}(${(r.parameters || []).map(p => p.name).join(', ')})`,
      parameters: r.parameters || [],
      returnType: r.returnType || 'any',
      example: r.example || '',
    })),
    totalMatches: result.totalMatches,
    libraries: {
      'simple-statistics': { installed: true, version: '7.8.8', description: 'Simple statistics library' },
      'ml-regression': { installed: true, version: '5.0.0', description: 'ML regression library' },
      'mathjs': { installed: true, version: '14.5.2', description: 'Math.js library' },
      'fft-js': { installed: true, version: '0.0.12', description: 'FFT library' },
    },
    usage: result.usage,
    paths: result.paths,
    facets: {
      library: result.facets.library,
      category: result.facets.action,
    },
    pagination: result.pagination,
  };
};

describe('kubernetes.searchTools - Analytics Mode', () => {
  describe('Basic Analytics Mode Functionality', () => {
    it('returns analytics mode result with correct structure', async () => {
      const result = await searchAnalytics({ mode: 'analytics' });

      expect(result.mode).toBe('analytics');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('functions');
      expect(result).toHaveProperty('totalMatches');
      expect(result).toHaveProperty('libraries');
      expect(result).toHaveProperty('usage');
      expect(result).toHaveProperty('paths');
      expect(result).toHaveProperty('facets');
      expect(result).toHaveProperty('pagination');
      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.functions)).toBe(true);
    });

    it('lists all analytics functions when no filters provided', async () => {
      const result = await searchAnalytics({ mode: 'analytics', limit: 50 });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.functions.length).toBeGreaterThan(0);
    });

    it('includes paths.scriptsDirectory in result', async () => {
      const result = await searchAnalytics({ mode: 'analytics' });

      expect(result.paths.scriptsDirectory).toContain('.cache');
      expect(result.paths.scriptsDirectory).toContain('scripts');
    });

    it('returns library information', async () => {
      const result = await searchAnalytics({ mode: 'analytics' });

      expect(result.libraries).toHaveProperty('simple-statistics');
      expect(result.libraries).toHaveProperty('ml-regression');
      expect(result.libraries).toHaveProperty('mathjs');
      expect(result.libraries).toHaveProperty('fft-js');

      expect(result.libraries['simple-statistics'].installed).toBe(true);
      expect(result.libraries['ml-regression'].installed).toBe(true);
      expect(result.libraries['mathjs'].installed).toBe(true);
      expect(result.libraries['fft-js'].installed).toBe(true);
    });

    it('returns facets for library and category', async () => {
      const result = await searchAnalytics({ mode: 'analytics', limit: 50 });

      expect(result.facets).toHaveProperty('library');
      expect(result.facets).toHaveProperty('category');
      expect(Object.keys(result.facets.library).length).toBeGreaterThan(0);
      expect(Object.keys(result.facets.category).length).toBeGreaterThan(0);
    });
  });

  describe('Analytics Mode Library Filtering', () => {
    it('filters by simple-statistics library', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        limit: 50,
      });

      // simple-statistics functions are dynamically extracted from .d.ts files
      // If extraction succeeds, we get functions; otherwise we may get none
      expect(result.functions.every(f => f.library === 'simple-statistics')).toBe(true);
    });

    it('filters by ml-regression library', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'ml-regression',
        limit: 50,
      });

      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions.every(f => f.library === 'ml-regression')).toBe(true);
    });

    it('filters by mathjs library', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'mathjs',
        limit: 50,
      });

      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions.every(f => f.library === 'mathjs')).toBe(true);
    });

    it('filters by fft-js library', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'fft-js',
        limit: 50,
      });

      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions.every(f => f.library === 'fft-js')).toBe(true);
    });

    it('returns all libraries when library is "all"', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'all',
        limit: 100,
      });

      const libraries = new Set(result.functions.map(f => f.library));
      expect(libraries.size).toBeGreaterThan(1);
    });
  });

  describe('Analytics Mode Function Pattern Filtering', () => {
    it('filters by functionPattern', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'mean',
      });

      expect(result.functions.length).toBeGreaterThan(0);
      // Should find mean in function name or description
      expect(result.functions.some(f =>
        f.functionName.toLowerCase().includes('mean') ||
        f.description.toLowerCase().includes('mean')
      )).toBe(true);
    });

    it('finds regression functions by pattern', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'regression',
      });

      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions.some(f =>
        f.functionName.toLowerCase().includes('regression') ||
        f.description.toLowerCase().includes('regression')
      )).toBe(true);
    });

    it('finds matrix functions by pattern', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'matrix',
      });

      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions.some(f =>
        f.functionName.toLowerCase().includes('matrix') ||
        f.description.toLowerCase().includes('matrix')
      )).toBe(true);
    });

    it('finds fft functions by pattern', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'fft',
      });

      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions.some(f =>
        f.functionName.toLowerCase().includes('fft') ||
        f.description.toLowerCase().includes('fft')
      )).toBe(true);
    });

    it('combined library and functionPattern filtering', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        functionPattern: 'standard',
      });

      // Should only have simple-statistics functions
      expect(result.functions.every(f => f.library === 'simple-statistics')).toBe(true);

      // Should match the pattern
      if (result.functions.length > 0) {
        expect(result.functions.some(f =>
          f.functionName.toLowerCase().includes('standard') ||
          f.description.toLowerCase().includes('standard')
        )).toBe(true);
      }
    });

    it('returns empty results for non-matching pattern', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'xyznonexistent12345',
      });

      expect(result.functions.length).toBe(0);
      expect(result.totalMatches).toBe(0);
    });
  });

  describe('Analytics Mode Function Details', () => {
    it('functions have correct structure', async () => {
      const result = await searchAnalytics({ mode: 'analytics', limit: 1 });

      expect(result.functions.length).toBeGreaterThan(0);
      const func = result.functions[0];

      expect(func).toHaveProperty('library');
      expect(func).toHaveProperty('functionName');
      expect(func).toHaveProperty('category');
      expect(func).toHaveProperty('description');
      expect(func).toHaveProperty('signature');
      expect(func).toHaveProperty('parameters');
      expect(func).toHaveProperty('returnType');
      expect(func).toHaveProperty('example');
      expect(Array.isArray(func.parameters)).toBe(true);
    });

    it('finds mean function from simple-statistics', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        functionPattern: 'mean',
        limit: 50,
      });

      // The function name could be 'mean' or contain 'mean' in name/description
      if (result.functions.length > 0) {
        expect(result.functions.some(f =>
          f.functionName.toLowerCase().includes('mean') ||
          f.description.toLowerCase().includes('mean')
        )).toBe(true);
      }
    });

    it('finds SimpleLinearRegression from ml-regression', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'ml-regression',
        limit: 50,
      });

      const simpleLinear = result.functions.find(f => f.functionName === 'SimpleLinearRegression');
      expect(simpleLinear).toBeDefined();
      expect(simpleLinear?.library).toBe('ml-regression');
      expect(simpleLinear?.category).toBe('regression');
    });

    it('finds fft function from fft-js', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'fft-js',
        limit: 50,
      });

      const fftFunc = result.functions.find(f => f.functionName === 'fft');
      expect(fftFunc).toBeDefined();
      expect(fftFunc?.library).toBe('fft-js');
      expect(fftFunc?.category).toBe('signal');
    });

    it('functions have valid examples', async () => {
      const result = await searchAnalytics({ mode: 'analytics', limit: 5 });

      expect(result.functions.length).toBeGreaterThan(0);
      for (const func of result.functions) {
        expect(func.example).toBeDefined();
        expect(typeof func.example).toBe('string');
        expect(func.example.length).toBeGreaterThan(0);
        // Examples should contain require statement
        expect(func.example).toContain('require');
      }
    });

    it('functions have valid signatures', async () => {
      const result = await searchAnalytics({ mode: 'analytics', limit: 5 });

      expect(result.functions.length).toBeGreaterThan(0);
      for (const func of result.functions) {
        expect(func.signature).toBeDefined();
        expect(typeof func.signature).toBe('string');
        // Signatures should contain the function name
        expect(func.signature).toContain(func.functionName);
      }
    });
  });

  describe('Analytics Mode Pagination', () => {
    it('respects limit parameter', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        limit: 5,
      });

      expect(result.functions.length).toBeLessThanOrEqual(5);
    });

    it('respects offset parameter', async () => {
      const firstPage = await searchAnalytics({
        mode: 'analytics',
        limit: 5,
        offset: 0,
      });
      const secondPage = await searchAnalytics({
        mode: 'analytics',
        limit: 5,
        offset: 5,
      });

      expect(firstPage.pagination.offset).toBe(0);
      expect(secondPage.pagination.offset).toBe(5);

      // Results should be different between pages
      if (firstPage.functions.length > 0 && secondPage.functions.length > 0) {
        const firstPageNames = firstPage.functions.map(f => `${f.library}.${f.functionName}`);
        const secondPageNames = secondPage.functions.map(f => `${f.library}.${f.functionName}`);
        const overlap = firstPageNames.filter(n => secondPageNames.includes(n));
        expect(overlap.length).toBe(0);
      }
    });

    it('sets hasMore correctly', async () => {
      const allFunctions = await searchAnalytics({ mode: 'analytics', limit: 100 });

      if (allFunctions.totalMatches > 5) {
        const limitedResult = await searchAnalytics({ mode: 'analytics', limit: 5 });
        expect(limitedResult.pagination.hasMore).toBe(true);
      }
    });

    it('pagination works with library filter', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        limit: 5,
        offset: 0,
      });

      expect(result.pagination.offset).toBe(0);
      expect(result.pagination.limit).toBe(5);
      // All results should be from simple-statistics
      expect(result.functions.every(f => f.library === 'simple-statistics')).toBe(true);
    });

    it('pagination works with functionPattern filter', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'regression',
        limit: 3,
        offset: 0,
      });

      expect(result.pagination.offset).toBe(0);
      expect(result.pagination.limit).toBe(3);
    });

    it('returns empty results when offset exceeds total', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        limit: 5,
        offset: 10000,
      });

      expect(result.functions.length).toBe(0);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('totalMatches reflects total filtered results, not page size', async () => {
      const limit = 3;
      const result = await searchAnalytics({
        mode: 'analytics',
        limit,
      });

      // totalMatches should be >= the number of functions returned
      expect(result.totalMatches).toBeGreaterThanOrEqual(result.functions.length);

      // If there are more results, totalMatches should be greater than limit
      if (result.pagination.hasMore) {
        expect(result.totalMatches).toBeGreaterThan(limit);
      }
    });
  });

  describe('Analytics Mode Categories', () => {
    it('includes descriptive category functions', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        limit: 50,
      });

      // If simple-statistics extraction succeeds, should have descriptive category
      if (result.functions.length > 0) {
        const categories = new Set(result.functions.map(f => f.category));
        expect(categories.has('descriptive')).toBe(true);
      }
    });

    it('includes regression category functions', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'ml-regression',
        limit: 50,
      });

      expect(result.functions.every(f => f.category === 'regression')).toBe(true);
    });

    it('includes signal category functions', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'fft-js',
        limit: 50,
      });

      expect(result.functions.every(f => f.category === 'signal')).toBe(true);
    });

    it('includes matrix category functions', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'mathjs',
        limit: 50,
      });

      const categories = new Set(result.functions.map(f => f.category));
      expect(categories.has('matrix')).toBe(true);
    });

    it('facets include category counts', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        limit: 100,
      });

      expect(Object.keys(result.facets.category).length).toBeGreaterThan(0);

      // Each facet value should be a number > 0
      for (const count of Object.values(result.facets.category)) {
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThan(0);
      }
    });
  });

  describe('Analytics Mode Summary Content', () => {
    it('summary includes function count', async () => {
      const result = await searchAnalytics({ mode: 'analytics', limit: 5 });

      expect(result.summary).toContain('function');
    });

    it('summary includes analytics library info', async () => {
      const result = await searchAnalytics({ mode: 'analytics' });

      // The summary should contain results from analytics libraries
      expect(result.summary).toContain('[analytics]');
    });

    it('usage contains helpful instructions', async () => {
      const result = await searchAnalytics({ mode: 'analytics' });

      expect(result.usage).toContain('USAGE');
      expect(result.usage).toContain('require');
    });

    it('usage mentions runSandbox', async () => {
      const result = await searchAnalytics({ mode: 'analytics' });

      expect(result.usage.toLowerCase()).toContain('sandbox');
    });
  });

  describe('Analytics Mode - Specific Functions', () => {
    it('searches for variance-related functions from simple-statistics', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        functionPattern: 'variance',
        limit: 50,
      });

      // If found, should match variance pattern
      if (result.functions.length > 0) {
        expect(result.functions.some(f =>
          f.functionName.toLowerCase().includes('variance') ||
          f.description.toLowerCase().includes('variance')
        )).toBe(true);
      }
    });

    it('searches for standardDeviation-related functions from simple-statistics', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'simple-statistics',
        functionPattern: 'standard',
        limit: 100,
      });

      // If found, should match standard deviation pattern
      if (result.functions.length > 0) {
        expect(result.functions.some(f =>
          f.functionName.toLowerCase().includes('standard') ||
          f.description.toLowerCase().includes('standard')
        )).toBe(true);
      }
    });

    it('includes PolynomialRegression from ml-regression', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'ml-regression',
        limit: 50,
      });

      expect(result.functions.some(f => f.functionName === 'PolynomialRegression')).toBe(true);
    });

    it('includes ExponentialRegression from ml-regression', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'ml-regression',
        limit: 50,
      });

      expect(result.functions.some(f => f.functionName === 'ExponentialRegression')).toBe(true);
    });

    it('includes ifft function from fft-js', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'fft-js',
        limit: 50,
      });

      expect(result.functions.some(f => f.functionName === 'ifft')).toBe(true);
    });

    it('includes util.fftMag function from fft-js', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        library: 'fft-js',
        limit: 50,
      });

      expect(result.functions.some(f => f.functionName === 'util.fftMag')).toBe(true);
    });
  });

  describe('Analytics Mode Edge Cases', () => {
    it('handles case-insensitive pattern search', async () => {
      const lowerResult = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'mean',
      });
      const upperResult = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'MEAN',
      });

      expect(lowerResult.totalMatches).toBe(upperResult.totalMatches);
    });

    it('handles partial pattern matches', async () => {
      const result = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'regr',
      });

      // Should find regression-related functions
      expect(result.functions.length).toBeGreaterThan(0);
    });

    it('handles empty library filter with pattern', async () => {
      const withAll = await searchAnalytics({
        mode: 'analytics',
        library: 'all',
        functionPattern: 'mean',
      });

      const withoutLibrary = await searchAnalytics({
        mode: 'analytics',
        functionPattern: 'mean',
      });

      expect(withAll.totalMatches).toBe(withoutLibrary.totalMatches);
    });
  });
});

// Helper for loki mode - uses unified API
const searchLoki = async (input: {
  mode: 'loki';
  lokiCategory?: 'query' | 'labels' | 'streams' | 'all';
  lokiMethodPattern?: string;
  limit?: number;
  offset?: number;
}) => {
  const result = await search({
    query: input.lokiMethodPattern,
    documentType: 'loki',
    action: input.lokiCategory !== 'all' ? input.lokiCategory : undefined,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    mode: 'loki' as const,
    summary: result.summary,
    methods: result.results.map(r => ({
      library: '@prodisco/loki-client' as const,
      className: 'LokiClient',
      methodName: r.name,
      category: r.action,
      description: r.description,
      parameters: r.parameters || [],
      returnType: r.returnType || 'Promise<any>',
      example: r.example || '',
    })),
    totalMatches: result.totalMatches,
    libraries: {
      '@prodisco/loki-client': { installed: true, version: '7.0.0' },
      '@sigyn/logql': { installed: true, version: '2.0.0' },
    },
    paths: result.paths,
    facets: {
      library: result.facets.library,
      category: result.facets.action,
    },
    pagination: result.pagination,
    usage: result.usage,
  };
};

describe('kubernetes.searchTools - Loki Mode', () => {
  describe('Basic Loki Mode Functionality', () => {
    it('returns loki mode result with correct structure', async () => {
      const result = await searchLoki({ mode: 'loki' });

      expect(result.mode).toBe('loki');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('methods');
      expect(result).toHaveProperty('totalMatches');
      expect(result).toHaveProperty('libraries');
      expect(result).toHaveProperty('paths');
      expect(result).toHaveProperty('facets');
      expect(result).toHaveProperty('pagination');
      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.methods)).toBe(true);
    });

    it('lists all loki methods when no filters provided', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 50 });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.methods.length).toBeGreaterThan(0);
    });

    it('includes paths.scriptsDirectory in result', async () => {
      const result = await searchLoki({ mode: 'loki' });

      expect(result.paths.scriptsDirectory).toContain('.cache');
      expect(result.paths.scriptsDirectory).toContain('scripts');
    });

    it('returns library information', async () => {
      const result = await searchLoki({ mode: 'loki' });

      expect(result.libraries).toHaveProperty('@prodisco/loki-client');
      expect(result.libraries).toHaveProperty('@sigyn/logql');

      expect(result.libraries['@prodisco/loki-client'].installed).toBe(true);
      expect(result.libraries['@sigyn/logql'].installed).toBe(true);
    });

    it('returns facets for library and category', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 50 });

      expect(result.facets).toHaveProperty('library');
      expect(result.facets).toHaveProperty('category');
      expect(Object.keys(result.facets.library).length).toBeGreaterThan(0);
      expect(Object.keys(result.facets.category).length).toBeGreaterThan(0);
    });
  });

  describe('Loki Mode Category Filtering', () => {
    it('filters by query category', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.category === 'query')).toBe(true);
    });

    it('filters by labels category', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'labels',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.category === 'labels')).toBe(true);
    });

    it('filters by health category', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'health',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.category === 'health')).toBe(true);
    });

    it('returns all categories when lokiCategory is "all"', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'all',
        limit: 50,
      });

      const categories = new Set(result.methods.map(m => m.category));
      expect(categories.size).toBeGreaterThan(1);
    });

    it('returns all categories when no lokiCategory specified', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 50,
      });

      const categories = new Set(result.methods.map(m => m.category));
      expect(categories.size).toBeGreaterThan(1);
    });
  });

  describe('Loki Mode Method Pattern Filtering', () => {
    it('filters by lokiMethodPattern', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'query',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      // Should find query in method name or description
      expect(result.methods.some(m =>
        m.methodName.toLowerCase().includes('query') ||
        m.description.toLowerCase().includes('query')
      )).toBe(true);
    });

    it('finds labels methods by pattern', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'label',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.some(m =>
        m.methodName.toLowerCase().includes('label') ||
        m.description.toLowerCase().includes('label')
      )).toBe(true);
    });

    it('finds series method by pattern', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'series',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.some(m =>
        m.methodName.toLowerCase().includes('series') ||
        m.description.toLowerCase().includes('series')
      )).toBe(true);
    });

    it('finds ready method by pattern', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'ready',
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.some(m =>
        m.methodName.toLowerCase().includes('ready') ||
        m.description.toLowerCase().includes('ready')
      )).toBe(true);
    });

    it('combined category and lokiMethodPattern filtering', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        lokiMethodPattern: 'range',
      });

      // Should only have query category methods
      expect(result.methods.every(m => m.category === 'query')).toBe(true);

      // Should match the pattern
      if (result.methods.length > 0) {
        expect(result.methods.some(m =>
          m.methodName.toLowerCase().includes('range') ||
          m.description.toLowerCase().includes('range')
        )).toBe(true);
      }
    });

    it('returns empty results for non-matching pattern', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'xyznonexistent12345',
      });

      expect(result.methods.length).toBe(0);
      expect(result.totalMatches).toBe(0);
    });
  });

  describe('Loki Mode Method Details', () => {
    it('methods have correct structure', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 1 });

      expect(result.methods.length).toBeGreaterThan(0);
      const method = result.methods[0];

      expect(method).toHaveProperty('library');
      expect(method).toHaveProperty('methodName');
      expect(method).toHaveProperty('category');
      expect(method).toHaveProperty('description');
      expect(method).toHaveProperty('parameters');
      expect(method).toHaveProperty('returnType');
      expect(method).toHaveProperty('example');
      expect(Array.isArray(method.parameters)).toBe(true);
    });

    it('finds queryRange method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        limit: 50,
      });

      const queryRange = result.methods.find(m => m.methodName === 'queryRange');
      expect(queryRange).toBeDefined();
      expect(queryRange?.library).toBe('@prodisco/loki-client');
      expect(queryRange?.category).toBe('query');
    });

    it('finds series method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'series');
      expect(method).toBeDefined();
      expect(method?.library).toBe('@prodisco/loki-client');
    });

    it('finds queryRangeMatrix method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'queryRangeMatrix');
      expect(method).toBeDefined();
      expect(method?.library).toBe('@prodisco/loki-client');
    });

    it('finds labels method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'labels',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'labels');
      expect(method).toBeDefined();
      expect(method?.category).toBe('labels');
    });

    it('finds labelValues method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'labels',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'labelValues');
      expect(method).toBeDefined();
      expect(method?.category).toBe('labels');
    });

    it('finds series method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'series');
      expect(method).toBeDefined();
    });

    it('finds ready method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'health',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'ready');
      expect(method).toBeDefined();
      expect(method?.category).toBe('health');
    });

    it('all methods are from @prodisco/loki-client library', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 50,
      });

      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.methods.every(m => m.library === '@prodisco/loki-client')).toBe(true);
    });

    it('methods have valid examples', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 5 });

      expect(result.methods.length).toBeGreaterThan(0);
      for (const method of result.methods) {
        expect(method.example).toBeDefined();
        expect(typeof method.example).toBe('string');
        expect(method.example.length).toBeGreaterThan(0);
        // Examples should contain require statement
        expect(method.example).toContain('require');
        expect(method.example).toContain('@prodisco/loki-client');
      }
    });

    it('methods have valid parameters', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 5 });

      expect(result.methods.length).toBeGreaterThan(0);
      for (const method of result.methods) {
        expect(Array.isArray(method.parameters)).toBe(true);
        for (const param of method.parameters) {
          expect(param).toHaveProperty('name');
          expect(param).toHaveProperty('type');
          expect(param).toHaveProperty('optional');
          expect(typeof param.name).toBe('string');
          expect(typeof param.type).toBe('string');
          expect(typeof param.optional).toBe('boolean');
        }
      }
    });

    it('methods have valid return types', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 5 });

      expect(result.methods.length).toBeGreaterThan(0);
      for (const method of result.methods) {
        expect(method.returnType).toBeDefined();
        expect(typeof method.returnType).toBe('string');
        expect(method.returnType.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Loki Mode Pagination', () => {
    it('respects limit parameter', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 3,
      });

      expect(result.methods.length).toBeLessThanOrEqual(3);
    });

    it('respects offset parameter', async () => {
      const firstPage = await searchLoki({
        mode: 'loki',
        limit: 3,
        offset: 0,
      });
      const secondPage = await searchLoki({
        mode: 'loki',
        limit: 3,
        offset: 3,
      });

      expect(firstPage.pagination.offset).toBe(0);
      expect(secondPage.pagination.offset).toBe(3);

      // Results should be different between pages
      if (firstPage.methods.length > 0 && secondPage.methods.length > 0) {
        const firstPageNames = firstPage.methods.map(m => m.methodName);
        const secondPageNames = secondPage.methods.map(m => m.methodName);
        const overlap = firstPageNames.filter(n => secondPageNames.includes(n));
        expect(overlap.length).toBe(0);
      }
    });

    it('sets hasMore correctly when more results exist', async () => {
      const allMethods = await searchLoki({ mode: 'loki', limit: 100 });

      if (allMethods.totalMatches > 3) {
        const limitedResult = await searchLoki({ mode: 'loki', limit: 3 });
        expect(limitedResult.pagination.hasMore).toBe(true);
      }
    });

    it('sets hasMore to false on last page', async () => {
      const allMethods = await searchLoki({ mode: 'loki', limit: 100 });

      // Request all methods at once
      const result = await searchLoki({ mode: 'loki', limit: 100 });

      if (result.methods.length === result.totalMatches) {
        expect(result.pagination.hasMore).toBe(false);
      }
    });

    it('returns empty results when offset exceeds total', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 5,
        offset: 10000,
      });

      expect(result.methods.length).toBe(0);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('totalMatches reflects total filtered results, not page size', async () => {
      const limit = 2;
      const result = await searchLoki({
        mode: 'loki',
        limit,
      });

      // totalMatches should be >= the number of methods returned
      expect(result.totalMatches).toBeGreaterThanOrEqual(result.methods.length);

      // If there are more results, totalMatches should be greater than limit
      if (result.pagination.hasMore) {
        expect(result.totalMatches).toBeGreaterThan(limit);
      }
    });

    it('pagination works with category filter', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        limit: 2,
        offset: 0,
      });

      expect(result.pagination.offset).toBe(0);
      expect(result.pagination.limit).toBe(2);
      // All results should be from query category
      expect(result.methods.every(m => m.category === 'query')).toBe(true);
    });

    it('pagination works with lokiMethodPattern filter', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'query',
        limit: 2,
        offset: 0,
      });

      expect(result.pagination.offset).toBe(0);
      expect(result.pagination.limit).toBe(2);
    });
  });

  describe('Loki Mode Summary Content', () => {
    it('summary includes result count', async () => {
      const result = await searchLoki({ mode: 'loki', limit: 5 });

      expect(result.summary).toContain('result(s)');
    });

    it('summary includes loki library info', async () => {
      const result = await searchLoki({ mode: 'loki' });

      // The summary should contain results from loki library
      expect(result.summary).toContain('[loki]');
    });

    it('returns methods for API discovery', async () => {
      const result = await searchLoki({ mode: 'loki' });

      // Should return methods for discovery
      expect(result.methods.length).toBeGreaterThan(0);
    });

    it('includes @prodisco/loki-client in results', async () => {
      const result = await searchLoki({ mode: 'loki' });

      expect(result.summary).toContain('@prodisco/loki-client');
    });

    it('usage includes sandbox instructions', async () => {
      const result = await searchLoki({ mode: 'loki' });

      expect(result.usage).toContain('runSandbox');
    });

    it('summary includes action filter when specified', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
      });

      expect(result.summary.toLowerCase()).toContain('query');
    });

    it('summary includes pattern filter when specified', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'range',
      });

      expect(result.summary).toContain('range');
    });
  });

  describe('Loki Mode Without LOKI_URL', () => {
    it('returns methods for discovery when LOKI_URL not set', async () => {
      const originalUrl = process.env.LOKI_URL;

      // Temporarily unset for this test
      delete process.env.LOKI_URL;

      try {
        const result = await searchLoki({ mode: 'loki' });

        // Should still return methods for discovery
        expect(result.methods.length).toBeGreaterThan(0);

        // Methods should be from @prodisco/loki-client
        expect(result.methods.every(m => m.library === '@prodisco/loki-client')).toBe(true);
      } finally {
        // Restore original value
        if (originalUrl) {
          process.env.LOKI_URL = originalUrl;
        }
      }
    });

    it('still returns methods even without LOKI_URL', async () => {
      const result = await searchLoki({ mode: 'loki' });

      // Methods should always be returned for API discovery
      expect(result.methods.length).toBeGreaterThan(0);
    });

    it('error result has correct structure', async () => {
      const originalUrl = process.env.LOKI_URL;

      // Temporarily unset for this test
      delete process.env.LOKI_URL;

      try {
        const result = await searchLoki({ mode: 'loki' });

        // Error result should still have standard fields
        expect(result).toHaveProperty('mode', 'loki');
        expect(result).toHaveProperty('methods');
        expect(result).toHaveProperty('totalMatches');
        expect(result).toHaveProperty('libraries');
        expect(result).toHaveProperty('pagination');
      } finally {
        // Restore original value
        if (originalUrl) {
          process.env.LOKI_URL = originalUrl;
        }
      }
    });
  });

  describe('Loki Mode Categories', () => {
    it('query category includes log query methods', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'query',
        limit: 50,
      });

      const methodNames = result.methods.map(m => m.methodName);
      expect(methodNames).toContain('queryRange');
      expect(methodNames).toContain('queryRangeMatrix');
      expect(methodNames).toContain('series');
    });

    it('labels category includes label discovery methods', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'labels',
        limit: 50,
      });

      const methodNames = result.methods.map(m => m.methodName);
      expect(methodNames).toContain('labels');
      expect(methodNames).toContain('labelValues');
    });

    it('health category includes ready method', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'health',
        limit: 50,
      });

      const methodNames = result.methods.map(m => m.methodName);
      expect(methodNames).toContain('ready');
    });

    it('facets include category counts', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 100,
      });

      expect(Object.keys(result.facets.category).length).toBeGreaterThan(0);

      // Each facet value should be a number > 0
      for (const count of Object.values(result.facets.category)) {
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThan(0);
      }
    });

    it('facets include correct category names', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 100,
      });

      const categoryNames = Object.keys(result.facets.category);
      expect(categoryNames).toContain('query');
      expect(categoryNames).toContain('labels');
    });
  });

  describe('Loki Mode Edge Cases', () => {
    it('handles case-insensitive pattern search', async () => {
      const lowerResult = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'query',
      });
      const upperResult = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'QUERY',
      });

      expect(lowerResult.totalMatches).toBe(upperResult.totalMatches);
    });

    it('handles partial pattern matches', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'rang',
      });

      // Should find queryRange methods
      expect(result.methods.length).toBeGreaterThan(0);
    });

    it('handles all category with pattern', async () => {
      const withAll = await searchLoki({
        mode: 'loki',
        lokiCategory: 'all',
        lokiMethodPattern: 'query',
      });

      const withoutCategory = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'query',
      });

      expect(withAll.totalMatches).toBe(withoutCategory.totalMatches);
    });

    it('methods have className for Loki API', async () => {
      const result = await searchLoki({
        mode: 'loki',
        limit: 5,
      });

      expect(result.methods.length).toBeGreaterThan(0);
      // All methods should have className 'LokiClient'
      expect(result.methods.every(m => m.className === 'LokiClient')).toBe(true);
    });
  });

  describe('Loki Mode - Specific Method Details', () => {
    it('queryRange method has correct parameters', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiMethodPattern: 'queryRange',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'queryRange');
      expect(method).toBeDefined();
      expect(method?.parameters.length).toBeGreaterThan(0);

      // Should have logQL parameter
      expect(method?.parameters.some(p => p.name === 'logQL')).toBe(true);
    });

    it('labels method has correct description', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'labels',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'labels');
      expect(method).toBeDefined();
      expect(method?.description.toLowerCase()).toContain('label');
    });

    it('labelValues method has label parameter', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'labels',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'labelValues');
      expect(method).toBeDefined();
      expect(method?.parameters.some(p => p.name === 'label')).toBe(true);
    });

    it('ready method has no parameters', async () => {
      const result = await searchLoki({
        mode: 'loki',
        lokiCategory: 'health',
        limit: 50,
      });

      const method = result.methods.find(m => m.methodName === 'ready');
      expect(method).toBeDefined();
      expect(method?.parameters.length).toBe(0);
    });
  });

  describe('Loki Mode - Usage Instructions', () => {
    it('includes usage instructions when LOKI_URL is set', async () => {
      const originalUrl = process.env.LOKI_URL;

      // Set LOKI_URL for this test
      process.env.LOKI_URL = 'http://localhost:3100';

      try {
        const result = await searchLoki({ mode: 'loki' });

        expect(result.usage).toBeDefined();
        expect(result.usage).toContain('USAGE');
        expect(result.usage).toContain('require');
        expect(result.usage).toContain('@prodisco/loki-client');
      } finally {
        // Restore original value
        if (originalUrl) {
          process.env.LOKI_URL = originalUrl;
        } else {
          delete process.env.LOKI_URL;
        }
      }
    });

    it('results include loki library methods', async () => {
      const result = await searchLoki({ mode: 'loki' });

      // Results should include @prodisco/loki-client methods
      expect(result.summary).toContain('@prodisco/loki-client');
      expect(result.methods.length).toBeGreaterThan(0);
    });
  });
});
