/**
 * @prodisco/prometheus-client
 *
 * Typed Prometheus client with semantic metric discovery for AI agents
 */

// Client
export { PrometheusClient } from './client.js';

// Metric search
export {
  MetricSearchEngine,
  createMetricSearchEngine,
  type MetricSearchOptions,
} from './metrics.js';

// Types
export type {
  MetricType,
  MetricInfo,
  MetricMetadata,
  PrometheusClientOptions,
  TimeRange,
  Sample,
  TimeSeries,
  InstantQueryResult,
  RangeQueryResult,
} from './types.js';
