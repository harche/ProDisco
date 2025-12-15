# @prodisco/prometheus-client

Typed Prometheus client with metric discovery for AI agents. Wraps the `prometheus-query` library with a clean TypeScript interface.

## Features

- **Typed Queries**: Full TypeScript support for instant and range queries
- **Metric Discovery**: Discover and catalog all metrics from a Prometheus server
- **Search Integration**: Get metrics as indexable documents for `@prodisco/search-libs`
- **Caching**: Built-in metric caching to reduce API calls

## Installation

```bash
npm install @prodisco/prometheus-client
```

## Quick Start

```typescript
import { PrometheusClient, MetricDiscovery } from '@prodisco/prometheus-client';

// Create a client
const client = new PrometheusClient({
  endpoint: 'http://prometheus:9090',
});

// Execute an instant query
const result = await client.instantQuery('up');
console.log(result.data);

// Discover all metrics
const discovery = new MetricDiscovery(client);
const metrics = await discovery.discoverMetrics();
console.log(`Found ${metrics.length} metrics`);
```

## API Reference

### PrometheusClient

The main client for executing Prometheus queries.

```typescript
import { PrometheusClient } from '@prodisco/prometheus-client';

const client = new PrometheusClient({
  endpoint: 'http://prometheus:9090',
  timeout: 30000, // optional, default 30s
});
```

#### Methods

##### `instantQuery(query: string, time?: Date): Promise<InstantQueryResult>`

Execute an instant query at a specific point in time.

```typescript
const result = await client.instantQuery('http_requests_total');

// With specific time
const result = await client.instantQuery('http_requests_total', new Date('2024-01-01'));
```

##### `rangeQuery(query: string, range: TimeRange): Promise<RangeQueryResult>`

Execute a range query over a time period.

```typescript
const result = await client.rangeQuery('rate(http_requests_total[5m])', {
  start: new Date('2024-01-01'),
  end: new Date('2024-01-02'),
  step: '1m',
});

// Or with Unix timestamps
const result = await client.rangeQuery('cpu_usage', {
  start: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  end: Math.floor(Date.now() / 1000),
  step: '15s',
});
```

##### `labelNames(): Promise<string[]>`

Get all label names.

```typescript
const labels = await client.labelNames();
// ['__name__', 'instance', 'job', 'pod', 'namespace', ...]
```

##### `labelValues(label: string): Promise<string[]>`

Get all values for a specific label.

```typescript
const jobs = await client.labelValues('job');
// ['prometheus', 'node-exporter', 'kubernetes-pods', ...]
```

##### `metadata(): Promise<Record<string, MetadataEntry[]>>`

Get metric metadata from Prometheus.

```typescript
const metadata = await client.metadata();
// {
//   'http_requests_total': [{ type: 'counter', help: 'Total HTTP requests' }],
//   'cpu_usage': [{ type: 'gauge', help: 'CPU usage percentage' }],
//   ...
// }
```

##### `series(match: string[], start?: Date, end?: Date): Promise<Record<string, string>[]>`

Get all series matching label matchers.

```typescript
const series = await client.series(['{job="prometheus"}']);
// [{ __name__: 'up', job: 'prometheus', instance: 'localhost:9090' }, ...]
```

##### `isHealthy(): Promise<boolean>`

Check if Prometheus is reachable.

```typescript
const healthy = await client.isHealthy();
if (!healthy) {
  console.error('Prometheus is not reachable');
}
```

### MetricDiscovery

Discover and manage Prometheus metrics for indexing.

```typescript
import { PrometheusClient, MetricDiscovery } from '@prodisco/prometheus-client';

const client = new PrometheusClient({ endpoint: 'http://prometheus:9090' });
const discovery = new MetricDiscovery(client);
```

#### Methods

##### `discoverMetrics(options?: MetricDiscoveryOptions): Promise<MetricInfo[]>`

Discover all metrics from Prometheus.

```typescript
// Get all metrics
const metrics = await discovery.discoverMetrics();

// Filter by name pattern
const httpMetrics = await discovery.discoverMetrics({
  nameFilter: /^http_/,
});

// Filter by type
const counters = await discovery.discoverMetrics({
  typeFilter: ['counter'],
});

// Limit results
const topMetrics = await discovery.discoverMetrics({
  limit: 100,
});
```

