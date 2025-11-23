import { describe, expect, it } from 'vitest';

import { searchToolsTool } from '../tools/kubernetes/searchTools.js';

describe('searchToolsTool', () => {
  it('includes JSON schemas for inputs', async () => {
    const result = await searchToolsTool.execute({ query: 'pod', limit: 5 });

    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('filters tools by query', async () => {
    const result = await searchToolsTool.execute({
      query: 'list pods',
      limit: 5,
    });

    expect(result.tools.length).toBeGreaterThan(0);
    // Check that results are related to the query
    expect(result.tools.some((tool) => tool.methodName.toLowerCase().includes('list'))).toBe(true);
    expect(result.tools.some((tool) => tool.resourceType.toLowerCase().includes('pod'))).toBe(true);
  });
});

