import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

import { searchToolsTool } from '../tools/kubernetes/searchTools.js';

// Helper to work around TypeScript/Zod type inference limitation with .optional().default()
// The 'scope' parameter has a default value but TypeScript doesn't infer it as optional in the input type
const searchTools = searchToolsTool.execute.bind(searchToolsTool) as (input: {
  resourceType: string;
  action?: string;
  scope?: 'namespaced' | 'cluster' | 'all';
  exclude?: {
    actions?: string[];
    apiClasses?: string[];
  };
  limit?: number;
  offset?: number;
}) => ReturnType<typeof searchToolsTool.execute>;

// Helper for scripts mode
const searchScripts = searchToolsTool.execute.bind(searchToolsTool) as (input: {
  mode: 'scripts';
  searchTerm?: string;
  limit?: number;
  offset?: number;
}) => Promise<{
  mode: 'scripts';
  summary: string;
  scripts: Array<{
    filename: string;
    filePath: string;
    description: string;
    apiClasses: string[];
  }>;
  totalMatches: number;
  paths: { scriptsDirectory: string };
  pagination: { offset: number; limit: number; hasMore: boolean };
}>;

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
      expect(result.tools.some((tool) => tool.resourceType.toLowerCase().includes('pod'))).toBe(true);
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
      // createNamespacedBinding has resourceType "Binding"
      // createNamespacedPodBinding has resourceType "PodBinding"
      expect(result.tools.some(t =>
        t.resourceType.includes('Binding')
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
      expect(result.tools.some(t => t.resourceType.toLowerCase().includes('service'))).toBe(true);
    });

    it('finds ConfigMap resources', async () => {
      const result = await searchTools({ resourceType: 'ConfigMap' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.resourceType === 'ConfigMap')).toBe(true);
    });

    it('finds Secret resources', async () => {
      const result = await searchTools({ resourceType: 'Secret' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.resourceType === 'Secret')).toBe(true);
    });

    it('finds Namespace resources', async () => {
      const result = await searchTools({ resourceType: 'Namespace' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.resourceType === 'Namespace')).toBe(true);
    });

    it('finds Node resources', async () => {
      const result = await searchTools({ resourceType: 'Node' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.resourceType === 'Node')).toBe(true);
    });

    it('finds Job resources', async () => {
      const result = await searchTools({ resourceType: 'Job' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.apiClass === 'BatchV1Api')).toBe(true);
    });

    it('finds CronJob resources', async () => {
      const result = await searchTools({ resourceType: 'CronJob' });
      
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.resourceType === 'CronJob')).toBe(true);
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
      expect(result.summary).toContain('Page:');
    });
  });

  describe('Typo Tolerance', () => {
    it('finds results with minor typos in resource type', async () => {
      // "Deplyment" instead of "Deployment" (one letter missing - within tolerance)
      const result = await searchTools({ resourceType: 'Deplyment' });

      // Typo tolerance should find Deployment
      // Note: if this fails, it means the typo is too different
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some(t => t.resourceType === 'Deployment')).toBe(true);
    });

    it('finds results with case variations', async () => {
      const lowercase = await searchTools({ resourceType: 'pod' });
      const uppercase = await searchTools({ resourceType: 'POD' });
      const mixedCase = await searchTools({ resourceType: 'PoD' });

      expect(lowercase.tools.length).toBeGreaterThan(0);
      expect(uppercase.tools.length).toBeGreaterThan(0);
      expect(mixedCase.tools.length).toBeGreaterThan(0);

      // All should find Pod resources
      expect(lowercase.tools.some(t => t.resourceType === 'Pod')).toBe(true);
      expect(uppercase.tools.some(t => t.resourceType === 'Pod')).toBe(true);
      expect(mixedCase.tools.some(t => t.resourceType === 'Pod')).toBe(true);
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
      expect(result.paths.scriptsDirectory).toContain('.prodisco');
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

      expect(method.example).toContain('import * as k8s');
      expect(method.example).toContain('KubeConfig');
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

      expect(method.outputSchema.description).toContain('items');
      expect(method.outputSchema.properties.items.type).toBe('array');
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

      expect(result.summary).toContain('excluding');
      expect(result.summary).toContain('delete');
    });

    it('summary includes search time', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result.summary).toContain('search:');
      expect(result.summary).toContain('ms');
    });

    it('summary includes method count', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result.summary).toContain('method(s)');
    });
  });

  describe('Usage Field', () => {
    it('usage contains helpful instructions', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result.usage).toContain('USAGE');
      expect(result.usage).toContain('await');
      expect(result.usage).toContain('@kubernetes/client-node');
    });

    it('usage mentions scripts directory', async () => {
      const result = await searchTools({ resourceType: 'Pod' });

      expect(result.usage).toContain(result.paths.scriptsDirectory);
    });
  });

  describe('Relevant Scripts in Methods Mode', () => {
    it('includes relevantScripts field in methods mode results', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result).toHaveProperty('relevantScripts');
      expect(Array.isArray(result.relevantScripts)).toBe(true);
    });

    it('relevantScripts have correct structure', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      // If there are any relevant scripts, check their structure
      if (result.relevantScripts.length > 0) {
        const script = result.relevantScripts[0];
        expect(script).toHaveProperty('filename');
        expect(script).toHaveProperty('filePath');
        expect(script).toHaveProperty('description');
        expect(script).toHaveProperty('apiClasses');
        expect(typeof script.filename).toBe('string');
        expect(typeof script.filePath).toBe('string');
        expect(typeof script.description).toBe('string');
        expect(Array.isArray(script.apiClasses)).toBe(true);
      }
    });

    it('summary shows relevant scripts section when scripts exist', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      // If there are relevant scripts, they should be in the summary
      if (result.relevantScripts.length > 0) {
        expect(result.summary).toContain('RELEVANT CACHED SCRIPTS');
      }
    });

    it('summary shows API METHODS section', async () => {
      const result = await searchTools({ resourceType: 'Pod', limit: 5 });

      expect(result.summary).toContain('API METHODS');
    });
  });
});

