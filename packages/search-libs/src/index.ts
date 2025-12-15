/**
 * @prodisco/search-libs
 *
 * Generic TypeScript library indexing and search using Orama.
 * Extract types, methods, and functions from any TypeScript library,
 * index scripts, and provide unified structured search for AI agents.
 */

// === Core Types ===
export type {
  ExtractedType,
  ExtractedMethod,
  ExtractedFunction,
  PropertyInfo,
  ParameterInfo,
  ExtractionOptions,
  ExtractionResult,
  ExtractionError,
} from './extractor/types.js';

export type { CachedScript } from './script/types.js';

// === Extractor API ===
export { extractFromPackage, extractFromFiles } from './extractor/index.js';

// === Script API ===
export { parseScript, parseScriptsFromDirectory } from './script/index.js';

// === Schema API ===
export { baseSchema, type BaseDocument } from './schema/base-schema.js';
export { buildSchema, buildDocument, type SchemaBuilderOptions } from './schema/schema-builder.js';

// === Search API ===
export { SearchEngine, type SearchOptions, type SearchResult } from './search/search-engine.js';
export { QueryBuilder } from './search/query-builder.js';
export {
  formatResults,
  formatForAI,
  type FormattedItem,
  type FormattedResult,
  type FormatOptions,
} from './search/result-formatter.js';

// === High-Level API ===
export { LibraryIndexer, type LibraryIndexerOptions, type PackageConfig } from './library-indexer.js';
