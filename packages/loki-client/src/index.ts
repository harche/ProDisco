/**
 * @prodisco/loki-client
 *
 * A TypeScript client for Grafana Loki REST API.
 * Provides a clean, typed interface for querying logs from Loki.
 */

// ============================================================================
// Types
// ============================================================================

export interface LokiClientOptions {
  /** Loki server URL (e.g., "http://localhost:3100") */
  baseUrl: string;
  /** Optional tenant ID for multi-tenant Loki */
  tenantId?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

export interface QueryRangeOptions {
  /** Start time (ISO string, Unix timestamp in seconds, or relative like "1h") */
  start?: string | number;
  /** End time (ISO string, Unix timestamp in seconds) */
  end?: string | number;
  /** Relative time range (e.g., "1h", "30m", "24h") - alternative to start/end */
  since?: string;
  /** Maximum number of log entries to return */
  limit?: number;
  /** Query direction: "forward" or "backward" (default: "backward") */
  direction?: 'forward' | 'backward';
}

export interface LabelValuesOptions {
  /** Start time for label values query */
  start?: string | number;
  /** End time for label values query */
  end?: string | number;
  /** Relative time range */
  since?: string;
  /** Optional LogQL query to filter label values */
  query?: string;
}

export interface LogEntry {
  /** Timestamp as Date object */
  timestamp: Date;
  /** Timestamp in nanoseconds (string) */
  timestampNanos: string;
  /** Log line content */
  line: string;
  /** Stream labels */
  labels: Record<string, string>;
}

export interface LogStream {
  /** Stream labels */
  labels: Record<string, string>;
  /** Log entries in this stream */
  entries: Array<{
    timestamp: Date;
    timestampNanos: string;
    line: string;
  }>;
}

export interface MetricSample {
  /** Timestamp as Date object */
  timestamp: Date;
  /** Metric value */
  value: number;
}

export interface MetricSeries {
  /** Metric labels */
  labels: Record<string, string>;
  /** Sample values over time */
  values: MetricSample[];
}

export interface QueryRangeLogsResult {
  /** Parsed log entries (flattened from all streams) */
  logs: LogEntry[];
  /** Raw streams with their labels */
  streams: LogStream[];
  /** Statistics from Loki */
  stats?: Record<string, unknown>;
}

export interface QueryRangeMatrixResult {
  /** Metric series */
  metrics: MetricSeries[];
  /** Statistics from Loki */
  stats?: Record<string, unknown>;
}

// ============================================================================
// LokiClient Implementation
// ============================================================================

export class LokiClient {
  private baseUrl: string;
  private tenantId?: string;
  private timeout: number;

  constructor(options: LokiClientOptions) {
    // Remove trailing slash from baseUrl
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.tenantId = options.tenantId;
    this.timeout = options.timeout ?? 30000;
  }

