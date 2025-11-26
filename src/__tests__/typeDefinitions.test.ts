import { describe, expect, it } from 'vitest';

import { searchToolsTool } from '../tools/kubernetes/searchTools.js';

// Helper to execute in types mode
async function executeTypesMode(types: string[], depth?: number) {
  const result = await searchToolsTool.execute({
    mode: 'types',
    types,
    depth,
  });

  if (result.mode !== 'types') {
    throw new Error('Expected types mode result');
  }

  return result;
}

describe('kubernetes.searchTools (types mode)', () => {
  describe('Basic Type Queries', () => {
    it('retrieves V1Pod type definition', async () => {
      const result = await executeTypesMode(['V1Pod']);

      expect(result.types).toHaveProperty('V1Pod');
      expect(result.types['V1Pod'].name).toBe('V1Pod');
      expect(result.types['V1Pod'].definition).toContain('V1Pod');
      expect(result.types['V1Pod'].nestedTypes).toBeDefined();
    });

    it('retrieves V1Deployment type definition', async () => {
      const result = await executeTypesMode(['V1Deployment']);

      expect(result.types).toHaveProperty('V1Deployment');
      expect(result.types['V1Deployment'].name).toBe('V1Deployment');
      expect(result.types['V1Deployment'].definition).toContain('V1Deployment');
    });

    it('retrieves multiple types at once', async () => {
      const result = await executeTypesMode(['V1Pod', 'V1Service', 'V1ConfigMap']);

      expect(result.types).toHaveProperty('V1Pod');
      expect(result.types).toHaveProperty('V1Service');
      expect(result.types).toHaveProperty('V1ConfigMap');
    });
  });

  describe('Dot Notation Support (README Examples)', () => {
    it('navigates to nested type using V1Deployment.spec', async () => {
      const result = await executeTypesMode(['V1Deployment.spec']);

      expect(result.types).toHaveProperty('V1Deployment.spec');
      const typeInfo = result.types['V1Deployment.spec'];
      expect(typeInfo.name).toBe('V1DeploymentSpec');
      expect(typeInfo.definition).toContain('V1DeploymentSpec');
    });

    it('navigates to array element type using V1Pod.spec.containers', async () => {
      const result = await executeTypesMode(['V1Pod.spec.containers']);

      expect(result.types).toHaveProperty('V1Pod.spec.containers');
      const typeInfo = result.types['V1Pod.spec.containers'];
      // Should resolve to V1Container (array element type)
      expect(typeInfo.name).toBe('V1Container');
      expect(typeInfo.definition).toContain('V1Container');
    });

    it('navigates to status conditions using V1Pod.status.conditions', async () => {
      const result = await executeTypesMode(['V1Pod.status.conditions']);

      expect(result.types).toHaveProperty('V1Pod.status.conditions');
      const typeInfo = result.types['V1Pod.status.conditions'];
      // Should resolve to V1PodCondition (array element type)
      expect(typeInfo.name).toBe('V1PodCondition');
      expect(typeInfo.definition).toContain('V1PodCondition');
    });
  });

  describe('Depth Control', () => {
    it('respects depth parameter', async () => {
      const result = await executeTypesMode(['V1Pod'], 1);

      // At depth 1, should only include the main type
      expect(result.types).toHaveProperty('V1Pod');
    });

    it('includes nested types at depth 2', async () => {
      const result = await executeTypesMode(['V1Pod'], 2);

      // Should include V1Pod and potentially nested types
      expect(result.types).toHaveProperty('V1Pod');
      const v1Pod = result.types['V1Pod'];

      // Should have nested types referenced
      expect(v1Pod.nestedTypes).toBeDefined();
      expect(Array.isArray(v1Pod.nestedTypes)).toBe(true);
    });
  });

  describe('Type Resolution', () => {
    it('resolves V1PodSpec type', async () => {
      const result = await executeTypesMode(['V1PodSpec']);

      expect(result.types).toHaveProperty('V1PodSpec');
      expect(result.types['V1PodSpec'].definition).toContain('V1PodSpec');
    });

    it('resolves V1Container type', async () => {
      const result = await executeTypesMode(['V1Container']);

      expect(result.types).toHaveProperty('V1Container');
      expect(result.types['V1Container'].definition).toContain('V1Container');
    });

    it('resolves V1ObjectMeta type', async () => {
      const result = await executeTypesMode(['V1ObjectMeta']);

      expect(result.types).toHaveProperty('V1ObjectMeta');
      expect(result.types['V1ObjectMeta'].definition).toContain('V1ObjectMeta');
    });
  });

  describe('List Types', () => {
    it('resolves V1PodList type', async () => {
      const result = await executeTypesMode(['V1PodList']);

      expect(result.types).toHaveProperty('V1PodList');
      const definition = result.types['V1PodList'].definition;
      expect(definition).toContain('V1PodList');
      // List types should have items property
      expect(definition).toContain('items');
    });

    it('resolves V1DeploymentList type', async () => {
      const result = await executeTypesMode(['V1DeploymentList']);

      expect(result.types).toHaveProperty('V1DeploymentList');
      expect(result.types['V1DeploymentList'].definition).toContain('V1DeploymentList');
    });
  });

  describe('Output Structure', () => {
    it('includes required fields in results', async () => {
      const result = await executeTypesMode(['V1Pod']);

      expect(result).toHaveProperty('mode', 'types');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('types');

      expect(typeof result.summary).toBe('string');
      expect(typeof result.types).toBe('object');
    });

    it('includes complete type information', async () => {
      const result = await executeTypesMode(['V1Pod']);

      const typeInfo = result.types['V1Pod'];
      expect(typeInfo).toHaveProperty('name');
      expect(typeInfo).toHaveProperty('definition');
      expect(typeInfo).toHaveProperty('file');
      expect(typeInfo).toHaveProperty('nestedTypes');

      expect(typeof typeInfo.name).toBe('string');
      expect(typeof typeInfo.definition).toBe('string');
      expect(typeof typeInfo.file).toBe('string');
      expect(Array.isArray(typeInfo.nestedTypes)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('handles non-existent types gracefully', async () => {
      const result = await executeTypesMode(['NonExistentType']);

      expect(result.types).toHaveProperty('NonExistentType');
      expect(result.types['NonExistentType'].file).toBe('not found');
    });

    it('handles invalid dot notation paths gracefully', async () => {
      const result = await executeTypesMode(['V1Pod.nonexistent.path']);

      expect(result.types).toHaveProperty('V1Pod.nonexistent.path');
      // Should indicate it couldn't resolve the path
      expect(result.types['V1Pod.nonexistent.path'].definition).toContain('Could not resolve');
    });

    it('handles missing types parameter in types mode', async () => {
      const result = await searchToolsTool.execute({
        mode: 'types',
      });

      if (result.mode !== 'types') {
        throw new Error('Expected types mode result');
      }

      expect(result.summary).toContain('Error');
    });

    it('handles mixed valid and invalid types', async () => {
      const result = await executeTypesMode(['V1Pod', 'NonExistentType', 'V1Service']);

      // Valid types should be found
      expect(result.types['V1Pod'].file).not.toBe('not found');
      expect(result.types['V1Service'].file).not.toBe('not found');

      // Invalid type should indicate not found
      expect(result.types['NonExistentType'].file).toBe('not found');
    });
  });

  describe('Default Behavior', () => {
    it('uses default depth of 1 when not specified', async () => {
      const result = await executeTypesMode(['V1Pod']);

      // Should work without depth parameter
      expect(result.types).toHaveProperty('V1Pod');
      expect(result.types['V1Pod'].definition).toContain('V1Pod');
    });
  });

  describe('Deep Nested Paths', () => {
    it('navigates deeply nested paths (3+ levels)', async () => {
      const result = await executeTypesMode(['V1Deployment.spec.template.spec']);

      expect(result.types).toHaveProperty('V1Deployment.spec.template.spec');
      const typeInfo = result.types['V1Deployment.spec.template.spec'];
      // Should resolve to V1PodSpec (the spec of the pod template)
      expect(typeInfo.name).toBe('V1PodSpec');
    });

    it('navigates to container ports in pod spec', async () => {
      const result = await executeTypesMode(['V1Pod.spec.containers']);

      expect(result.types).toHaveProperty('V1Pod.spec.containers');
      // Should resolve to V1Container
      expect(result.types['V1Pod.spec.containers'].name).toBe('V1Container');
    });
  });

  describe('Types from Different API Groups', () => {
    it('resolves Batch API types (V1Job)', async () => {
      const result = await executeTypesMode(['V1Job']);

      expect(result.types).toHaveProperty('V1Job');
      expect(result.types['V1Job'].definition).toContain('V1Job');
      expect(result.types['V1Job'].file).not.toBe('not found');
    });

    it('resolves Apps API types (V1StatefulSet)', async () => {
      const result = await executeTypesMode(['V1StatefulSet']);

      expect(result.types).toHaveProperty('V1StatefulSet');
      expect(result.types['V1StatefulSet'].definition).toContain('V1StatefulSet');
    });

    it('resolves Networking API types (V1Ingress)', async () => {
      const result = await executeTypesMode(['V1Ingress']);

      expect(result.types).toHaveProperty('V1Ingress');
      expect(result.types['V1Ingress'].definition).toContain('V1Ingress');
    });

    it('resolves RBAC types (V1Role)', async () => {
      const result = await executeTypesMode(['V1Role']);

      expect(result.types).toHaveProperty('V1Role');
      expect(result.types['V1Role'].definition).toContain('V1Role');
    });
  });

  describe('Nested Types Array', () => {
    it('nestedTypes contains referenced type names', async () => {
      const result = await executeTypesMode(['V1Pod'], 1);

      const nestedTypes = result.types['V1Pod'].nestedTypes;
      expect(Array.isArray(nestedTypes)).toBe(true);

      // V1Pod should reference common types
      expect(nestedTypes.length).toBeGreaterThan(0);
    });

    it('nestedTypes are valid Kubernetes type names', async () => {
      const result = await executeTypesMode(['V1Deployment'], 1);

      const nestedTypes = result.types['V1Deployment'].nestedTypes;

      // All nested types should follow K8s naming convention (V1*, K8s*)
      for (const typeName of nestedTypes) {
        expect(typeName).toMatch(/^[VK]\d+[A-Z]/);
      }
    });
  });

  describe('File Path Format', () => {
    it('file path is relative (starts with dot)', async () => {
      const result = await executeTypesMode(['V1Pod']);

      const filePath = result.types['V1Pod'].file;
      expect(filePath).toMatch(/^\./);
    });

    it('file path contains kubernetes client-node path', async () => {
      const result = await executeTypesMode(['V1Pod']);

      const filePath = result.types['V1Pod'].file;
      expect(filePath).toContain('@kubernetes/client-node');
      expect(filePath).toContain('.d.ts');
    });
  });

  describe('Summary Content', () => {
    it('summary mentions fetched count', async () => {
      const result = await executeTypesMode(['V1Pod', 'V1Service']);

      expect(result.summary).toContain('Fetched');
      expect(result.summary).toContain('type definition');
    });

    it('summary mentions nested types when depth > 1', async () => {
      const result = await executeTypesMode(['V1Pod'], 2);

      // Summary should mention the requested type
      expect(result.summary).toContain('V1Pod');
    });

    it('summary lists requested types with nested count', async () => {
      const result = await executeTypesMode(['V1Deployment']);

      expect(result.summary).toContain('V1Deployment');
      expect(result.summary).toContain('nested type');
    });
  });

  describe('Definition Content', () => {
    it('definition shows property types', async () => {
      const result = await executeTypesMode(['V1Pod']);

      const definition = result.types['V1Pod'].definition;

      // Should contain common V1Pod properties
      expect(definition).toContain('metadata');
      expect(definition).toContain('spec');
      expect(definition).toContain('status');
    });

    it('definition shows optional markers', async () => {
      const result = await executeTypesMode(['V1Pod']);

      const definition = result.types['V1Pod'].definition;

      // Optional properties should have ? marker
      expect(definition).toContain('?:');
    });

    it('definition uses proper formatting with braces', async () => {
      const result = await executeTypesMode(['V1Container']);

      const definition = result.types['V1Container'].definition;

      // Should have proper structure
      expect(definition).toContain('V1Container {');
      expect(definition).toContain('}');
    });
  });
});
