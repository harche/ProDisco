/**
 * Metric search engine using Orama for semantic search
 *
 * Indexes live Prometheus metrics and enables semantic search
 * by name and description, not just regex pattern matching.
 */

import { SearchEngine, type BaseDocument } from '@prodisco/search-libs';
import type { MetricInfo, MetricType } from './types.js';
import { PrometheusClient } from './client.js';

/**
 * Search options for finding metrics
 */
export interface MetricSearchOptions {
  /** Maximum number of results (default: 20) */
  limit?: number;

  /** Filter by metric type */
  type?: MetricType;
}

/**
 * MetricSearchEngine - Semantic search for Prometheus metrics
 *
 * Uses Orama search engine to index metric names and descriptions,
 * enabling natural language search like "memory consumption" instead
 * of requiring exact metric names.
 */
export class MetricSearchEngine {
  private client: PrometheusClient;
  private searchEngine: SearchEngine;
  private indexed = false;
  private indexedCount = 0;
  private lastIndexTime: number | null = null;

  /** Cache TTL in milliseconds (5 minutes) */
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(client: PrometheusClient) {
    this.client = client;
    this.searchEngine = new SearchEngine({
      tokenizerOptions: {
        stemming: true,
        stemmerSkipProperties: ['name'],
      },
    });
  }

  /**
   * Index all metrics from Prometheus into the search engine.
   *
   * @param force - Force re-indexing even if cache is valid
   */
  async index(force = false): Promise<number> {
    // Check if cache is still valid
    if (!force && this.indexed && this.lastIndexTime) {
      const elapsed = Date.now() - this.lastIndexTime;
      if (elapsed < MetricSearchEngine.CACHE_TTL_MS) {
        return this.indexedCount;
      }
    }

    // Fetch all metrics from Prometheus
    const metrics = await this.client.listMetrics();

    // Build documents for indexing
    const docs: BaseDocument[] = metrics.map((m) => ({
      id: `metric:${m.name}`,
      documentType: 'metric' as const,
      name: m.name,
      description: m.help,
      searchTokens: `${m.name.replace(/_/g, ' ')} ${m.type} ${m.help}`,
      library: 'prometheus',
      category: m.type,
      properties: '',
      typeDefinition: '',
      nestedTypes: '',
      typeKind: '',
      parameters: '',
      returnType: '',
      returnTypeDefinition: '',
      signature: '',
      className: '',
      filePath: '',
      keywords: m.type,
    }));

    // Re-initialize search engine for fresh index
    this.searchEngine = new SearchEngine({
      tokenizerOptions: {
        stemming: true,
        stemmerSkipProperties: ['name'],
      },
    });

    await this.searchEngine.initialize();
    await this.searchEngine.insertBatch(docs);

    this.indexed = true;
    this.indexedCount = docs.length;
    this.lastIndexTime = Date.now();

    return this.indexedCount;
  }

  /**
   * Search for metrics using natural language.
   *
   * Examples:
   * - "memory usage" → finds container_memory_usage_bytes, etc.
   * - "http requests" → finds http_requests_total, etc.
   * - "cpu" → finds all CPU-related metrics
   *
   * @param query - Natural language search query
   * @param options - Search options (limit, type filter)
   * @returns Ranked list of matching metrics
   */
  async search(query: string, options: MetricSearchOptions = {}): Promise<MetricInfo[]> {
    const { limit = 20, type } = options;

    if (!this.indexed) {
      await this.index();
    }

    const result = await this.searchEngine.search({
      query,
      limit,
      category: type,
    });

    return result.results.map((doc) => ({
      name: doc.name,
      type: (doc.category as MetricType) || 'unknown',
      help: doc.description,
    }));
  }

  /**
   * List all indexed metrics
   */
  async list(options: MetricSearchOptions = {}): Promise<MetricInfo[]> {
    const { limit = 100, type } = options;

    if (!this.indexed) {
      await this.index();
    }

    const result = await this.searchEngine.search({
      query: '',
      limit,
      category: type,
    });

    return result.results.map((doc) => ({
      name: doc.name,
      type: (doc.category as MetricType) || 'unknown',
      help: doc.description,
    }));
  }

  getIndexedCount(): number {
    return this.indexedCount;
  }

  isReady(): boolean {
    return this.indexed;
  }

  async clear(): Promise<void> {
    await this.searchEngine.shutdown();
    this.indexed = false;
    this.indexedCount = 0;
    this.lastIndexTime = null;
  }
}

/**
 * Create a MetricSearchEngine from a Prometheus endpoint
 */
export function createMetricSearchEngine(endpoint: string): MetricSearchEngine {
  const client = new PrometheusClient({ endpoint });
  return new MetricSearchEngine(client);
}
