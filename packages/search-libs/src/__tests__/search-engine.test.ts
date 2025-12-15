/**
 * Tests for the search engine module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SearchEngine } from '../search/search-engine.js';
import { QueryBuilder } from '../search/query-builder.js';
import { formatResults, formatForAI } from '../search/result-formatter.js';
import type { BaseDocument } from '../schema/base-schema.js';

describe('SearchEngine', () => {
  let engine: SearchEngine;

  beforeEach(async () => {
    engine = new SearchEngine();
    await engine.initialize();
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  describe('initialization', () => {
    it('initializes successfully', () => {
      expect(engine.isInitialized()).toBe(true);
    });

    it('creates Orama database', () => {
      expect(engine.getDb()).not.toBeNull();
    });
  });

  describe('insert', () => {
    it('inserts a single document', async () => {
      const doc: BaseDocument = {
        id: 'test:1',
        documentType: 'type',
        name: 'TestType',
        description: 'A test type.',
        searchTokens: 'Test Type',
        library: 'test-lib',
        category: 'class',
        properties: '[]',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: 'class',
        parameters: '',
        returnType: '',
        returnTypeDefinition: '',
        signature: '',
        className: '',
        filePath: '',
        keywords: '',
      };

      await engine.insert(doc);

      const result = await engine.search({ query: 'TestType' });
      expect(result.results.length).toBe(1);
      expect(result.results[0].name).toBe('TestType');
    });
  });

  describe('insertBatch', () => {
    it('inserts multiple documents', async () => {
      const docs: BaseDocument[] = [
        {
          id: 'test:1',
          documentType: 'type',
          name: 'TypeOne',
          description: 'First type.',
          searchTokens: 'Type One',
          library: 'test-lib',
          category: 'class',
          properties: '[]',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: 'class',
          parameters: '',
          returnType: '',
          returnTypeDefinition: '',
          signature: '',
          className: '',
          filePath: '',
          keywords: '',
        },
        {
          id: 'test:2',
          documentType: 'type',
          name: 'TypeTwo',
          description: 'Second type.',
          searchTokens: 'Type Two',
          library: 'test-lib',
          category: 'interface',
          properties: '[]',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: 'interface',
          parameters: '',
          returnType: '',
          returnTypeDefinition: '',
          signature: '',
          className: '',
          filePath: '',
          keywords: '',
        },
      ];

      await engine.insertBatch(docs);

      const result = await engine.search({ query: 'Type' });
      expect(result.results.length).toBe(2);
    });

    it('handles empty array', async () => {
      await expect(engine.insertBatch([])).resolves.not.toThrow();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      const docs: BaseDocument[] = [
        {
          id: 'method:CoreV1Api.listNamespacedPod',
          documentType: 'method',
          name: 'listNamespacedPod',
          description: 'List pods in a namespace.',
          searchTokens: 'list Namespaced Pod',
          library: '@kubernetes/client-node',
          category: 'list',
          properties: '',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: '',
          parameters: '[]',
          returnType: 'Promise<V1PodList>',
          returnTypeDefinition: '',
          signature: 'listNamespacedPod(namespace: string): Promise<V1PodList>',
          className: 'CoreV1Api',
          filePath: '',
          keywords: '',
        },
        {
          id: 'method:CoreV1Api.createNamespacedPod',
          documentType: 'method',
          name: 'createNamespacedPod',
          description: 'Create a pod in a namespace.',
          searchTokens: 'create Namespaced Pod',
          library: '@kubernetes/client-node',
          category: 'create',
          properties: '',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: '',
          parameters: '[]',
          returnType: 'Promise<V1Pod>',
          returnTypeDefinition: '',
          signature: 'createNamespacedPod(namespace: string, body: V1Pod): Promise<V1Pod>',
          className: 'CoreV1Api',
          filePath: '',
          keywords: '',
        },
        {
          id: 'type:V1Pod',
          documentType: 'type',
          name: 'V1Pod',
          description: 'Pod resource.',
          searchTokens: 'V1 Pod',
          library: '@kubernetes/client-node',
          category: 'class',
          properties: '[]',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: 'class',
          parameters: '',
          returnType: '',
          returnTypeDefinition: '',
          signature: '',
          className: '',
          filePath: '',
          keywords: '',
        },
        {
          id: 'method:PrometheusDriver.instantQuery',
          documentType: 'method',
          name: 'instantQuery',
          description: 'Execute an instant query.',
          searchTokens: 'instant Query',
          library: 'prometheus-query',
          category: 'query',
          properties: '',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: '',
          parameters: '[]',
          returnType: 'Promise<QueryResult>',
          returnTypeDefinition: '',
          signature: 'instantQuery(query: string): Promise<QueryResult>',
          className: 'PrometheusDriver',
          filePath: '',
          keywords: '',
        },
      ];

      await engine.insertBatch(docs);
    });

    it('finds documents by query term', async () => {
      const result = await engine.search({ query: 'Pod' });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.some((r) => r.name.includes('Pod'))).toBe(true);
    });

    it('filters by documentType', async () => {
      const result = await engine.search({
        query: 'Pod',
        documentType: 'method',
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((r) => r.documentType === 'method')).toBe(true);
    });

    it('filters by category', async () => {
      const result = await engine.search({
        query: 'Pod',
        category: 'list',
      });

      expect(result.results.length).toBe(1);
      expect(result.results[0].name).toBe('listNamespacedPod');
    });

    it('filters by library', async () => {
      const result = await engine.search({
        query: 'query',
        library: 'prometheus-query',
      });

      expect(result.results.length).toBe(1);
      expect(result.results[0].library).toBe('prometheus-query');
    });

    it('excludes categories', async () => {
      const result = await engine.search({
        query: 'Pod',
        exclude: { categories: ['create'] },
      });

      expect(result.results.every((r) => r.category !== 'create')).toBe(true);
    });

    it('excludes libraries', async () => {
      const result = await engine.search({
        exclude: { libraries: ['prometheus-query'] },
      });

      expect(result.results.every((r) => r.library !== 'prometheus-query')).toBe(true);
    });

    it('respects limit parameter', async () => {
      const result = await engine.search({ query: 'Pod', limit: 1 });

      expect(result.results.length).toBe(1);
    });

    it('respects offset parameter', async () => {
      const firstPage = await engine.search({ query: 'Pod', limit: 1, offset: 0 });
      const secondPage = await engine.search({ query: 'Pod', limit: 1, offset: 1 });

      if (firstPage.totalMatches > 1) {
        expect(firstPage.results[0].id).not.toBe(secondPage.results[0]?.id);
      }
    });

    it('returns totalMatches count', async () => {
      const result = await engine.search({ query: 'Pod', limit: 1 });

      expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    });

    it('returns search time', async () => {
      const result = await engine.search({ query: 'Pod' });

      expect(result.searchTime).toBeGreaterThanOrEqual(0);
    });

    it('returns facets', async () => {
      const result = await engine.search({ query: 'Pod' });

      expect(result.facets).toBeDefined();
      expect(result.facets.documentType).toBeDefined();
      expect(result.facets.library).toBeDefined();
      expect(result.facets.category).toBeDefined();
    });
  });

  describe('remove', () => {
    it('removes a document by ID', async () => {
      const doc: BaseDocument = {
        id: 'test:removable',
        documentType: 'type',
        name: 'RemovableType',
        description: 'A removable type.',
        searchTokens: 'Removable Type',
        library: 'test-lib',
        category: 'class',
        properties: '[]',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: 'class',
        parameters: '',
        returnType: '',
        returnTypeDefinition: '',
        signature: '',
        className: '',
        filePath: '',
        keywords: '',
      };

      await engine.insert(doc);

      // Verify it was inserted
      let result = await engine.search({ query: 'Removable' });
      expect(result.results.length).toBe(1);

      // Remove it
      await engine.remove('test:removable');

      // Verify it was removed
      result = await engine.search({ query: 'Removable' });
      expect(result.results.length).toBe(0);
    });
  });
});

describe('QueryBuilder', () => {
  it('builds basic query', () => {
    const options = QueryBuilder.create().query('Pod').build();

    expect(options.query).toBe('Pod');
  });

  it('sets document type filter', () => {
    const options = QueryBuilder.create()
      .query('Pod')
      .documentType('method')
      .build();

    expect(options.documentType).toBe('method');
  });

  it('sets category filter', () => {
    const options = QueryBuilder.create().query('Pod').category('list').build();

    expect(options.category).toBe('list');
  });

  it('sets library filter', () => {
    const options = QueryBuilder.create()
      .query('Pod')
      .library('@kubernetes/client-node')
      .build();

    expect(options.library).toBe('@kubernetes/client-node');
  });

  it('sets exclude categories', () => {
    const options = QueryBuilder.create()
      .query('Pod')
      .excludeCategories(['delete', 'create'])
      .build();

    expect(options.exclude?.categories).toEqual(['delete', 'create']);
  });

  it('sets exclude libraries', () => {
    const options = QueryBuilder.create()
      .query('Pod')
      .excludeLibraries(['prometheus-query'])
      .build();

    expect(options.exclude?.libraries).toEqual(['prometheus-query']);
  });

  it('sets limit', () => {
    const options = QueryBuilder.create().query('Pod').limit(5).build();

    expect(options.limit).toBe(5);
  });

  it('sets offset', () => {
    const options = QueryBuilder.create().query('Pod').offset(10).build();

    expect(options.offset).toBe(10);
  });

  it('sets page number', () => {
    const options = QueryBuilder.create().query('Pod').page(3, 10).build();

    expect(options.limit).toBe(10);
    expect(options.offset).toBe(20); // (3-1) * 10
  });

  it('sets boost weights', () => {
    const options = QueryBuilder.create()
      .query('Pod')
      .boost({ name: 5, description: 1 })
      .build();

    expect(options.boost).toEqual({ name: 5, description: 1 });
  });

  it('chains multiple options', () => {
    const options = QueryBuilder.create()
      .query('Pod')
      .documentType('method')
      .category('list')
      .library('@kubernetes/client-node')
      .excludeCategories(['delete'])
      .limit(10)
      .offset(5)
      .build();

    expect(options.query).toBe('Pod');
    expect(options.documentType).toBe('method');
    expect(options.category).toBe('list');
    expect(options.library).toBe('@kubernetes/client-node');
    expect(options.exclude?.categories).toEqual(['delete']);
    expect(options.limit).toBe(10);
    expect(options.offset).toBe(5);
  });
});

describe('Result Formatter', () => {
  const mockSearchResult = {
    results: [
      {
        id: 'method:CoreV1Api.listNamespacedPod',
        documentType: 'method' as const,
        name: 'listNamespacedPod',
        description: 'List pods in a namespace.',
        searchTokens: 'list Namespaced Pod',
        library: '@kubernetes/client-node',
        category: 'list',
        properties: '',
        typeDefinition: '',
        nestedTypes: '',
        typeKind: '',
        parameters: JSON.stringify([
          { name: 'namespace', type: 'string', optional: false },
        ]),
        returnType: 'Promise<V1PodList>',
        returnTypeDefinition: '',
        signature: 'listNamespacedPod(namespace: string): Promise<V1PodList>',
        className: 'CoreV1Api',
        filePath: '',
        keywords: '',
      },
      {
        id: 'type:V1Pod',
        documentType: 'type' as const,
        name: 'V1Pod',
        description: 'Pod resource.',
        searchTokens: 'V1 Pod',
        library: '@kubernetes/client-node',
        category: 'class',
        properties: JSON.stringify([
          { name: 'metadata', type: 'V1ObjectMeta', optional: true },
          { name: 'spec', type: 'V1PodSpec', optional: true },
        ]),
        typeDefinition: 'class V1Pod { ... }',
        nestedTypes: 'V1ObjectMeta,V1PodSpec',
        typeKind: 'class',
        parameters: '',
        returnType: '',
        returnTypeDefinition: '',
        signature: '',
        className: '',
        filePath: '',
        keywords: '',
      },
    ] as BaseDocument[],
    totalMatches: 2,
    facets: {
      documentType: { method: 1, type: 1 },
      library: { '@kubernetes/client-node': 2 },
      category: { list: 1, class: 1 },
    },
    searchTime: 5.2,
  };

  describe('formatResults', () => {
    it('formats search results to structured output', () => {
      const formatted = formatResults(mockSearchResult);

      expect(formatted.summary).toContain('Found 2 result');
      expect(formatted.items.length).toBe(2);
      expect(formatted.totalMatches).toBe(2);
      expect(formatted.searchTime).toBe(5.2);
    });

    it('includes method-specific fields', () => {
      const formatted = formatResults(mockSearchResult);
      const methodItem = formatted.items.find((i) => i.type === 'method');

      expect(methodItem).toBeDefined();
      expect(methodItem?.parameters).toBeDefined();
      expect(methodItem?.returnType).toBe('Promise<V1PodList>');
      expect(methodItem?.signature).toBeDefined();
      expect(methodItem?.className).toBe('CoreV1Api');
    });

    it('includes type-specific fields', () => {
      const formatted = formatResults(mockSearchResult);
      const typeItem = formatted.items.find((i) => i.type === 'type');

      expect(typeItem).toBeDefined();
      expect(typeItem?.properties).toBeDefined();
      expect(typeItem?.properties?.length).toBe(2);
      expect(typeItem?.nestedTypes).toContain('V1ObjectMeta');
      expect(typeItem?.typeKind).toBe('class');
    });

    it('limits properties when maxProperties option is set', () => {
      const formatted = formatResults(mockSearchResult, { maxProperties: 1 });
      const typeItem = formatted.items.find((i) => i.type === 'type');

      expect(typeItem?.properties?.length).toBe(1);
    });

    it('includes pagination info', () => {
      const formatted = formatResults(mockSearchResult);

      expect(formatted.pagination).toBeDefined();
      expect(formatted.pagination.limit).toBe(2);
      expect(formatted.pagination.hasMore).toBe(false);
    });

    it('sets hasMore when more results exist', () => {
      const resultWithMore = {
        ...mockSearchResult,
        totalMatches: 10,
      };
      const formatted = formatResults(resultWithMore);

      expect(formatted.pagination.hasMore).toBe(true);
    });
  });

  describe('formatForAI', () => {
    it('formats results as markdown string', () => {
      const output = formatForAI(mockSearchResult);

      expect(typeof output).toBe('string');
      expect(output).toContain('Found 2 result');
      expect(output).toContain('## listNamespacedPod');
      expect(output).toContain('## V1Pod');
    });

    it('includes method parameters in output', () => {
      const output = formatForAI(mockSearchResult);

      expect(output).toContain('Parameters:');
      expect(output).toContain('namespace');
    });

    it('includes type properties in output', () => {
      const output = formatForAI(mockSearchResult);

      expect(output).toContain('Properties:');
      expect(output).toContain('metadata');
    });

    it('includes return type for methods', () => {
      const output = formatForAI(mockSearchResult);

      expect(output).toContain('Returns: Promise<V1PodList>');
    });
  });
});