  /**
   * Build request headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.tenantId) {
      headers['X-Scope-OrgID'] = this.tenantId;
    }
    return headers;
  }

  /**
   * Make HTTP request to Loki
   */
  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, value);
        }
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Loki request failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse relative time string (e.g., "1h", "30m", "24h") to nanoseconds ago
   */
  private parseRelativeTime(since: string): string {
    const match = since.match(/^(\d+)(s|m|h|d|w)$/);
    if (!match) {
      throw new Error(`Invalid relative time format: ${since}. Use format like "1h", "30m", "24h"`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      's': 1,
      'm': 60,
      'h': 3600,
      'd': 86400,
      'w': 604800,
    };

    const seconds = value * multipliers[unit];
    const nowNanos = BigInt(Date.now()) * BigInt(1000000);
    const startNanos = nowNanos - BigInt(seconds) * BigInt(1000000000);
    return startNanos.toString();
  }

  /**
   * Convert time parameter to nanoseconds string
   */
  private timeToNanos(time: string | number | undefined, defaultValue?: string): string | undefined {
    if (time === undefined) return defaultValue;

    if (typeof time === 'number') {
      // Assume seconds, convert to nanoseconds
      return (BigInt(time) * BigInt(1000000000)).toString();
    }

    // Check if it's a relative time
    if (/^\d+(s|m|h|d|w)$/.test(time)) {
      return this.parseRelativeTime(time);
    }

    // Try parsing as ISO date
    const date = new Date(time);
    if (!isNaN(date.getTime())) {
      return (BigInt(date.getTime()) * BigInt(1000000)).toString();
    }

    // Return as-is (might be nanoseconds already)
    return time;
  }

  /**
   * Get current time in nanoseconds
   */
  private nowNanos(): string {
    return (BigInt(Date.now()) * BigInt(1000000)).toString();
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Get all label names.
   *
   * @example
   * const labels = await client.labels();
   * console.log(labels); // ["app", "namespace", "pod", ...]
   */
  async labels(options?: LabelValuesOptions): Promise<string[]> {
    let start: string | undefined;
    let end: string | undefined;

    if (options?.since) {
      start = this.parseRelativeTime(options.since);
      end = this.nowNanos();
    } else {
      start = this.timeToNanos(options?.start);
      end = this.timeToNanos(options?.end);
    }

    const params: Record<string, string> = {};
    if (start) params.start = start;
    if (end) params.end = end;

    const response = await this.request<{ status: string; data: string[] }>(
      '/loki/api/v1/labels',
      params
    );
    return response.data;
  }

  /**
   * Get all values for a specific label.
   *
   * @example
   * const namespaces = await client.labelValues('namespace');
   * console.log(namespaces); // ["default", "kube-system", ...]
   */
  async labelValues(label: string, options?: LabelValuesOptions): Promise<string[]> {
    let start: string | undefined;
    let end: string | undefined;

    if (options?.since) {
      start = this.parseRelativeTime(options.since);
      end = this.nowNanos();
    } else {
      start = this.timeToNanos(options?.start);
      end = this.timeToNanos(options?.end);
    }

    const params: Record<string, string> = {};
    if (start) params.start = start;
    if (end) params.end = end;
    if (options?.query) params.query = options.query;

    const response = await this.request<{ status: string; data: string[] }>(
      `/loki/api/v1/label/${encodeURIComponent(label)}/values`,
      params
    );
    return response.data;
  }

  /**
   * Get log stream series matching selectors.
   *
   * @example
   * const series = await client.series(['{namespace="default"}']);
   * console.log(series); // [{ app: "nginx", namespace: "default", ... }, ...]
   */
  async series(
    selectors: string[],
    options?: { start?: string | number; end?: string | number; since?: string }
  ): Promise<Record<string, string>[]> {
    let start: string | undefined;
    let end: string | undefined;

    if (options?.since) {
      start = this.parseRelativeTime(options.since);
      end = this.nowNanos();
    } else {
      start = this.timeToNanos(options?.start);
      end = this.timeToNanos(options?.end);
    }

    const params: Record<string, string> = {};
    if (start) params.start = start;
    if (end) params.end = end;
    // Loki expects multiple match[] parameters
    selectors.forEach((s, i) => {
      params[`match[${i}]`] = s;
    });

    const response = await this.request<{ status: string; data: Record<string, string>[] }>(
      '/loki/api/v1/series',
      params
    );
    return response.data;
  }

  /**
   * Query logs using LogQL. Returns parsed log entries.
   *
   * @example
   * const result = await client.queryRange('{namespace="kube-system"}', { since: '1h', limit: 100 });
   * result.logs.forEach(log => {
   *   console.log(`[${log.timestamp.toISOString()}] ${log.line}`);
   * });
   */
  async queryRange(logQL: string, options?: QueryRangeOptions): Promise<QueryRangeLogsResult> {
    let start: string | undefined;
    let end: string | undefined;

    if (options?.since) {
      start = this.parseRelativeTime(options.since);
      end = this.nowNanos();
    } else {
      start = this.timeToNanos(options?.start);
      end = this.timeToNanos(options?.end);
    }

    // Default to last hour if no time specified
    if (!start) {
      start = this.parseRelativeTime('1h');
    }
    if (!end) {
      end = this.nowNanos();
    }

    const params: Record<string, string> = {
      query: logQL,
      start,
      end,
    };
    if (options?.limit) params.limit = options.limit.toString();
    if (options?.direction) params.direction = options.direction;

    const response = await this.request<{
      status: string;
      data: {
        resultType: string;
        result: Array<{
          stream: Record<string, string>;
          values: Array<[string, string]>;
        }>;
        stats?: Record<string, unknown>;
      };
    }>('/loki/api/v1/query_range', params);

    // Parse streams result
    const streams: LogStream[] = response.data.result.map(stream => ({
      labels: stream.stream,
      entries: stream.values.map(([ts, line]) => ({
        timestamp: new Date(parseInt(ts.slice(0, -6), 10)),
        timestampNanos: ts,
        line,
      })),
    }));

    // Flatten logs for convenience
    const logs: LogEntry[] = streams.flatMap(stream =>
      stream.entries.map(entry => ({
        ...entry,
        labels: stream.labels,
      }))
    );

    // Sort by timestamp descending (most recent first)
    logs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return {
      logs,
      streams,
      stats: response.data.stats,
    };
  }

  /**
   * Query for matrix/metric results. Use for LogQL metric queries like rate() or count_over_time().
   *
   * @example
   * const result = await client.queryRangeMatrix('rate({app="nginx"}[5m])', { since: '1h' });
   * result.metrics.forEach(m => {
   *   console.log(m.labels, m.values);
   * });
   */
  async queryRangeMatrix(logQL: string, options?: QueryRangeOptions): Promise<QueryRangeMatrixResult> {
    let start: string | undefined;
    let end: string | undefined;

    if (options?.since) {
      start = this.parseRelativeTime(options.since);
      end = this.nowNanos();
    } else {
      start = this.timeToNanos(options?.start);
      end = this.timeToNanos(options?.end);
    }

    // Default to last hour if no time specified
    if (!start) {
      start = this.parseRelativeTime('1h');
    }
    if (!end) {
      end = this.nowNanos();
    }

    const params: Record<string, string> = {
      query: logQL,
      start,
      end,
    };
    if (options?.limit) params.limit = options.limit.toString();

    const response = await this.request<{
      status: string;
      data: {
        resultType: string;
        result: Array<{
          metric: Record<string, string>;
          values: Array<[number, string]>;
        }>;
        stats?: Record<string, unknown>;
      };
    }>('/loki/api/v1/query_range', params);

    // Parse matrix result
    const metrics: MetricSeries[] = response.data.result.map(series => ({
      labels: series.metric,
      values: series.values.map(([ts, val]) => ({
        timestamp: new Date(ts * 1000),
        value: parseFloat(val),
      })),
    }));

    return {
      metrics,
      stats: response.data.stats,
    };
  }

  /**
   * Check if Loki is ready.
   *
   * @example
   * const ready = await client.ready();
   * console.log(ready); // true
   */
  async ready(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/ready`, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Default export for convenience
export default LokiClient;
