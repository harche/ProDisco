/**
 * PrometheusClient - Typed wrapper around prometheus-query library
 *
 * IMPORTANT: This client executes PromQL queries. To DISCOVER available metrics,
 * use MetricSearchEngine.search() first.
 */

import * as fs from 'fs';
import * as https from 'https';
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

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

/**
 * Typed client for executing PromQL queries against Prometheus.
 *
 * NOTE: This client runs PromQL expressions. To discover available metrics,
 * use MetricSearchEngine.search() - it provides semantic search over metric
 * names and descriptions.
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

    // Build headers, optionally adding SA token
    const headers: Record<string, string> = { ...this.options.headers };

    if (this.options.useServiceAccountToken) {
      try {
        const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
        headers['Authorization'] = `Bearer ${token}`;
      } catch {
        // Token not available - running outside Kubernetes
      }
    }

    // Configure HTTPS agent for TLS options
    let httpsAgent: https.Agent | undefined;
    if (this.options.tlsSkipVerify) {
      httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    const { PrometheusDriver } = await import('prometheus-query');

    // Build driver options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driverOptions: any = {
      endpoint: this.options.endpoint,
      timeout: this.options.timeout,
    };

    if (Object.keys(headers).length > 0) {
      driverOptions.headers = headers;
    }

    // Use request interceptor to apply custom HTTPS agent
    if (httpsAgent) {
      driverOptions.requestInterceptor = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onFulfilled: (config: any) => {
          config.httpsAgent = httpsAgent;
          return config;
        },
      };
    }

    this.driver = new PrometheusDriver(driverOptions);

    return this.driver;
  }

  /**
   * Execute an instant PromQL query.
   *
   * This runs a PromQL expression and returns the current value.
   * You must already know the metric name - use MetricSearchEngine.search()
   * to discover available metrics first.
   *
   * @param promql - PromQL expression (e.g., "node_memory_MemTotal_bytes")
   * @param time - Optional evaluation time (defaults to now)
   * @returns Query result with time series data
   *
   * @example
   * // First discover metrics with MetricSearchEngine.search("memory")
   * // Then execute with known metric name:
   * const result = await client.execute("node_memory_MemTotal_bytes");
   */
  async execute(promql: string, time?: Date): Promise<InstantQueryResult> {
    const driver = await this.getDriver();
    const result = await driver.instantQuery(promql, time);

    return {
      resultType: result.resultType as InstantQueryResult['resultType'],
      data: this.parseTimeSeries(result.result),
    };
  }

  /**
   * Execute a range PromQL query over a time period.
   *
   * This runs a PromQL expression over a time range and returns samples.
   * You must already know the metric name - use MetricSearchEngine.search()
   * to discover available metrics first.
   *
   * @param promql - PromQL expression (e.g., "rate(http_requests_total[5m])")
   * @param range - Time range with start, end, and step
   * @returns Query result with time series data
   *
   * @example
   * // First discover metrics with MetricSearchEngine.search("memory")
   * // Then execute with known metric name:
   * const result = await client.executeRange("node_memory_MemTotal_bytes", {
   *   start: new Date(Date.now() - 3600000),
   *   end: new Date(),
   *   step: "5m"
   * });
   */
  async executeRange(promql: string, range: TimeRange): Promise<RangeQueryResult> {
    const driver = await this.getDriver();
    const start = range.start instanceof Date ? range.start : new Date(range.start * 1000);
    const end = range.end instanceof Date ? range.end : new Date(range.end * 1000);

    const result = await driver.rangeQuery(promql, start, end, range.step);

    return {
      resultType: 'matrix',
      data: this.parseTimeSeries(result.result),
    };
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
   * List all available metrics from the live Prometheus cluster.
   *
   * Returns raw metric metadata. For semantic search (e.g., "memory usage"),
   * use MetricSearchEngine instead.
   *
   * @returns Array of all available metrics with name, type, and description
   */
  async listMetrics(): Promise<MetricInfo[]> {
    const allMetadata = await this.metadata();
    const metrics: MetricInfo[] = [];

    for (const [name, entries] of Object.entries(allMetadata)) {
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
