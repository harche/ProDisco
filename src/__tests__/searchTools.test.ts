import { describe, expect, it } from 'vitest';

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
});
