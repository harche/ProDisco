/**
 * PrometheusClient - Typed wrapper around prometheus-query library
 */

import type {
  PrometheusClientOptions,
  TimeRange,
  InstantQueryResult,
  RangeQueryResult,
  Sample,
  TimeSeries,
  MetricInfo,
} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrometheusDriver = any;

/**
 * Typed client for Prometheus queries
 */
export class PrometheusClient {
  private options: PrometheusClientOptions;
  private driver: AnyPrometheusDriver = null;

  constructor(options: PrometheusClientOptions) {
    this.options = {
      timeout: 30000,
      ...options,
    };
  }

  /**
   * Get the Prometheus endpoint URL
   */
  getEndpoint(): string {
    return this.options.endpoint;
  }

  /**
   * Initialize the Prometheus driver
   */
  private async getDriver(): Promise<AnyPrometheusDriver> {
    if (this.driver) {
      return this.driver;
    }

    const { PrometheusDriver } = await import('prometheus-query');
    this.driver = new PrometheusDriver({
      endpoint: this.options.endpoint,
      timeout: this.options.timeout,
    });

    return this.driver;
  }

  /**
   * Execute an instant query
   *
   * @param query - PromQL query string
   * @param time - Optional evaluation time (defaults to now)
   * @returns Query result with time series data
   */
  async instantQuery(query: string, time?: Date): Promise<InstantQueryResult> {
    const driver = await this.getDriver();
    const result = await driver.instantQuery(query, time);

    return {
      resultType: result.resultType as InstantQueryResult['resultType'],
      data: this.parseTimeSeries(result.result),
    };
  }

  /**
   * Execute a range query
   *
   * @param query - PromQL query string
   * @param range - Time range with start, end, and step
   * @returns Query result with time series data
   */
  async rangeQuery(query: string, range: TimeRange): Promise<RangeQueryResult> {
    const driver = await this.getDriver();
    const start = range.start instanceof Date ? range.start : new Date(range.start * 1000);
    const end = range.end instanceof Date ? range.end : new Date(range.end * 1000);

    const result = await driver.rangeQuery(query, start, end, range.step);

    return {
      resultType: 'matrix',
      data: this.parseTimeSeries(result.result),
    };
  }

  /**
   * Execute a range query (alias for rangeQuery)
   *
   * This alias matches Prometheus API naming convention (query_range).
   *
   * @param query - PromQL query string
   * @param range - Time range with start, end, and step
   * @returns Query result with time series data
   */
  async queryRange(query: string, range: TimeRange): Promise<RangeQueryResult> {
    return this.rangeQuery(query, range);
  }

  /**
   * Execute an instant query (alias for instantQuery)
   *
   * This alias matches Prometheus API naming convention.
   *
   * @param query - PromQL query string
   * @param time - Optional evaluation time (defaults to now)
   * @returns Query result with time series data
   */
  async query(query: string, time?: Date): Promise<InstantQueryResult> {
    return this.instantQuery(query, time);
  }

  /**
   * Get all label names
   */
  async labelNames(): Promise<string[]> {
    const driver = await this.getDriver();
    return driver.labelNames();
  }

  /**
   * Get all values for a label
   *
   * @param label - Label name
   * @returns Array of label values
   */
  async labelValues(label: string): Promise<string[]> {
    const driver = await this.getDriver();
    return driver.labelValues(label);
  }

  /**
   * Get metric metadata from Prometheus
   *
   * @returns Map of metric name to metadata array
   */
  async metadata(): Promise<Record<string, MetadataEntry[]>> {
    const driver = await this.getDriver();
    return driver.metadata();
  }

  /**
   * Get all series matching a set of label matchers
   *
   * @param match - Label matcher expressions
   * @param start - Optional start time
   * @param end - Optional end time
   * @returns Array of label sets
   */
  async series(
    match: string[],
    start?: Date,
    end?: Date
  ): Promise<Record<string, string>[]> {
    const driver = await this.getDriver();
    return driver.series(match, start, end);
  }

  /**
   * Check if Prometheus is reachable
   */
  async isHealthy(): Promise<boolean> {
    try {
      const driver = await this.getDriver();
      // Try to get label names as a health check
      await driver.labelNames();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find available metrics in the live Prometheus cluster.
   *
   * Use this to discover what metrics (memory, cpu, disk, network, etc.) are
   * available before querying. Returns metric names with their types and descriptions.
   *
   * @param pattern - Optional regex pattern to filter metrics (e.g., /memory/i, /node_cpu/i)
   * @returns Array of available metrics with name, type, and description
   *
   * @example
   * // Find all memory-related metrics
   * const metrics = await prom.findMetrics(/memory/i);
   * console.log(metrics.map(m => m.name));
   *
   * @example
   * // Find all node metrics
   * const nodeMetrics = await prom.findMetrics(/^node_/);
   *
   * @example
   * // List all available metrics
   * const allMetrics = await prom.findMetrics();
   */
  async findMetrics(pattern?: RegExp): Promise<MetricInfo[]> {
    const allMetadata = await this.metadata();
    const metrics: MetricInfo[] = [];

    for (const [name, entries] of Object.entries(allMetadata)) {
      // Apply pattern filter if provided
      if (pattern && !pattern.test(name)) {
        continue;
      }

      const entry = Array.isArray(entries) ? entries[0] : entries;
      metrics.push({
        name,
        type: (entry?.type as MetricInfo['type']) || 'unknown',
        help: entry?.help || 'No description available',
      });
    }

    return metrics;
  }

  /**
   * List all available metrics in the live Prometheus cluster.
   *
   * Alias for findMetrics() without a pattern - returns all metrics.
   *
   * @returns Array of all available metrics with name, type, and description
   */
  async listMetrics(): Promise<MetricInfo[]> {
    return this.findMetrics();
  }

  /**
   * Parse time series from prometheus-query result
   */
  private parseTimeSeries(result: PrometheusResult[]): TimeSeries[] {
    return result.map((series) => ({
      labels: series.metric.labels || {},
      samples: this.parseSamples(series.values || (series.value ? [series.value] : [])),
    }));
  }

  /**
   * Parse sample values
   */
  private parseSamples(values: SampleTuple[]): Sample[] {
    return values.filter((v): v is SampleTuple => v !== undefined).map((v) => ({
      time: typeof v.time === 'number' ? v.time : v.time.getTime() / 1000,
      value: typeof v.value === 'string' ? parseFloat(v.value) : v.value,
    }));
  }
}

// Type definitions for prometheus-query library internals
interface PrometheusResult {
  metric: {
    labels?: Record<string, string>;
    name?: string;
  };
  value?: SampleTuple;
  values?: SampleTuple[];
}

interface SampleTuple {
  time: Date | number;
  value: string | number;
}

interface MetadataEntry {
  type?: string;
  help?: string;
  unit?: string;
}