describe('kubernetes.searchTools - Scripts Mode', () => {
  const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');
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

  // Create a test script before tests run
  beforeAll(async () => {
    // Ensure directory exists
    if (!existsSync(scriptsDirectory)) {
      mkdirSync(scriptsDirectory, { recursive: true });
    }
    // Create test script
    writeFileSync(testScriptPath, testScriptContent);
    // Wait for the watcher to pick up the file and index it
    // Poll until the script appears in search results (max 5 seconds)
    const maxWaitMs = 5000;
    const pollIntervalMs = 100;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const result = await searchScripts({ mode: 'scripts', limit: 100 });
      if (result.scripts.some(s => s.filename === testScriptName)) {
        return; // Script is indexed, we can proceed
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    // If we get here, the script wasn't indexed in time, but tests will still run
    // and fail with a clear error message
  });

  // Clean up test script after tests
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

      expect(result.paths.scriptsDirectory).toContain('.prodisco');
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
      const result = await searchScripts({ mode: 'scripts', limit: 100 });

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
      const result = await searchScripts({ mode: 'scripts', limit: 100 });
      const testScript = result.scripts.find(s => s.filename === testScriptName);

      expect(testScript).toBeDefined();
      expect(testScript!.description).toContain('Test script');
      expect(testScript!.description).toContain('searching pods');
    });

    it('extracts API classes from script content', async () => {
      // List all scripts and find by filename (more reliable than Orama search)
      const result = await searchScripts({ mode: 'scripts', limit: 100 });
      const testScript = result.scripts.find(s => s.filename === testScriptName);

      expect(testScript).toBeDefined();
      // Should extract CoreV1Api from the script content
      expect(testScript!.apiClasses.includes('CoreV1Api')).toBe(true);
    });

    it('provides full file path', async () => {
      // List all scripts and find by filename (more reliable than Orama search)
      const result = await searchScripts({ mode: 'scripts', limit: 100 });
      const testScript = result.scripts.find(s => s.filename === testScriptName);

      expect(testScript).toBeDefined();
      expect(testScript!.filePath).toBe(testScriptPath);
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

      // If both pages have results, they should be different
      if (firstPage.scripts.length > 0 && secondPage.scripts.length > 0) {
        const firstFilenames = firstPage.scripts.map(s => s.filename);
        const secondFilenames = secondPage.scripts.map(s => s.filename);
        const overlap = firstFilenames.filter(f => secondFilenames.includes(f));
        expect(overlap.length).toBe(0);
      }
    });

    it('sets hasMore correctly', async () => {
      const allScripts = await searchScripts({ mode: 'scripts', limit: 100 });

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

      expect(result.summary).toContain('CACHED SCRIPTS');
      expect(result.summary).toMatch(/\(\d+ total\)/);
    });

    it('summary indicates search term when provided', async () => {
      const result = await searchScripts({ mode: 'scripts', searchTerm: 'pod' });

      expect(result.summary).toContain('matching "pod"');
    });

    it('summary includes script details', async () => {
      const result = await searchScripts({ mode: 'scripts', limit: 5 });

      if (result.scripts.length > 0) {
        // Should list script filenames
        expect(result.summary).toContain('.ts');
        // Should include run command
        expect(result.summary).toContain('npx tsx');
      }
    });

    it('summary includes pagination info when paginating', async () => {
      const allScripts = await searchScripts({ mode: 'scripts', limit: 100 });

      if (allScripts.totalMatches > 2) {
        const result = await searchScripts({ mode: 'scripts', limit: 2, offset: 2 });
        expect(result.summary).toContain('Page');
      }
    });

    it('summary includes scripts directory path', async () => {
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.summary).toContain('Scripts directory:');
      expect(result.summary).toContain('.prodisco');
    });
  });
});

