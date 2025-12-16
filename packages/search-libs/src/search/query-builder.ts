/**
 * Fluent query builder for search options
 */

import type { SearchOptions } from './search-engine.js';

/**
 * Fluent builder for constructing search queries
 */
export class QueryBuilder {
  private options: SearchOptions = {
    query: '',
    limit: 10,
    offset: 0,
  };

  /**
   * Set the search query term
   */
  query(term: string): this {
    this.options.query = term;
    return this;
  }

  /**
   * Filter by document type
   */
  documentType(type: 'type' | 'method' | 'function' | 'script' | 'all'): this {
    this.options.documentType = type;
    return this;
  }

  /**
   * Filter by category
   */
  category(cat: string): this {
    this.options.category = cat;
    return this;
  }

  /**
   * Filter by library
   */
  library(lib: string): this {
    this.options.library = lib;
    return this;
  }

  /**
   * Exclude categories
   */
  excludeCategories(categories: string[]): this {
    this.options.exclude = {
      ...this.options.exclude,
      categories,
    };
    return this;
  }

  /**
   * Exclude libraries
   */
  excludeLibraries(libraries: string[]): this {
    this.options.exclude = {
      ...this.options.exclude,
      libraries,
    };
    return this;
  }

  /**
   * Set maximum results
   */
  limit(n: number): this {
    this.options.limit = n;
    return this;
  }

  /**
   * Set pagination offset
   */
  offset(n: number): this {
    this.options.offset = n;
    return this;
  }

  /**
   * Set pagination by page number (1-indexed)
   */
  page(pageNum: number, pageSize: number = 10): this {
    this.options.limit = pageSize;
    this.options.offset = (pageNum - 1) * pageSize;
    return this;
  }

  /**
   * Set field boost weights
   */
  boost(weights: Record<string, number>): this {
    this.options.boost = weights;
    return this;
  }

  /**
   * Build the final search options
   */
  build(): SearchOptions {
    return { ...this.options };
  }

  /**
   * Create a new QueryBuilder
   */
  static create(): QueryBuilder {
    return new QueryBuilder();
  }
}
