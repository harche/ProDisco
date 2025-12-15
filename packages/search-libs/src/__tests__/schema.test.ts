/**
 * Tests for the schema module
 */

import { describe, it, expect } from 'vitest';
import { baseSchema, type BaseDocument } from '../schema/base-schema.js';
import {
  buildTypeDocument,
  buildMethodDocument,
  buildFunctionDocument,
  buildScriptDocument,
} from '../schema/schema-builder.js';
import type { ExtractedType, ExtractedMethod, ExtractedFunction } from '../extractor/types.js';
import type { CachedScript } from '../script/types.js';

describe('Base Schema', () => {
  it('has required id field', () => {
    expect(baseSchema.id).toBe('string');
  });

  it('has documentType as enum', () => {
    expect(baseSchema.documentType).toBe('enum');
  });

  it('has name field for search', () => {
    expect(baseSchema.name).toBe('string');
  });

  it('has description field for search', () => {
    expect(baseSchema.description).toBe('string');
  });

  it('has searchTokens field for enhanced search', () => {
    expect(baseSchema.searchTokens).toBe('string');
  });

  it('has library and category as enum for filtering', () => {
    expect(baseSchema.library).toBe('enum');
    expect(baseSchema.category).toBe('enum');
  });

  it('has type-specific fields', () => {
    expect(baseSchema.properties).toBe('string');
    expect(baseSchema.typeDefinition).toBe('string');
    expect(baseSchema.nestedTypes).toBe('string');
    expect(baseSchema.typeKind).toBe('enum');
  });

  it('has method-specific fields', () => {
    expect(baseSchema.parameters).toBe('string');
    expect(baseSchema.returnType).toBe('string');
    expect(baseSchema.signature).toBe('string');
    expect(baseSchema.className).toBe('string');
  });

  it('has script-specific fields', () => {
    expect(baseSchema.filePath).toBe('string');
    expect(baseSchema.keywords).toBe('string');
  });
});

