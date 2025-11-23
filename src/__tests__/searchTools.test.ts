import { describe, expect, it } from 'vitest';

import { searchToolsTool } from '../tools/kubernetes/searchTools.js';

describe('searchToolsTool', () => {
  it('includes JSON schemas for inputs', async () => {
    const result = await searchToolsTool.execute({ resourceType: 'Pod', limit: 5 });

    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('filters tools by structured parameters', async () => {
    const result = await searchToolsTool.execute({
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
    const result = await searchToolsTool.execute({
      resourceType: 'Deployment',
      limit: 10,
    });

    expect(result.tools.length).toBeGreaterThan(0);
    // Should return multiple actions for Deployment
    const actions = new Set(result.tools.map(t => t.methodName.split(/(?=[A-Z])/)[0].toLowerCase()));
    expect(actions.size).toBeGreaterThan(1); // Should have create, delete, list, etc.
  });

  it('filters by scope correctly', async () => {
    const namespacedResult = await searchToolsTool.execute({
      resourceType: 'Pod',
      action: 'list',
      scope: 'namespaced',
      limit: 5,
    });

    const clusterResult = await searchToolsTool.execute({
      resourceType: 'Node',
      action: 'list',
      scope: 'cluster',
      limit: 5,
    });

    // Namespaced Pod methods should include 'namespaced' in method name
    expect(namespacedResult.tools.every(t => t.methodName.toLowerCase().includes('namespaced'))).toBe(true);
    
    // Cluster-scoped Node methods should NOT include 'namespaced' (unless ForAllNamespaces)
    expect(clusterResult.tools.some(t => !t.methodName.toLowerCase().includes('namespaced'))).toBe(true);
  });
});

