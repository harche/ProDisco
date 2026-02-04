/**
 * Types for Prometheus client
 */

/**
 * Metric type as reported by Prometheus
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown';

/**
 * Information about a Prometheus metric
 */
export interface MetricInfo {
  /** Metric name (e.g., "http_requests_total") */
  name: string;

  /** Metric type (counter, gauge, histogram, summary) */
  type: MetricType;

  /** Help text / description */
  help: string;
}

/**
 * Metadata for a metric as returned by Prometheus API
 */
export interface MetricMetadata {
  type?: string;
  help?: string;
  unit?: string;
}

/**
 * Options for creating PrometheusClient
 */
export interface PrometheusClientOptions {
  /** Prometheus server endpoint (e.g., "http://prometheus:9090") */
  endpoint: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Custom headers for requests */
  headers?: Record<string, string>;

  /**
   * Use Kubernetes service account token for authentication.
   * When true, reads token from /var/run/secrets/kubernetes.io/serviceaccount/token
   * and adds it as Bearer token in Authorization header.
   * Useful for OpenShift and other Kubernetes environments with authenticated Prometheus.
   */
  useServiceAccountToken?: boolean;

  /**
   * Skip TLS certificate verification.
   * Use with caution - only for development or internal services with self-signed certs.
   */
  tlsSkipVerify?: boolean;
}

/**
 * Time range for range queries
 */
export interface TimeRange {
  /** Start time (Date or Unix timestamp in seconds) */
  start: Date | number;

  /** End time (Date or Unix timestamp in seconds) */
  end: Date | number;

  /** Step interval (e.g., "15s", "1m", "5m") */
  step: string;
}

/**
 * A single sample point in a time series
 */
export interface Sample {
  /** Unix timestamp in seconds */
  time: number;

  /** Metric value */
  value: number;
}

/**
 * A time series with labels and samples
 */
export interface TimeSeries {
  /** Metric labels */
  labels: Record<string, string>;

  /** Sample values */
  samples: Sample[];
}

/**
 * Result of an instant query
 */
export interface InstantQueryResult {
  /** Result type (vector, matrix, scalar, string) */
  resultType: 'vector' | 'matrix' | 'scalar' | 'string';

  /** Time series data */
  data: TimeSeries[];
}

/**
 * Result of a range query
 */
export interface RangeQueryResult {
  /** Result type (always matrix for range queries) */
  resultType: 'matrix';

  /** Time series data with multiple samples */
  data: TimeSeries[];
}
