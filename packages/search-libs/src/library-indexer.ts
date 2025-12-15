/**
 * LibraryIndexer - High-level API for indexing and searching TypeScript libraries
 */

import type { ExtractionError, ExtractionResult, ExtractedType, ExtractedMethod } from './extractor/types.js';
import type { CachedScript } from './script/types.js';
import type { BaseDocument } from './schema/base-schema.js';
import type { SearchOptions, SearchResult } from './search/search-engine.js';

import { extractFromPackage } from './extractor/index.js';
import { parseScript, parseScriptsFromDirectory } from './script/index.js';
import {
  buildTypeDocument,
  buildMethodDocument,
  buildFunctionDocument,
  buildScriptDocument,
} from './schema/schema-builder.js';
import { SearchEngine } from './search/search-engine.js';

/**
 * Build a compact type definition string for an extracted type.
 * Recursively expands nested type references up to maxDepth levels.
 */
function buildCompactTypeDefinition(
  type: ExtractedType,
  typeRegistry: Map<string, ExtractedType>,
  depth: number = 0,
  maxDepth: number = 2
): string {
  const props = type.properties
    .slice(0, 10)
    .map(p => {
      let propType = p.type;

      // Recursively expand nested types if we haven't hit max depth
      if (depth < maxDepth && !isPrimitiveOrBuiltin(p.type)) {
        const baseTypeName = extractBaseTypeName(p.type);
        const nestedType = typeRegistry.get(baseTypeName);

        if (nestedType) {
          const nestedDef = buildCompactTypeDefinition(nestedType, typeRegistry, depth + 1, maxDepth);
          // Preserve array notation
          if (p.type.endsWith('[]')) {
            propType = `${nestedDef}[]`;
          } else if (p.type.startsWith('Array<')) {
            propType = `${nestedDef}[]`;
          } else {
            propType = nestedDef;
          }
        }
      }

      return `${p.name}${p.optional ? '?' : ''}: ${propType}`;
    })
    .join(', ');
  const more = type.properties.length > 10 ? `, ... +${type.properties.length - 10} more` : '';
  return `{ ${props}${more} }`;
}

/**
 * Expand parameter types using a type registry
 */
function expandMethodTypes(
  method: ExtractedMethod,
  typeRegistry: Map<string, ExtractedType>
): ExtractedMethod {
  // Expand parameter types
  const expandedParams = method.parameters.map(param => {
    // Skip primitives and built-in types
    if (isPrimitiveOrBuiltin(param.type)) {
      return param;
    }

    // Extract the base type name (handle Promise<X>, Array<X>, etc.)
    const baseTypeName = extractBaseTypeName(param.type);
    const typeInfo = typeRegistry.get(baseTypeName);

    if (typeInfo) {
      return {
        ...param,
        typeDefinition: buildCompactTypeDefinition(typeInfo, typeRegistry),
      };
    }
    return param;
  });

  // Expand return type
  let returnTypeDefinition: string | undefined;
  const returnBaseType = extractBaseTypeName(method.returnType);
  const returnTypeInfo = typeRegistry.get(returnBaseType);
  if (returnTypeInfo && !isPrimitiveOrBuiltin(method.returnType)) {
    returnTypeDefinition = buildCompactTypeDefinition(returnTypeInfo, typeRegistry);
  }

  return {
    ...method,
    parameters: expandedParams,
    returnTypeDefinition,
  };
}

/**
 * Check if a type is a primitive or built-in type
 */
function isPrimitiveOrBuiltin(typeName: string): boolean {
  const primitives = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined',
    'any', 'unknown', 'never', 'object', 'Date', 'RegExp',
    'Promise', 'Array', 'Map', 'Set', 'Record',
  ]);

  const baseType = extractBaseTypeName(typeName);
  return primitives.has(baseType);
}

/**
 * Extract the base type name from a complex type
 * e.g., "Promise<TimeRange>" -> "TimeRange"
 *       "Array<Sample>" -> "Sample"
 *       "TimeRange" -> "TimeRange"
 */
function extractBaseTypeName(typeName: string): string {
  // Handle Promise<X>, Array<X>, etc.
  const genericMatch = typeName.match(/^(?:Promise|Array|Set|Map)<(.+)>$/);
  if (genericMatch) {
    return extractBaseTypeName(genericMatch[1]);
  }

  // Handle arrays like X[]
  if (typeName.endsWith('[]')) {
    return extractBaseTypeName(typeName.slice(0, -2));
  }

  // Handle union types - take the first non-null type
  if (typeName.includes('|')) {
    const parts = typeName.split('|').map(p => p.trim());
    for (const part of parts) {
      if (part !== 'null' && part !== 'undefined') {
        return extractBaseTypeName(part);
      }
    }
  }

  return typeName.trim();
}

/**
 * Configuration for a package to index
 */
export interface PackageConfig {
  /** npm package name (e.g., "@kubernetes/client-node") */
  name: string;

  /** Filter for type names */
  typeFilter?: RegExp | ((name: string) => boolean);

  /** Filter for method/function names */
  methodFilter?: RegExp | ((name: string) => boolean);

  /** Filter for class names (only extract methods from matching classes) */
  classFilter?: RegExp | ((name: string) => boolean);
}

