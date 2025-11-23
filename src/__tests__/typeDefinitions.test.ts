import { describe, expect, it } from 'vitest';

import { getTypeDefinitionTool } from '../tools/kubernetes/typeDefinitions.js';

describe('kubernetes.getTypeDefinition', () => {
  describe('Basic Type Queries', () => {
    it('retrieves V1Pod type definition', async () => {
      const result = await getTypeDefinitionTool.execute({ types: ['V1Pod'] });

      expect(result.types).toHaveProperty('V1Pod');
      expect(result.types['V1Pod'].name).toBe('V1Pod');
      expect(result.types['V1Pod'].definition).toContain('V1Pod');
      expect(result.types['V1Pod'].nestedTypes).toBeDefined();
    });

    it('retrieves V1Deployment type definition', async () => {
      const result = await getTypeDefinitionTool.execute({ types: ['V1Deployment'] });

      expect(result.types).toHaveProperty('V1Deployment');
      expect(result.types['V1Deployment'].name).toBe('V1Deployment');
      expect(result.types['V1Deployment'].definition).toContain('V1Deployment');
    });

    it('retrieves multiple types at once', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod', 'V1Service', 'V1ConfigMap'],
      });

      expect(result.types).toHaveProperty('V1Pod');
      expect(result.types).toHaveProperty('V1Service');
      expect(result.types).toHaveProperty('V1ConfigMap');
    });
  });

  describe('Dot Notation Support (README Examples)', () => {
    it('navigates to nested type using V1Deployment.spec', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Deployment.spec'],
      });

      expect(result.types).toHaveProperty('V1Deployment.spec');
      const typeInfo = result.types['V1Deployment.spec'];
      expect(typeInfo.name).toBe('V1DeploymentSpec');
      expect(typeInfo.definition).toContain('V1DeploymentSpec');
    });

    it('navigates to array element type using V1Pod.spec.containers', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod.spec.containers'],
      });

      expect(result.types).toHaveProperty('V1Pod.spec.containers');
      const typeInfo = result.types['V1Pod.spec.containers'];
      // Should resolve to V1Container (array element type)
      expect(typeInfo.name).toBe('V1Container');
      expect(typeInfo.definition).toContain('V1Container');
    });

    it('navigates to status conditions using V1Pod.status.conditions', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod.status.conditions'],
      });

      expect(result.types).toHaveProperty('V1Pod.status.conditions');
      const typeInfo = result.types['V1Pod.status.conditions'];
      // Should resolve to V1PodCondition (array element type)
      expect(typeInfo.name).toBe('V1PodCondition');
      expect(typeInfo.definition).toContain('V1PodCondition');
    });
  });

  describe('Depth Control', () => {
    it('respects depth parameter', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod'],
        depth: 1,
      });

      // At depth 1, should only include the main type
      expect(result.types).toHaveProperty('V1Pod');
    });

    it('includes nested types at depth 2', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod'],
        depth: 2,
      });

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
      const result = await getTypeDefinitionTool.execute({
        types: ['V1PodSpec'],
      });

      expect(result.types).toHaveProperty('V1PodSpec');
      expect(result.types['V1PodSpec'].definition).toContain('V1PodSpec');
    });

    it('resolves V1Container type', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Container'],
      });

      expect(result.types).toHaveProperty('V1Container');
      expect(result.types['V1Container'].definition).toContain('V1Container');
    });

    it('resolves V1ObjectMeta type', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1ObjectMeta'],
      });

      expect(result.types).toHaveProperty('V1ObjectMeta');
      expect(result.types['V1ObjectMeta'].definition).toContain('V1ObjectMeta');
    });
  });

  describe('List Types', () => {
    it('resolves V1PodList type', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1PodList'],
      });

      expect(result.types).toHaveProperty('V1PodList');
      const definition = result.types['V1PodList'].definition;
      expect(definition).toContain('V1PodList');
      // List types should have items property
      expect(definition).toContain('items');
    });

    it('resolves V1DeploymentList type', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1DeploymentList'],
      });

      expect(result.types).toHaveProperty('V1DeploymentList');
      expect(result.types['V1DeploymentList'].definition).toContain('V1DeploymentList');
    });
  });

  describe('Output Structure', () => {
    it('includes required fields in results', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod'],
      });

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('types');
      
      expect(typeof result.summary).toBe('string');
      expect(typeof result.types).toBe('object');
    });

    it('includes complete type information', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod'],
      });

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
      const result = await getTypeDefinitionTool.execute({
        types: ['NonExistentType'],
      });

      expect(result.types).toHaveProperty('NonExistentType');
      expect(result.types['NonExistentType'].file).toBe('not found');
    });

    it('handles invalid dot notation paths gracefully', async () => {
      const result = await getTypeDefinitionTool.execute({
        types: ['V1Pod.nonexistent.path'],
      });

      expect(result.types).toHaveProperty('V1Pod.nonexistent.path');
      // Should indicate it couldn't resolve the path
      expect(result.types['V1Pod.nonexistent.path'].definition).toContain('Could not resolve');
    });
  });
});

