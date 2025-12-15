/**
 * Search module - Orama wrapper and utilities
 */

export {
  SearchEngine,
  type SearchEngineOptions,
  type SearchOptions,
  type SearchResult,
} from './search-engine.js';

export { QueryBuilder } from './query-builder.js';

export {
  formatResults,
  formatForAI,
  type FormattedItem,
  type FormattedResult,
  type FormatOptions,
} from './result-formatter.js';