/**
 * Options for LibraryIndexer
 */
export interface LibraryIndexerOptions {
  /** List of packages to index */
  packages: PackageConfig[];

  /** Base path for node_modules (default: process.cwd()) */
  basePath?: string;
}

/**
 * Result of initialization
 */
export interface InitializeResult {
  /** Total documents indexed */
  indexed: number;

  /** Errors encountered during extraction */
  errors: ExtractionError[];

  /** Per-package counts */
  packageCounts: Record<string, number>;
}

/**
 * High-level API for indexing and searching TypeScript libraries
 */
export class LibraryIndexer {
  private options: LibraryIndexerOptions;
  private engine: SearchEngine;
  private initialized = false;
  private indexedScripts = new Set<string>();

  constructor(options: LibraryIndexerOptions) {
    this.options = options;
    this.engine = new SearchEngine();
  }

  /**
   * Initialize the indexer - extracts and indexes all configured packages
   */
  async initialize(): Promise<InitializeResult> {
    if (this.initialized) {
      return { indexed: 0, errors: [], packageCounts: {} };
    }

    await this.engine.initialize();

    const errors: ExtractionError[] = [];
    const packageCounts: Record<string, number> = {};
    let totalIndexed = 0;

    for (const packageConfig of this.options.packages) {
      const result = await this.indexPackage(packageConfig);
      errors.push(...result.errors);
      packageCounts[packageConfig.name] = result.indexed;
      totalIndexed += result.indexed;
    }

    this.initialized = true;

    return {
      indexed: totalIndexed,
      errors,
      packageCounts,
    };
  }

  /**
   * Index a single package
   */
  private async indexPackage(
    config: PackageConfig
  ): Promise<{ indexed: number; errors: ExtractionError[] }> {
    const result: ExtractionResult = extractFromPackage({
      packageName: config.name,
      typeFilter: config.typeFilter,
      methodFilter: config.methodFilter,
      classFilter: config.classFilter,
      basePath: this.options.basePath,
    });

    const documents: BaseDocument[] = [];

    // Build a type registry for expanding method parameter/return types
    const typeRegistry = new Map<string, ExtractedType>();
    for (const type of result.types) {
      typeRegistry.set(type.name, type);
    }

    // Build documents from extracted types
    for (const type of result.types) {
      documents.push(buildTypeDocument(type));
    }

    // Build documents from extracted methods with expanded types
    for (const method of result.methods) {
      const expandedMethod = expandMethodTypes(method, typeRegistry);
      documents.push(buildMethodDocument(expandedMethod));
    }

    // Build documents from extracted functions
    for (const func of result.functions) {
      documents.push(buildFunctionDocument(func));
    }

    // Insert all documents
    if (documents.length > 0) {
      await this.engine.insertBatch(documents);
    }

    return {
      indexed: documents.length,
      errors: result.errors,
    };
  }

  /**
   * Add a script to the index
   */
  async addScript(filePath: string): Promise<boolean> {
    await this.ensureInitialized();

    // Skip if already indexed
    if (this.indexedScripts.has(filePath)) {
      return false;
    }

    const script = parseScript(filePath);
    if (!script) {
      return false;
    }

    const doc = buildScriptDocument(script);
    await this.engine.insert(doc);
    this.indexedScripts.add(filePath);

    return true;
  }

  /**
   * Add all scripts from a directory
   */
  async addScriptsFromDirectory(
    dirPath: string,
    options?: { recursive?: boolean }
  ): Promise<number> {
    await this.ensureInitialized();

    const scripts = parseScriptsFromDirectory(dirPath, {
      recursive: options?.recursive,
    });

    let added = 0;

    for (const script of scripts) {
      if (!this.indexedScripts.has(script.filePath)) {
        const doc = buildScriptDocument(script);
        await this.engine.insert(doc);
        this.indexedScripts.add(script.filePath);
        added++;
      }
    }

    return added;
  }

  /**
   * Remove a script from the index
   */
  async removeScript(filePath: string): Promise<boolean> {
    if (!this.indexedScripts.has(filePath)) {
      return false;
    }

    // Find the script filename to build the ID
    const filename = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
    const id = `script:${filename}`;

    try {
      await this.engine.remove(id);
      this.indexedScripts.delete(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add custom documents to the index
   */
  async addDocuments(docs: BaseDocument[]): Promise<void> {
    await this.ensureInitialized();
    await this.engine.insertBatch(docs);
  }

  /**
   * Search the index
   */
  async search(options: SearchOptions): Promise<SearchResult<BaseDocument>> {
    await this.ensureInitialized();
    return this.engine.search(options);
  }

  /**
   * Get the underlying search engine
   */
  getEngine(): SearchEngine {
    return this.engine;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Shutdown the indexer
   */
  async shutdown(): Promise<void> {
    await this.engine.shutdown();
    this.initialized = false;
    this.indexedScripts.clear();
  }

  /**
   * Add a new package to an already-initialized indexer
   */
  async addPackage(
    config: PackageConfig
  ): Promise<{ indexed: number; errors: ExtractionError[] }> {
    await this.ensureInitialized();
    return this.indexPackage(config);
  }

  /**
   * Ensure the indexer is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
