/**
 * @prodisco/prometheus-client
 *
 * Typed Prometheus client with metric discovery for AI agents
 */

// Client
export { PrometheusClient } from './client.js';

// Metric discovery
export { MetricDiscovery, createMetricDiscovery } from './metrics.js';

// Types
export type {
  // Core types
  MetricType,
  MetricInfo,
  MetricMetadata,

  // Client options
  PrometheusClientOptions,

  // Query types
  TimeRange,
  Sample,
  TimeSeries,
  InstantQueryResult,
  RangeQueryResult,

  // Discovery types
  MetricDocument,
  MetricDiscoveryStatus,
  MetricDiscoveryOptions,
} from './types.js';
