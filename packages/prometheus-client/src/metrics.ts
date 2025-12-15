/**
 * Metric discovery utilities for Prometheus
 */

import type {
  MetricInfo,
  MetricType,
  MetricDocument,
  MetricDiscoveryOptions,
} from './types.js';
import { PrometheusClient } from './client.js';

/**
 * MetricDiscovery - Discovers and manages Prometheus metrics
 */
export class MetricDiscovery {
  private client: PrometheusClient;
  private cachedMetrics: Map<string, MetricInfo> = new Map();

  constructor(client: PrometheusClient) {
    this.client = client;
  }

  /**
   * Discover all metrics from Prometheus
   *
   * @param options - Discovery options (filters, limits)
   * @returns Array of metric information
   */
  async discoverMetrics(options: MetricDiscoveryOptions = {}): Promise<MetricInfo[]> {
    const { nameFilter, typeFilter, limit } = options;

    const metadata = await this.client.metadata();
    const metrics: MetricInfo[] = [];

    for (const [name, entries] of Object.entries(metadata)) {
      // Apply name filter
      if (nameFilter && !nameFilter.test(name)) {
        continue;
      }

      const entry = Array.isArray(entries) ? entries[0] : entries;
      const type = this.normalizeMetricType(entry?.type);

      // Apply type filter
      if (typeFilter && !typeFilter.includes(type)) {
        continue;
      }

      const metricInfo: MetricInfo = {
        name,
        type,
        help: entry?.help || 'No description available',
      };

      metrics.push(metricInfo);
      this.cachedMetrics.set(name, metricInfo);

      // Apply limit
      if (limit && metrics.length >= limit) {
        break;
      }
    }

    return metrics;
  }

  /**
   * Get a specific metric's information
   *
   * @param name - Metric name
   * @returns Metric info if found
   */
  async getMetric(name: string): Promise<MetricInfo | undefined> {
    // Check cache first
    if (this.cachedMetrics.has(name)) {
      return this.cachedMetrics.get(name);
    }

    // Fetch from Prometheus
    const metadata = await this.client.metadata();
    const entries = metadata[name];

    if (!entries) {
      return undefined;
    }

    const entry = Array.isArray(entries) ? entries[0] : entries;
    const metricInfo: MetricInfo = {
      name,
      type: this.normalizeMetricType(entry?.type),
      help: entry?.help || 'No description available',
    };

    this.cachedMetrics.set(name, metricInfo);
    return metricInfo;
  }

  /**
   * Get metrics formatted as indexable documents for search-libs
   *
   * @param options - Discovery options
   * @returns Array of metric documents ready for indexing
   */
  async getIndexableMetrics(options: MetricDiscoveryOptions = {}): Promise<MetricDocument[]> {
    const metrics = await this.discoverMetrics(options);

    return metrics.map((metric) => ({
      id: `metric:${metric.name}`,
      documentType: 'metric' as const,
      name: metric.name,
      description: metric.help,
      searchTokens: this.buildSearchTokens(metric),
      library: 'prometheus',
      category: 'metric',
      metricType: metric.type,
    }));
  }

  /**
   * Get cached metrics (without fetching from Prometheus)
   */
  getCachedMetrics(): MetricInfo[] {
    return Array.from(this.cachedMetrics.values());
  }

  /**
   * Clear the metric cache
   */
  clearCache(): void {
    this.cachedMetrics.clear();
  }

  /**
   * Check if a metric exists
   *
   * @param name - Metric name
   * @returns True if metric exists
   */
  async metricExists(name: string): Promise<boolean> {
    if (this.cachedMetrics.has(name)) {
      return true;
    }

    const metric = await this.getMetric(name);
    return metric !== undefined;
  }

  /**
   * Get metrics by type
   *
   * @param type - Metric type to filter by
   * @returns Array of metrics matching the type
   */
  async getMetricsByType(type: MetricType): Promise<MetricInfo[]> {
    return this.discoverMetrics({ typeFilter: [type] });
  }

  /**
   * Search metrics by name pattern
   *
   * @param pattern - Regex pattern to match metric names
   * @returns Array of matching metrics
   */
  async searchMetrics(pattern: RegExp): Promise<MetricInfo[]> {
    return this.discoverMetrics({ nameFilter: pattern });
  }

  /**
   * Normalize metric type string to MetricType
   */
  private normalizeMetricType(type?: string): MetricType {
    if (!type) return 'unknown';

    const normalized = type.toLowerCase();
    switch (normalized) {
      case 'counter':
        return 'counter';
      case 'gauge':
        return 'gauge';
      case 'histogram':
        return 'histogram';
      case 'summary':
        return 'summary';
      default:
        return 'unknown';
    }
  }

  /**
   * Build search tokens from metric info
   */
  private buildSearchTokens(metric: MetricInfo): string {
    const nameParts = metric.name.replace(/_/g, ' ');
    return `${nameParts} ${metric.type} ${metric.help}`;
  }
}

/**
 * Create a MetricDiscovery instance from a Prometheus endpoint
 *
 * @param endpoint - Prometheus server URL
 * @returns MetricDiscovery instance
 */
export function createMetricDiscovery(endpoint: string): MetricDiscovery {
  const client = new PrometheusClient({ endpoint });
  return new MetricDiscovery(client);
}
