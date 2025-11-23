import { describe, expect, it } from 'vitest';

import { searchToolsTool } from '../tools/kubernetes/searchTools.js';

describe('searchToolsTool', () => {
  it('includes JSON schemas for inputs regardless of detail level', async () => {
    const result = await searchToolsTool.execute({ detailLevel: 'name', limit: 5 });

    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('filters tools by query', async () => {
    const result = await searchToolsTool.execute({
      query: 'listpods',
      detailLevel: 'full',
      limit: 5,
    });

    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.every((tool) => tool.name.toLowerCase().includes('listpods'))).toBe(true);
  });
});

