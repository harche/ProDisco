/**
 * Orama search engine wrapper with typed search
 */

import {
  create,
  insert,
  insertMultiple,
  update,
  updateMultiple,
  search,
  remove,
  type Orama,
  type Results,
  type SearchParams,
} from '@orama/orama';
import { baseSchema, type BaseDocument, type OramaSchemaType } from '../schema/base-schema.js';
import { splitCamelCase } from '../extractor/ast-parser.js';

/**
 * Options for initializing the search engine
 */
export interface SearchEngineOptions {
  /** Custom schema (defaults to baseSchema) */
  schema?: OramaSchemaType;

  /** Tokenizer options */
  tokenizerOptions?: {
    stemming?: boolean;
    stemmerSkipProperties?: string[];
  };
}

/**
 * Search query options
 */
export interface SearchOptions {
  /** Full-text search term */
  query?: string;

  /** Filter by document type */
  documentType?: string;

  /** Filter by category */
  category?: string;

  /** Filter by library */
  library?: string;

  /** Exclusion filters */
  exclude?: {
    categories?: string[];
    libraries?: string[];
  };

  /** Maximum results (default: 10) */
  limit?: number;

  /** Pagination offset (default: 0) */
  offset?: number;

  /** Field boost weights */
  boost?: Record<string, number>;
}

/**
 * Search result
 */
export interface SearchResult<TDoc = BaseDocument> {
  /** Matched documents */
  results: TDoc[];

  /** Total matches before pagination */
  totalMatches: number;

  /** Facet counts */
  facets: {
    documentType: Record<string, number>;
    library: Record<string, number>;
    category: Record<string, number>;
  };

  /** Search execution time in ms */
  searchTime: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOrama = Orama<any>;

/**
 * Preprocess a search query by splitting camelCase terms.
 * This ensures queries like "readNamespacedPodLog" match indexed documents
 * that have "read Namespaced Pod Log" in their search tokens.
 *
 * Includes both the original term and the split version to handle cases like:
 * - "readNamespacedPodLog" → "readNamespacedPodLog read Namespaced Pod Log"
 * - "TeSt" → "TeSt" (no additional split since it's not useful camelCase)
 */
function preprocessQuery(query: string): string {
  const tokens: string[] = [];

  for (const word of query.split(/\s+/)) {
    if (!word) continue;

    // Always include the original word
    tokens.push(word);

    // Try camelCase splitting
    const split = splitCamelCase(word);

    // Only add the split version if:
    // 1. It's different from the original
    // 2. It produces tokens of reasonable length (at least 3 chars each)
    if (split !== word) {
      const splitParts = split.split(' ');
      const allPartsReasonable = splitParts.every((part) => part.length >= 3);
      if (allPartsReasonable) {
        tokens.push(split);
      }
    }
  }

  return tokens.join(' ');
}

/**
 * Search engine wrapping Orama
 */
export class SearchEngine<TDoc extends BaseDocument = BaseDocument> {
  private db: AnyOrama | null = null;
  private options: SearchEngineOptions;