describe('kubernetes.searchTools - Script Indexing', () => {
  const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');

  describe('Script Indexing at Search Time', () => {
    it('scripts are indexed and searchable', async () => {
      // Search for scripts should work
      const result = await searchScripts({ mode: 'scripts' });

      expect(result.totalMatches).toBeGreaterThanOrEqual(0);
    });

    it('newly created scripts are indexed', async () => {
      const newScriptName = 'temp-test-deployment-script.ts';
      const newScriptPath = join(scriptsDirectory, newScriptName);
      const newScriptContent = `// Temporary test script for deployments
import * as k8s from '@kubernetes/client-node';
const api = kc.makeApiClient(k8s.AppsV1Api);
`;

      try {
        // Create a new script
        writeFileSync(newScriptPath, newScriptContent);

        // Wait for watcher to pick it up
        await new Promise(resolve => setTimeout(resolve, 500));

        // List all scripts and find by filename (more reliable than Orama search)
        const result = await searchScripts({ mode: 'scripts', limit: 100 });

        expect(result.scripts.some(s => s.filename === newScriptName)).toBe(true);
      } finally {
        // Clean up
        if (existsSync(newScriptPath)) {
          unlinkSync(newScriptPath);
        }
      }
    });
  });

  describe('Script Content Extraction', () => {
    it('extracts block comments as description', async () => {
      const scriptWithBlockComment = 'temp-block-comment-test.ts';
      const scriptPath = join(scriptsDirectory, scriptWithBlockComment);
      const content = `/**
 * This is a block comment description.
 * It spans multiple lines.
 */
console.log('test');
`;

      try {
        writeFileSync(scriptPath, content);
        await new Promise(resolve => setTimeout(resolve, 500));

        // List all scripts and find by filename (more reliable than search)
        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        const script = result.scripts.find(s => s.filename === scriptWithBlockComment);

        expect(script).toBeDefined();
        expect(script!.description).toContain('block comment description');
      } finally {
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }
      }
    });

    it('extracts single-line comments as description', async () => {
      const scriptWithLineComments = 'temp-line-comment-test.ts';
      const scriptPath = join(scriptsDirectory, scriptWithLineComments);
      const content = `// This is a single line comment description
// It can span multiple lines
console.log('test');
`;

      try {
        writeFileSync(scriptPath, content);
        await new Promise(resolve => setTimeout(resolve, 500));

        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        const script = result.scripts.find(s => s.filename === scriptWithLineComments);

        expect(script).toBeDefined();
        expect(script!.description).toContain('single line comment');
      } finally {
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }
      }
    });

    it('uses filename as fallback when no comments', async () => {
      const scriptNoComment = 'temp-no-comment-script.ts';
      const scriptPath = join(scriptsDirectory, scriptNoComment);
      const content = `console.log('no comment at the top');
`;

      try {
        writeFileSync(scriptPath, content);
        await new Promise(resolve => setTimeout(resolve, 500));

        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        const script = result.scripts.find(s => s.filename === scriptNoComment);

        expect(script).toBeDefined();
        // Description should contain something derived from filename
        expect(script!.description).toContain('Script:');
      } finally {
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }
      }
    });
  });

  describe('API Signal Extraction', () => {
    it('extracts CoreV1Api from script content', async () => {
      const scriptPath = join(scriptsDirectory, 'temp-corev1-test.ts');
      const content = `// Test CoreV1Api extraction
import * as k8s from '@kubernetes/client-node';
const kc = new k8s.KubeConfig();
const api = kc.makeApiClient(k8s.CoreV1Api);
`;

      try {
        writeFileSync(scriptPath, content);
        await new Promise(resolve => setTimeout(resolve, 500));

        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        const script = result.scripts.find(s => s.filename === 'temp-corev1-test.ts');

        expect(script).toBeDefined();
        expect(script!.apiClasses).toContain('CoreV1Api');
      } finally {
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }
      }
    });

    it('extracts AppsV1Api from script content', async () => {
      const scriptPath = join(scriptsDirectory, 'temp-appsv1-test.ts');
      const content = `// Test AppsV1Api extraction
import * as k8s from '@kubernetes/client-node';
const kc = new k8s.KubeConfig();
const api = kc.makeApiClient(k8s.AppsV1Api);
`;

      try {
        writeFileSync(scriptPath, content);
        await new Promise(resolve => setTimeout(resolve, 500));

        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        const script = result.scripts.find(s => s.filename === 'temp-appsv1-test.ts');

        expect(script).toBeDefined();
        expect(script!.apiClasses).toContain('AppsV1Api');
      } finally {
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }
      }
    });

    it('extracts BatchV1Api from script content', async () => {
      const scriptPath = join(scriptsDirectory, 'temp-batchv1-test.ts');
      const content = `// Test BatchV1Api extraction
import * as k8s from '@kubernetes/client-node';
const kc = new k8s.KubeConfig();
const api = kc.makeApiClient(k8s.BatchV1Api);
`;

      try {
        writeFileSync(scriptPath, content);
        await new Promise(resolve => setTimeout(resolve, 500));

        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        const script = result.scripts.find(s => s.filename === 'temp-batchv1-test.ts');

        expect(script).toBeDefined();
        expect(script!.apiClasses).toContain('BatchV1Api');
      } finally {
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }
      }
    });
  });
});

