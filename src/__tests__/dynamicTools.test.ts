import { describe, expect, it } from 'vitest';

import { searchToolsTool } from '../tools/prodisco/searchTools.js';
import { createRunSandboxTool } from '../tools/prodisco/runSandbox.js';

describe('Dynamic tool generation', () => {
  it('searchTools tool description lists indexed libraries', () => {
    expect(searchToolsTool.description).toContain('INDEXED:');
    expect(searchToolsTool.description).toContain('@kubernetes/client-node');
  });

  it('searchTools schema restricts library to configured set', () => {
    expect(() => searchToolsTool.schema.parse({ library: '@kubernetes/client-node' })).not.toThrow();
    expect(() => searchToolsTool.schema.parse({ library: 'not-a-real-lib' })).toThrow();
  });

  it('runSandbox tool description lists allowed imports from config', () => {
    const tool = createRunSandboxTool({
      libraries: [{ name: 'some-lib', description: 'Demo library' }],
    });

    expect(tool.description).toContain('ALLOWED IMPORTS:');
    expect(tool.description).toContain('require("some-lib")');
    expect(tool.description).toContain('Demo library');
  });
});