  constructor(options: SearchEngineOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the search engine
   */
  async initialize(): Promise<void> {
    if (this.db) return;

    const schema = this.options.schema || baseSchema;

    this.db = await create({
      schema,
      components: {
        tokenizer: {
          stemming: this.options.tokenizerOptions?.stemming ?? true,
          stemmerSkipProperties: this.options.tokenizerOptions?.stemmerSkipProperties || [
            'name',
            'className',
            'library',
          ],
        },
      },
    });
  }

  /**
   * Insert a single document (uses update if document already exists)
   */
  async insert(doc: TDoc): Promise<void> {
    await this.ensureInitialized();
    try {
      await insert(this.db!, doc);
    } catch (error) {
      // If document already exists, update it instead
      if (error instanceof Error && error.message.includes('already exists')) {
        await update(this.db!, (doc as { id: string }).id, doc);
      } else {
        throw error;
      }
    }
  }

  /**
   * Insert multiple documents (uses update if documents already exist)
   */
  async insertBatch(docs: TDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.ensureInitialized();
    try {
      await insertMultiple(this.db!, docs);
    } catch (error) {
      // If some documents already exist, fall back to individual upserts
      if (error instanceof Error && error.message.includes('already exists')) {
        for (const doc of docs) {
          await this.insert(doc);
        }
      } else {
        throw error;
      }
    }
  }

  /**
   * Remove a document by ID
   */
  async remove(id: string): Promise<void> {
    await this.ensureInitialized();
    await remove(this.db!, id);
  }

  /**
   * Search the index
   */
  async search(options: SearchOptions): Promise<SearchResult<TDoc>> {
    await this.ensureInitialized();

    const {
      query = '',
      documentType,
      category,
      library,
      exclude,
      limit = 10,
      offset = 0,
      boost,
    } = options;

    const startTime = performance.now();

    // Preprocess query to split camelCase terms
    const processedQuery = preprocessQuery(query);

    // Build where clause for database-level filtering (more efficient than post-filtering)
    // For enum types in Orama, we need to use the 'eq' operator
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    if (documentType && documentType !== 'all') {
      where.documentType = { eq: documentType };
    }

    if (category) {
      where.category = { eq: category };
    }

    if (library) {
      where.library = { eq: library };
    }

    // Build search params
    const searchParams: SearchParams<AnyOrama, TDoc> = {
      term: processedQuery,
      properties: ['name', 'description', 'searchTokens', 'properties'],
      boost: boost || {
        name: 3,
        searchTokens: 2,
        description: 1,
        properties: 0.5,
      },
      tolerance: 1, // Allow fuzzy matching
      // Fetch more results for exclusion filtering
      limit: exclude ? Math.max(limit * 10, 500) : limit + offset + 50,
      facets: {
        documentType: {},
        library: {},
        category: {},
      },
      ...(Object.keys(where).length > 0 ? { where } : {}),
    };

    // Execute search
    const searchResult: Results<TDoc> = await search(this.db!, searchParams);

    // Extract query terms for ranking (split by whitespace, filter short terms)
    const queryTerms = processedQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 2);

    // Sort by relevance with custom ranking:
    // 1. Exact name match
    // 2. Name contains ALL query terms (higher = better)
    // 3. Orama's score
    const queryLower = query.toLowerCase();
    const sortedHits = [...searchResult.hits].sort((a, b) => {
      const aNameLower = a.document.name.toLowerCase();
      const bNameLower = b.document.name.toLowerCase();

      // Priority 1: Exact name match
      const aExact = aNameLower === queryLower;
      const bExact = bNameLower === queryLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // Priority 2: Count how many query terms appear in the name
      // Split names by camelCase to get individual tokens for matching
      // Note: Must split BEFORE lowercasing since camelCase detection needs case info
      const aNameTokens = splitCamelCase(a.document.name).toLowerCase().split(/\s+/);
      const bNameTokens = splitCamelCase(b.document.name).toLowerCase().split(/\s+/);

      // Check if query term matches (prefix match to handle plurals like "logs" → "log")
      const termMatches = (tokens: string[], term: string) =>
        tokens.some((token) => token.startsWith(term) || term.startsWith(token));

      const aTermCount = queryTerms.filter((term) => termMatches(aNameTokens, term)).length;
      const bTermCount = queryTerms.filter((term) => termMatches(bNameTokens, term)).length;

      // Boost documents where name contains more query terms
      if (aTermCount !== bTermCount) {
        return bTermCount - aTermCount;
      }

      // Priority 3: Fall back to Orama's score
      return (b.score || 0) - (a.score || 0);
    });

    // Apply exclusion filters (positive filters are handled by Orama's where clause)
    let filtered = sortedHits.map((hit) => hit.document);

    if (exclude?.categories) {
      filtered = filtered.filter(
        (doc) => !exclude.categories!.includes(doc.category)
      );
    }

    if (exclude?.libraries) {
      filtered = filtered.filter(
        (doc) => !exclude.libraries!.includes(doc.library)
      );
    }

    const totalMatches = filtered.length;

    // Apply pagination
    const paginated = filtered.slice(offset, offset + limit);

    const searchTime = performance.now() - startTime;

    return {
      results: paginated,
      totalMatches,
      facets: {
        documentType: (searchResult.facets?.documentType?.values || {}) as Record<string, number>,
        library: (searchResult.facets?.library?.values || {}) as Record<string, number>,
        category: (searchResult.facets?.category?.values || {}) as Record<string, number>,
      },
      searchTime,
    };
  }

  /**
   * Get the underlying Orama database
   */
  getDb(): AnyOrama | null {
    return this.db;
  }

  /**
   * Check if the engine is initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Shutdown the engine
   */
  async shutdown(): Promise<void> {
    this.db = null;
  }

  /**
   * Ensure the engine is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.db) {
      await this.initialize();
    }
  }
}