describe('kubernetes.searchTools - Filesystem Watcher', () => {
  const scriptsDirectory = join(os.homedir(), '.prodisco', 'scripts', 'cache');

  describe('Watcher Events', () => {
    it('indexes newly added scripts', async () => {
      const newScript = 'temp-watcher-add-test.ts';
      const newScriptPath = join(scriptsDirectory, newScript);
      const content = `// Watcher add test script
console.log('test');
`;

      try {
        // Create script
        writeFileSync(newScriptPath, content);

        // Wait for watcher to process
        await new Promise(resolve => setTimeout(resolve, 500));

        // List all scripts and find by filename
        const result = await searchScripts({ mode: 'scripts', limit: 100 });
        expect(result.scripts.some(s => s.filename === newScript)).toBe(true);
      } finally {
        if (existsSync(newScriptPath)) {
          unlinkSync(newScriptPath);
        }
      }
    });

    it('removes deleted scripts from index', async () => {
      const tempScript = 'temp-watcher-delete-test.ts';
      const tempScriptPath = join(scriptsDirectory, tempScript);
      const content = `// Watcher delete test script
console.log('test');
`;

      // Create script
      writeFileSync(tempScriptPath, content);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify it exists by listing all
      let result = await searchScripts({ mode: 'scripts', limit: 100 });
      expect(result.scripts.some(s => s.filename === tempScript)).toBe(true);

      // Delete script
      unlinkSync(tempScriptPath);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should no longer be found when listing all
      result = await searchScripts({ mode: 'scripts', limit: 100 });
      expect(result.scripts.some(s => s.filename === tempScript)).toBe(false);
    });

    it('re-indexes modified scripts', async () => {
      const modScript = 'temp-watcher-modify-test.ts';
      const modScriptPath = join(scriptsDirectory, modScript);
      const originalContent = `// Original description for modify test
console.log('original');
`;
      const modifiedContent = `// Modified description with new content
console.log('modified');
`;

      try {
        // Create with original content
        writeFileSync(modScriptPath, originalContent);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify original description by listing all
        let result = await searchScripts({ mode: 'scripts', limit: 100 });
        let script = result.scripts.find(s => s.filename === modScript);
        expect(script).toBeDefined();
        expect(script!.description).toContain('Original description');

        // Modify the script
        writeFileSync(modScriptPath, modifiedContent);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify modified description
        result = await searchScripts({ mode: 'scripts', limit: 100 });
        script = result.scripts.find(s => s.filename === modScript);
        expect(script).toBeDefined();
        expect(script!.description).toContain('Modified description');
      } finally {
        if (existsSync(modScriptPath)) {
          unlinkSync(modScriptPath);
        }
      }
    });
  });
});
