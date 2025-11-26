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
});
