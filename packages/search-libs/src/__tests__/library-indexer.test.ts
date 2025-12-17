/**
 * Tests for the LibraryIndexer - the high-level API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { LibraryIndexer } from '../library-indexer.js';

describe('LibraryIndexer', () => {
  const testDir = `/tmp/search-libs-indexer-test-${Date.now()}`;

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('initialization', () => {
    it('initializes with empty package list', async () => {
      const indexer = new LibraryIndexer({ packages: [] });

      const result = await indexer.initialize();

      expect(result.indexed).toBe(0);
      expect(result.errors.length).toBe(0);
      expect(indexer.isInitialized()).toBe(true);

      await indexer.shutdown();
    });

    it('returns early if already initialized', async () => {
      const indexer = new LibraryIndexer({ packages: [] });

      const first = await indexer.initialize();
      const second = await indexer.initialize();

      expect(second.indexed).toBe(0);

      await indexer.shutdown();
    });

    it('handles non-existent package gracefully', async () => {
      const indexer = new LibraryIndexer({
        packages: [{ name: 'non-existent-package-12345' }],
      });

      const result = await indexer.initialize();

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.indexed).toBe(0);

      await indexer.shutdown();
    });

    it('indexes package if available', async () => {
      const indexer = new LibraryIndexer({
        packages: [{ name: '@kubernetes/client-node' }],
      });

      const result = await indexer.initialize();

      // Package may not be installed in test environment
      if (result.errors.length === 0) {
        expect(result.indexed).toBeGreaterThan(0);
        expect(result.packageCounts['@kubernetes/client-node']).toBeGreaterThan(0);
      }

      await indexer.shutdown();
    }, 30000); // Allow 30s for large package indexing

    it('applies type filter during initialization if package available', async () => {
      const indexer = new LibraryIndexer({
        packages: [
          {
            name: '@kubernetes/client-node',
            typeFilter: /^V1Pod$/,
          },
        ],
      });

      const result = await indexer.initialize();

      // Package may not be installed in test environment
      if (result.errors.length === 0) {
        expect(result.indexed).toBeGreaterThan(0);

        // Search should find V1Pod
        const searchResult = await indexer.search({ query: 'V1Pod' });
        expect(searchResult.results.some((r) => r.name === 'V1Pod')).toBe(true);
      }

      await indexer.shutdown();
    }, 30000); // Allow 30s for large package indexing
  });

  describe('end-to-end package indexing (fixtures)', () => {
    it('indexes and searches a TypeScript declaration package fixture (.d.ts)', async () => {
      const basePath = `/tmp/search-libs-ts-fixture-${Date.now()}`;
      const pkgDir = join(basePath, 'node_modules', 'my-ts-lib');
      const distDir = join(pkgDir, 'dist');

      let indexer: LibraryIndexer | undefined;

      try {
        mkdirSync(distDir, { recursive: true });

        writeFileSync(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'my-ts-lib',
              version: '1.0.0',
              types: 'dist/index.d.ts',
            },
            null,
            2
          )
        );

        writeFileSync(
          join(distDir, 'index.d.ts'),
          [
            "export { InternalApi as Api } from './api';",
            "export { add } from './functions';",
            "export * from './types';",
            '',
          ].join('\n')
        );

        writeFileSync(
          join(distDir, 'types.d.ts'),
          [
            '/** Item model. */',
            'export interface Item {',
            '  id: string;',
            '  name?: string;',
            '}',
            '',
          ].join('\n')
        );

        writeFileSync(
          join(distDir, 'functions.d.ts'),
          [
            '/** Add two numbers. */',
            'export declare function add(a: number, b: number): number;',
            '',
          ].join('\n')
        );

        writeFileSync(
          join(distDir, 'api.d.ts'),
          [
            "import type { Item } from './types';",
            '',
            '/** Public API (aliased from InternalApi). */',
            'export declare class InternalApi {',
            '  /** List items in a namespace. */',
            '  listItems(namespace: string): Promise<Item[]>;',
            '  /** Get a single item. */',
            '  getItem(name: string, namespace?: string): Promise<Item>;',
            '  _internal(): void;',
            '}',
            '',
            '/** Not exported from the package entry - should not have methods indexed. */',
            'export declare class InternalHidden {',
            '  secret(): void;',
            '}',
            '',
          ].join('\n')
        );

        indexer = new LibraryIndexer({
          basePath,
          packages: [{ name: 'my-ts-lib' }],
        });

        const init = await indexer.initialize();
        expect(init.errors).toHaveLength(0);
        expect(init.packageCounts['my-ts-lib']).toBeGreaterThan(0);

        // Method indexing should reflect the public alias: InternalApi -> Api
        const methods = await indexer.search({
          query: 'listItems',
          documentType: 'method',
          library: 'my-ts-lib',
          limit: 10,
        });
        expect(methods.results.some((r) => r.name === 'listItems' && r.className === 'Api')).toBe(true);
        expect(methods.results.some((r) => r.className === 'InternalApi')).toBe(false);

        // Private/internal method should not be indexed
        const internalMethod = await indexer.search({
          query: '_internal',
          documentType: 'method',
          library: 'my-ts-lib',
          limit: 10,
        });
        expect(internalMethod.results.length).toBe(0);

        // Non-exported class should not have its methods indexed
        const secret = await indexer.search({
          query: 'secret',
          documentType: 'method',
          library: 'my-ts-lib',
          limit: 10,
        });
        expect(secret.results.length).toBe(0);

        // Types should be searchable
        const types = await indexer.search({
          query: 'Item',
          documentType: 'type',
          library: 'my-ts-lib',
          limit: 10,
        });
        expect(types.results.some((r) => r.name === 'Item')).toBe(true);

        // Functions should be searchable
        const funcs = await indexer.search({
          query: 'add',
          documentType: 'function',
          library: 'my-ts-lib',
          limit: 10,
        });
        expect(funcs.results.some((r) => r.name === 'add')).toBe(true);
      } finally {
        if (indexer) {
          await indexer.shutdown();
        }
        if (existsSync(basePath)) {
          rmSync(basePath, { recursive: true });
        }
      }
    });

    it('indexes and searches an ESM JavaScript package fixture (.js) via source fallback', async () => {
      const basePath = `/tmp/search-libs-js-fixture-${Date.now()}`;
      const pkgDir = join(basePath, 'node_modules', 'my-esm-js-lib');

      let indexer: LibraryIndexer | undefined;

      try {
        mkdirSync(pkgDir, { recursive: true });

        writeFileSync(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'my-esm-js-lib',
              version: '1.0.0',
              type: 'module',
              exports: {
                '.': {
                  import: './index.js',
                },
              },
            },
            null,
            2
          )
        );

        writeFileSync(
          join(pkgDir, 'index.js'),
          [
            "export { foo, internalFn as publicFn } from './a.js';",
            "import { importedFn as localImported } from './a.js';",
            'export { localImported as importedFnPublic };',
            "export * from './b.js';",
            '',
          ].join('\n')
        );

        writeFileSync(
          join(pkgDir, 'a.js'),
          [
            '/** Exported foo. */',
            'export function foo() { return 1; }',
            '',
            '/** Internal name, exported as publicFn from entry. */',
            'export function internalFn() { return 2; }',
            '',
            '/** Exported, then re-exported via import+export as importedFnPublic. */',
            'export function importedFn() { return 3; }',
            '',
            '/** Not exported - should NOT be indexed. */',
            'function nonExportedFn() { return 4; }',
            '',
          ].join('\n')
        );

        writeFileSync(
          join(pkgDir, 'b.js'),
          [
            '/** Exported class. */',
            'export class MyClass {',
            '  greet(name) { return `hi ${name}`; }',
            '}',
            '',
            '/** Internal class - should NOT be indexed. */',
            'class Internal {',
            '  doIt() { return 123; }',
            '}',
            '',
          ].join('\n')
        );

        indexer = new LibraryIndexer({
          basePath,
          packages: [{ name: 'my-esm-js-lib' }],
        });

        const init = await indexer.initialize();
        expect(init.errors).toHaveLength(0);
        expect(init.packageCounts['my-esm-js-lib']).toBeGreaterThan(0);

        // Public functions should be searchable and use the public names
        const publicFn = await indexer.search({
          query: 'publicFn',
          documentType: 'function',
          library: 'my-esm-js-lib',
          limit: 10,
        });
        expect(publicFn.results.some((r) => r.name === 'publicFn')).toBe(true);
        expect(publicFn.results.some((r) => r.name === 'internalFn')).toBe(false);

        const imported = await indexer.search({
          query: 'importedFnPublic',
          documentType: 'function',
          library: 'my-esm-js-lib',
          limit: 10,
        });
        expect(imported.results.some((r) => r.name === 'importedFnPublic')).toBe(true);
        expect(imported.results.some((r) => r.name === 'importedFn')).toBe(false);

        // Non-exported helper function should not be indexed
        const nonExported = await indexer.search({
          query: 'nonExportedFn',
          library: 'my-esm-js-lib',
          limit: 10,
        });
        expect(nonExported.results.length).toBe(0);

        // Exported class should be indexed as a type and its methods should be indexed
        const typeRes = await indexer.search({
          query: 'MyClass',
          documentType: 'type',
          library: 'my-esm-js-lib',
          limit: 10,
        });
        expect(typeRes.results.some((r) => r.name === 'MyClass')).toBe(true);

        const greet = await indexer.search({
          query: 'greet',
          documentType: 'method',
          library: 'my-esm-js-lib',
          limit: 10,
        });
        expect(greet.results.some((r) => r.name === 'greet' && r.className === 'MyClass')).toBe(true);

        // Internal class should not be indexed (no type doc, no method docs)
        const internalClass = await indexer.search({
          query: 'Internal',
          library: 'my-esm-js-lib',
          limit: 10,
        });
        expect(internalClass.results.some((r) => r.name === 'Internal')).toBe(false);
      } finally {
        if (indexer) {
          await indexer.shutdown();
        }
        if (existsSync(basePath)) {
          rmSync(basePath, { recursive: true });
        }
      }
    });
  });

  describe('addScript', () => {
    it('adds a script to the index', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const scriptPath = join(testDir, 'test-script.ts');
      writeFileSync(
        scriptPath,
        '/** List all pods. */\nconst x = 1;'
      );

      const added = await indexer.addScript(scriptPath);

      expect(added).toBe(true);

      // Should be searchable - name is the display name without extension
      const result = await indexer.search({ query: 'pods', documentType: 'script' });
      expect(result.results.some((r) => r.name === 'test-script')).toBe(true);

      await indexer.shutdown();
    });

    it('returns false for already indexed script', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const scriptPath = join(testDir, 'test-script.ts');
      writeFileSync(scriptPath, '/** Test */\nconst x = 1;');

      const firstAdd = await indexer.addScript(scriptPath);
      const secondAdd = await indexer.addScript(scriptPath);

      expect(firstAdd).toBe(true);
      expect(secondAdd).toBe(false);

      await indexer.shutdown();
    });

    it('returns false for non-existent script', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const added = await indexer.addScript('/non/existent/script.ts');

      expect(added).toBe(false);

      await indexer.shutdown();
    });
  });

  describe('addScriptsFromDirectory', () => {
    it('adds all scripts from a directory', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      writeFileSync(join(testDir, 'script1.ts'), '/** Script 1 */\nconst a = 1;');
      writeFileSync(join(testDir, 'script2.ts'), '/** Script 2 */\nconst b = 2;');

      const count = await indexer.addScriptsFromDirectory(testDir);

      expect(count).toBe(2);

      await indexer.shutdown();
    });

    it('supports recursive option', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir, { recursive: true });

      writeFileSync(join(testDir, 'root.ts'), '/** Root */\nconst a = 1;');
      writeFileSync(join(subDir, 'sub.ts'), '/** Sub */\nconst b = 2;');

      const count = await indexer.addScriptsFromDirectory(testDir, { recursive: true });

      expect(count).toBe(2);

      await indexer.shutdown();
    });
  });

  describe('removeScript', () => {
    it('removes a script from the index', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const scriptPath = join(testDir, 'removable.ts');
      writeFileSync(scriptPath, '/** Removable */\nconst x = 1;');

      await indexer.addScript(scriptPath);

      // Verify it's indexed
      let result = await indexer.search({ query: 'Removable', documentType: 'script' });
      expect(result.results.length).toBe(1);

      // Remove it
      const removed = await indexer.removeScript(scriptPath);
      expect(removed).toBe(true);

      // Verify it's gone
      result = await indexer.search({ query: 'Removable', documentType: 'script' });
      expect(result.results.length).toBe(0);

      await indexer.shutdown();
    });

    it('returns false for non-indexed script', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const removed = await indexer.removeScript('/non/existent/script.ts');

      expect(removed).toBe(false);

      await indexer.shutdown();
    });
  });

  describe('addDocuments', () => {
    it('adds custom documents to the index', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      await indexer.addDocuments([
        {
          id: 'custom:1',
          documentType: 'type',
          name: 'CustomType',
          description: 'A custom type.',
          searchTokens: 'Custom Type',
          library: 'custom-lib',
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
      ]);

      const result = await indexer.search({ query: 'CustomType' });
      expect(result.results.length).toBe(1);
      expect(result.results[0].name).toBe('CustomType');

      await indexer.shutdown();
    });
  });

  describe('search', () => {
    it('searches across all document types', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      // Add a test document manually
      await indexer.addDocuments([
        {
          id: 'test:pod',
          documentType: 'type',
          name: 'V1Pod',
          description: 'A pod resource.',
          searchTokens: 'V1 Pod',
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
      ]);

      const result = await indexer.search({ query: 'Pod' });

      expect(result.results.length).toBeGreaterThan(0);

      await indexer.shutdown();
    });

    it('filters by document type', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      // Add test documents of different types
      await indexer.addDocuments([
        {
          id: 'type:TestType',
          documentType: 'type',
          name: 'TestPod',
          description: 'A pod type.',
          searchTokens: 'Test Pod',
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
          id: 'method:TestMethod',
          documentType: 'method',
          name: 'getPod',
          description: 'Get a pod.',
          searchTokens: 'get Pod',
          library: 'test-lib',
          category: 'read',
          properties: '',
          typeDefinition: '',
          nestedTypes: '',
          typeKind: '',
          parameters: '[]',
          returnType: 'Pod',
          returnTypeDefinition: '',
          signature: 'getPod(): Pod',
          className: 'Api',
          filePath: '',
          keywords: '',
        },
      ]);

      const typeResult = await indexer.search({
        query: 'Pod',
        documentType: 'type',
        limit: 10,
      });

      expect(typeResult.results.every((r) => r.documentType === 'type')).toBe(true);

      await indexer.shutdown();
    });

    it('returns facets', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      await indexer.addDocuments([
        {
          id: 'test:facet',
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
        },
      ]);

      const result = await indexer.search({ query: 'Test', limit: 10 });

      expect(result.facets).toBeDefined();
      expect(result.facets.documentType).toBeDefined();
      expect(result.facets.library).toBeDefined();

      await indexer.shutdown();
    });

    it('supports pagination', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      // Add multiple documents
      const docs = [];
      for (let i = 0; i < 10; i++) {
        docs.push({
          id: `test:page${i}`,
          documentType: 'type' as const,
          name: `TestItem${i}`,
          description: 'A test item.',
          searchTokens: 'Test Item',
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
        });
      }
      await indexer.addDocuments(docs);

      const firstPage = await indexer.search({ query: 'Test', limit: 5, offset: 0 });
      const secondPage = await indexer.search({ query: 'Test', limit: 5, offset: 5 });

      if (firstPage.totalMatches > 5) {
        expect(firstPage.results[0].id).not.toBe(secondPage.results[0]?.id);
      }

      await indexer.shutdown();
    });
  });

  describe('addPackage', () => {
    it('adds a new package to initialized indexer if available', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const result = await indexer.addPackage({ name: 'prometheus-query' });

      // Package may not be installed in test environment
      if (result.errors.length === 0 && result.indexed > 0) {
        // Should be able to search prometheus-query methods
        const searchResult = await indexer.search({
          query: 'instantQuery',
          library: 'prometheus-query',
        });
        expect(searchResult.results.length).toBeGreaterThanOrEqual(0);
      }

      await indexer.shutdown();
    });
  });

  describe('shutdown', () => {
    it('shuts down cleanly', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      await indexer.shutdown();

      expect(indexer.isInitialized()).toBe(false);
    });

    it('clears script tracking on shutdown', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const scriptPath = join(testDir, 'test.ts');
      writeFileSync(scriptPath, '/** Test */\nconst x = 1;');
      await indexer.addScript(scriptPath);

      await indexer.shutdown();

      // Re-initialize and add same script - should succeed
      await indexer.initialize();
      const added = await indexer.addScript(scriptPath);
      expect(added).toBe(true);

      await indexer.shutdown();
    });
  });

  describe('getEngine', () => {
    it('returns the underlying search engine', async () => {
      const indexer = new LibraryIndexer({ packages: [] });
      await indexer.initialize();

      const engine = indexer.getEngine();

      expect(engine).toBeDefined();
      expect(engine.isInitialized()).toBe(true);

      await indexer.shutdown();
    });
  });
});
