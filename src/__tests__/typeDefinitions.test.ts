import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { searchToolsTool, searchToolsService } from '../tools/kubernetes/searchTools.js';

// Helper to execute type search using the new unified approach
async function executeTypeSearch(query: string, options?: { library?: string; limit?: number }) {
  const result = await searchToolsTool.execute({
    query,
    documentType: 'type',
    library: options?.library,
    limit: options?.limit || 10,
  });

  return result;
}

describe('kubernetes.searchTools (type documents in Orama)', () => {
  beforeAll(async () => {
    // Ensure the search index is initialized
    await searchToolsService.initialize();
  });

  afterAll(async () => {
    await searchToolsService.shutdown();
  });

  describe('Basic Type Queries', () => {
    it('retrieves V1Pod type definition', async () => {
      const result = await executeTypeSearch('V1Pod');

      expect(result.results.length).toBeGreaterThan(0);
      const podType = result.results.find(r => r.name === 'V1Pod');
      expect(podType).toBeDefined();
      expect(podType?.documentType).toBe('type');
      expect(podType?.typeKind).toBe('class');
      expect(podType?.typeDefinition).toContain('V1Pod');
    });

    it('retrieves V1Deployment type definition', async () => {
      const result = await executeTypeSearch('V1Deployment');

      expect(result.results.length).toBeGreaterThan(0);
      const deployType = result.results.find(r => r.name === 'V1Deployment');
      expect(deployType).toBeDefined();
      expect(deployType?.documentType).toBe('type');
      expect(deployType?.typeDefinition).toContain('V1Deployment');
    });

    it('finds multiple Pod-related types', async () => {
      const result = await executeTypeSearch('Pod', { limit: 100 });

      expect(result.results.length).toBeGreaterThan(1);
      // Should find Pod-related types (V1Pod, V1PodSpec, V1PodStatus, etc.)
      const typeNames = result.results.map(r => r.name);
      // Check that we find Pod-related types (the search may rank them differently)
      const podRelatedTypes = typeNames.filter(name => name.includes('Pod'));
      expect(podRelatedTypes.length).toBeGreaterThan(1);
    });
  });

  describe('Type Resolution', () => {
    it('resolves V1PodSpec type', async () => {
      const result = await executeTypeSearch('V1PodSpec');

      const typeInfo = result.results.find(r => r.name === 'V1PodSpec');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1PodSpec');
    });

    it('resolves V1Container type', async () => {
      const result = await executeTypeSearch('V1Container');

      const typeInfo = result.results.find(r => r.name === 'V1Container');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1Container');
    });

    it('resolves V1ObjectMeta type', async () => {
      const result = await executeTypeSearch('V1ObjectMeta');

      const typeInfo = result.results.find(r => r.name === 'V1ObjectMeta');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1ObjectMeta');
    });
  });

  describe('List Types', () => {
    it('resolves V1PodList type', async () => {
      const result = await executeTypeSearch('V1PodList');

      const typeInfo = result.results.find(r => r.name === 'V1PodList');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1PodList');
      // List types should have items property
      expect(typeInfo?.typeDefinition).toContain('items');
    });

    it('resolves V1DeploymentList type', async () => {
      const result = await executeTypeSearch('V1DeploymentList');

      const typeInfo = result.results.find(r => r.name === 'V1DeploymentList');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1DeploymentList');
    });
  });

  describe('Output Structure', () => {
    it('includes required fields in results', async () => {
      const result = await executeTypeSearch('V1Pod');

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('totalMatches');

      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('includes complete type information', async () => {
      const result = await executeTypeSearch('V1Pod');

      const typeInfo = result.results.find(r => r.name === 'V1Pod');
      expect(typeInfo).toBeDefined();
      expect(typeInfo).toHaveProperty('name');
      expect(typeInfo).toHaveProperty('description');
      expect(typeInfo).toHaveProperty('library');
      expect(typeInfo).toHaveProperty('typeDefinition');
      expect(typeInfo).toHaveProperty('nestedTypes');
      expect(typeInfo).toHaveProperty('typeKind');

      expect(typeof typeInfo?.name).toBe('string');
      expect(typeof typeInfo?.typeDefinition).toBe('string');
      expect(Array.isArray(typeInfo?.nestedTypes)).toBe(true);
    });
  });

  describe('Types from Different API Groups', () => {
    it('resolves Batch API types (V1Job)', async () => {
      const result = await executeTypeSearch('V1Job');

      const typeInfo = result.results.find(r => r.name === 'V1Job');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1Job');
    });

    it('resolves Apps API types (V1StatefulSet)', async () => {
      const result = await executeTypeSearch('V1StatefulSet');

      const typeInfo = result.results.find(r => r.name === 'V1StatefulSet');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1StatefulSet');
    });

    it('resolves Networking API types (V1Ingress)', async () => {
      const result = await executeTypeSearch('V1Ingress');

      const typeInfo = result.results.find(r => r.name === 'V1Ingress');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1Ingress');
    });

    it('resolves RBAC types (V1Role)', async () => {
      const result = await executeTypeSearch('V1Role');

      const typeInfo = result.results.find(r => r.name === 'V1Role');
      expect(typeInfo).toBeDefined();
      expect(typeInfo?.typeDefinition).toContain('V1Role');
    });
  });

  describe('Nested Types Array', () => {
    it('nestedTypes contains referenced type names', async () => {
      const result = await executeTypeSearch('V1Pod');

      const typeInfo = result.results.find(r => r.name === 'V1Pod');
      expect(typeInfo).toBeDefined();
      expect(Array.isArray(typeInfo?.nestedTypes)).toBe(true);

      // V1Pod should reference common types
      expect(typeInfo?.nestedTypes?.length).toBeGreaterThan(0);
    });

    it('nestedTypes are valid Kubernetes type names', async () => {
      const result = await executeTypeSearch('V1Deployment');

      const typeInfo = result.results.find(r => r.name === 'V1Deployment');
      expect(typeInfo).toBeDefined();

      // All nested types should follow K8s naming convention (V1*, K8s*, Core*)
      for (const typeName of typeInfo?.nestedTypes || []) {
        expect(typeName).toMatch(/^[VKC]/);
      }
    });
  });

  describe('Definition Content', () => {
    it('definition shows property types', async () => {
      const result = await executeTypeSearch('V1Pod');

      const typeInfo = result.results.find(r => r.name === 'V1Pod');
      expect(typeInfo).toBeDefined();

      const definition = typeInfo?.typeDefinition || '';
      // Should contain common V1Pod properties
      expect(definition).toContain('metadata');
      expect(definition).toContain('spec');
      expect(definition).toContain('status');
    });

    it('definition shows optional markers', async () => {
      const result = await executeTypeSearch('V1Pod');

      const typeInfo = result.results.find(r => r.name === 'V1Pod');
      const definition = typeInfo?.typeDefinition || '';

      // Optional properties should have ? marker
      expect(definition).toContain('?:');
    });

    it('definition uses proper formatting with braces', async () => {
      const result = await executeTypeSearch('V1Container');

      const typeInfo = result.results.find(r => r.name === 'V1Container');
      const definition = typeInfo?.typeDefinition || '';

      // Should have proper structure
      expect(definition).toContain('V1Container {');
      expect(definition).toContain('}');
    });
  });

  describe('Library Filtering', () => {
    it('filters by @kubernetes/client-node library', async () => {
      const result = await searchToolsTool.execute({
        query: 'Pod',
        documentType: 'type',
        library: '@kubernetes/client-node',
        limit: 20,
      });

      expect(result.results.length).toBeGreaterThan(0);
      for (const typeInfo of result.results) {
        expect(typeInfo.library).toBe('@kubernetes/client-node');
      }
    });

    it('filters by prometheus-query library', async () => {
      const result = await searchToolsTool.execute({
        query: '',
        documentType: 'type',
        library: 'prometheus-query',
        limit: 20,
      });

      // Should find prometheus types if any match
      for (const typeInfo of result.results) {
        expect(typeInfo.library).toBe('prometheus-query');
      }
    });
  });

  describe('Type Kinds', () => {
    it('includes class types', async () => {
      const result = await executeTypeSearch('V1Pod');

      const classType = result.results.find(r => r.typeKind === 'class');
      expect(classType).toBeDefined();
    });

    it('can filter by category (type kind)', async () => {
      const result = await searchToolsTool.execute({
        query: '',
        documentType: 'type',
        category: 'interface',
        library: '@prodisco/loki-client',
        limit: 20,
      });

      // All results should be interfaces
      for (const typeInfo of result.results) {
        expect(typeInfo.typeKind).toBe('interface');
      }
    });
  });

  describe('Unified Search', () => {
    it('returns types when searching without documentType filter', async () => {
      const result = await searchToolsTool.execute({
        query: 'Deployment',
        limit: 20,
      });

      // Should include both types and methods
      const typeResults = result.results.filter(r => r.documentType === 'type');
      const methodResults = result.results.filter(r => r.documentType === 'kubernetes');

      // Deployment should match both types and methods
      expect(typeResults.length + methodResults.length).toBeGreaterThan(0);
    });

    it('facets include type document counts', async () => {
      const result = await searchToolsTool.execute({
        query: 'Pod',
        limit: 10,
      });

      expect(result.facets).toBeDefined();
      expect(result.facets.documentType).toHaveProperty('type');
    });
  });

  describe('Navigation via Nested Types', () => {
    it('can navigate to nested types by querying them', async () => {
      // First, get V1Deployment to see its nested types
      const deployResult = await executeTypeSearch('V1Deployment');
      const deployType = deployResult.results.find(r => r.name === 'V1Deployment');
      expect(deployType).toBeDefined();
      expect(deployType?.nestedTypes).toContain('V1DeploymentSpec');

      // Then query the nested type directly
      const specResult = await executeTypeSearch('V1DeploymentSpec');
      const specType = specResult.results.find(r => r.name === 'V1DeploymentSpec');
      expect(specType).toBeDefined();
      expect(specType?.typeDefinition).toContain('V1DeploymentSpec');
    });
  });
});