##### `getMetric(name: string): Promise<MetricInfo | undefined>`

Get information about a specific metric.

```typescript
const metric = await discovery.getMetric('http_requests_total');
if (metric) {
  console.log(`${metric.name}: ${metric.type} - ${metric.help}`);
}
```

##### `getIndexableMetrics(options?: MetricDiscoveryOptions): Promise<MetricDocument[]>`

Get metrics formatted as documents for `@prodisco/search-libs`.

```typescript
const docs = await discovery.getIndexableMetrics();

// Use with search-libs
import { LibraryIndexer } from '@prodisco/search-libs';
const indexer = new LibraryIndexer({ packages: [] });
await indexer.initialize();
await indexer.addDocuments(docs);
```

##### `getMetricsByType(type: MetricType): Promise<MetricInfo[]>`

Get all metrics of a specific type.

```typescript
const gauges = await discovery.getMetricsByType('gauge');
const counters = await discovery.getMetricsByType('counter');
```

##### `searchMetrics(pattern: RegExp): Promise<MetricInfo[]>`

Search metrics by name pattern.

```typescript
const k8sMetrics = await discovery.searchMetrics(/^kube_/);
const nodeMetrics = await discovery.searchMetrics(/^node_/);
```

##### `getCachedMetrics(): MetricInfo[]`

Get previously discovered metrics from cache.

```typescript
const cached = discovery.getCachedMetrics();
```

##### `clearCache(): void`

Clear the metric cache.

```typescript
discovery.clearCache();
```

### Helper Function

##### `createMetricDiscovery(endpoint: string): MetricDiscovery`

Create a MetricDiscovery instance directly from an endpoint.

```typescript
import { createMetricDiscovery } from '@prodisco/prometheus-client';

const discovery = createMetricDiscovery('http://prometheus:9090');
const metrics = await discovery.discoverMetrics();
```

## Types

### MetricInfo

Information about a Prometheus metric.

```typescript
interface MetricInfo {
  name: string;      // Metric name (e.g., "http_requests_total")
  type: MetricType;  // 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown'
  help: string;      // Description
}
```

### MetricDocument

Document format compatible with `@prodisco/search-libs`.

```typescript
interface MetricDocument {
  id: string;            // "metric:http_requests_total"
  documentType: 'metric';
  name: string;
  description: string;
  searchTokens: string;
  library: string;       // "prometheus"
  category: string;      // "metric"
  metricType: string;
}
```

### TimeRange

Time range for range queries.

```typescript
interface TimeRange {
  start: Date | number;  // Start time
  end: Date | number;    // End time
  step: string;          // Step interval (e.g., "15s", "1m")
}
```

### InstantQueryResult / RangeQueryResult

Query results with time series data.

```typescript
interface InstantQueryResult {
  resultType: 'vector' | 'matrix' | 'scalar' | 'string';
  data: TimeSeries[];
}

interface TimeSeries {
  labels: Record<string, string>;
  samples: Sample[];
}

interface Sample {
  time: number;   // Unix timestamp
  value: number;  // Metric value
}
```

## Integration with search-libs

The prometheus-client is designed to work seamlessly with `@prodisco/search-libs` for unified search across library types and Prometheus metrics.

```typescript
import { LibraryIndexer } from '@prodisco/search-libs';
import { PrometheusClient, MetricDiscovery } from '@prodisco/prometheus-client';

// Set up the indexer
const indexer = new LibraryIndexer({
  packages: [
    { name: '@kubernetes/client-node' },
  ],
});
await indexer.initialize();

// Add Prometheus metrics to the index
const client = new PrometheusClient({
  endpoint: process.env.PROMETHEUS_URL || 'http://prometheus:9090',
});
const discovery = new MetricDiscovery(client);
const metricDocs = await discovery.getIndexableMetrics();
await indexer.addDocuments(metricDocs);

// Now search across both K8s types and Prometheus metrics
const results = await indexer.search({
  query: 'pod memory',
  limit: 10,
});
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROMETHEUS_URL` | Prometheus server endpoint | - |

## Error Handling

The client throws errors for network issues and invalid queries. Wrap calls in try-catch:

```typescript
try {
  const result = await client.instantQuery('invalid{query');
} catch (error) {
  console.error('Query failed:', error.message);
}
```

## License

ISC