describe('Schema Builder', () => {
  describe('buildTypeDocument', () => {
    it('builds a document from ExtractedType', () => {
      const extractedType: ExtractedType = {
        name: 'V1Pod',
        kind: 'class',
        description: 'A Pod resource.',
        library: '@kubernetes/client-node',
        sourceFile: '/path/to/file.d.ts',
        properties: [
          { name: 'metadata', type: 'V1ObjectMeta', optional: true },
          { name: 'spec', type: 'V1PodSpec', optional: true },
        ],
        nestedTypes: ['V1ObjectMeta', 'V1PodSpec'],
      };

      const doc = buildTypeDocument(extractedType);

      // ID includes library for uniqueness
      expect(doc.id).toBe('type:@kubernetes/client-node:V1Pod');
      expect(doc.documentType).toBe('type');
      expect(doc.name).toBe('V1Pod');
      expect(doc.description).toBe('A Pod resource.');
      expect(doc.library).toBe('@kubernetes/client-node');
      expect(doc.category).toBe('class');
      expect(doc.typeKind).toBe('class');
      expect(doc.nestedTypes).toBe('V1ObjectMeta, V1PodSpec');
      expect(doc.searchTokens).toContain('V1Pod');
    });

    it('includes properties as JSON', () => {
      const extractedType: ExtractedType = {
        name: 'TestType',
        kind: 'interface',
        description: 'Test type.',
        library: 'test-lib',
        sourceFile: '/path/to/file.d.ts',
        properties: [
          { name: 'id', type: 'string', optional: false },
          { name: 'value', type: 'number', optional: true },
        ],
        nestedTypes: [],
      };

      const doc = buildTypeDocument(extractedType);
      const properties = JSON.parse(doc.properties);

      expect(properties.length).toBe(2);
      expect(properties[0].name).toBe('id');
      expect(properties[1].optional).toBe(true);
    });
  });

  describe('buildMethodDocument', () => {
    it('builds a document from ExtractedMethod', () => {
      const extractedMethod: ExtractedMethod = {
        name: 'listNamespacedPod',
        className: 'CoreV1Api',
        description: 'List pods in a namespace.',
        library: '@kubernetes/client-node',
        sourceFile: '/path/to/file.d.ts',
        parameters: [
          { name: 'namespace', type: 'string', optional: false },
          { name: 'pretty', type: 'string', optional: true },
        ],
        returnType: 'Promise<V1PodList>',
        isAsync: true,
        isStatic: false,
      };

      const doc = buildMethodDocument(extractedMethod);

      // ID includes library and className for uniqueness
      expect(doc.id).toBe('method:@kubernetes/client-node:CoreV1Api:listNamespacedPod');
      expect(doc.documentType).toBe('method');
      expect(doc.name).toBe('listNamespacedPod');
      expect(doc.description).toBe('List pods in a namespace.');
      expect(doc.library).toBe('@kubernetes/client-node');
      expect(doc.className).toBe('CoreV1Api');
      expect(doc.returnType).toBe('Promise<V1PodList>');
      expect(doc.searchTokens).toContain('listNamespacedPod');
    });

    it('extracts action category from method name', () => {
      const extractedMethod: ExtractedMethod = {
        name: 'createDeployment',
        className: 'AppsV1Api',
        description: 'Create a deployment.',
        library: '@kubernetes/client-node',
        sourceFile: '/path/to/file.d.ts',
        parameters: [],
        returnType: 'Promise<V1Deployment>',
        isAsync: true,
        isStatic: false,
      };

      const doc = buildMethodDocument(extractedMethod);

      expect(doc.category).toBe('create');
    });

    it('includes parameters as JSON', () => {
      const extractedMethod: ExtractedMethod = {
        name: 'getItem',
        className: 'Api',
        description: 'Get an item.',
        library: 'test-lib',
        sourceFile: '/path/to/file.d.ts',
        parameters: [
          { name: 'id', type: 'string', optional: false },
          { name: 'options', type: 'Options', optional: true },
        ],
        returnType: 'Promise<Item>',
        isAsync: true,
        isStatic: false,
      };

      const doc = buildMethodDocument(extractedMethod);
      const parameters = JSON.parse(doc.parameters);

      expect(parameters.length).toBe(2);
      expect(parameters[0].name).toBe('id');
      expect(parameters[1].optional).toBe(true);
    });

    it('builds signature from method info', () => {
      const extractedMethod: ExtractedMethod = {
        name: 'queryRange',
        className: 'LokiClient',
        description: 'Query logs over a time range.',
        library: '@prodisco/loki-client',
        sourceFile: '/path/to/file.d.ts',
        parameters: [
          { name: 'logQL', type: 'string', optional: false },
          { name: 'start', type: 'Date', optional: false },
          { name: 'end', type: 'Date', optional: false },
        ],
        returnType: 'Promise<QueryResult>',
        isAsync: true,
        isStatic: false,
      };

      const doc = buildMethodDocument(extractedMethod);

      expect(doc.signature).toContain('queryRange');
      expect(doc.signature).toContain('logQL');
    });
  });

  describe('buildFunctionDocument', () => {
    it('builds a document from ExtractedFunction', () => {
      const extractedFunction: ExtractedFunction = {
        name: 'mean',
        description: 'Calculate the arithmetic mean.',
        library: 'simple-statistics',
        sourceFile: '/path/to/file.d.ts',
        parameters: [{ name: 'values', type: 'number[]', optional: false }],
        returnType: 'number',
        isAsync: false,
        signature: 'mean(values: number[]): number',
      };

      const doc = buildFunctionDocument(extractedFunction);

      // ID includes library for uniqueness
      expect(doc.id).toBe('function:simple-statistics:mean');
      expect(doc.documentType).toBe('function');
      expect(doc.name).toBe('mean');
      expect(doc.description).toBe('Calculate the arithmetic mean.');
      expect(doc.library).toBe('simple-statistics');
      expect(doc.category).toBe('descriptive');
      expect(doc.returnType).toBe('number');
    });
  });

  describe('buildScriptDocument', () => {
    it('builds a document from CachedScript', () => {
      const script: CachedScript = {
        filename: 'list-pods.ts',
        filePath: '/path/to/list-pods.ts',
        description: 'List all pods in the cluster.',
        resourceTypes: ['pod'],
        keywords: ['list', 'pods', 'kubernetes'],
        apiClasses: ['CoreV1Api'],
      };

      const doc = buildScriptDocument(script);

      expect(doc.id).toBe('script:list-pods.ts');
      expect(doc.documentType).toBe('script');
      expect(doc.name).toBe('list-pods'); // Filename without .ts extension
      expect(doc.description).toBe('List all pods in the cluster.');
      expect(doc.library).toBe('CoreV1Api'); // First API class
      expect(doc.filePath).toBe('/path/to/list-pods.ts');
      expect(doc.keywords).toBe('list pods kubernetes');
    });

    it('handles empty keywords', () => {
      const script: CachedScript = {
        filename: 'empty-script.ts',
        filePath: '/path/to/empty-script.ts',
        description: 'A script with no keywords.',
        resourceTypes: [],
        keywords: [],
        apiClasses: [],
      };

      const doc = buildScriptDocument(script);

      expect(doc.keywords).toBe('');
    });
  });
});
