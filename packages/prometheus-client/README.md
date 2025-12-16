# @prodisco/prometheus-client

Typed Prometheus client with semantic metric discovery for AI agents. Wraps the `prometheus-query` library with a clean TypeScript interface.

## Features

- **Semantic Metric Search**: Find metrics by natural language queries (e.g., "memory usage")
- **Typed Execution**: Full TypeScript support for PromQL execution
- **Orama Integration**: Uses `@prodisco/search-libs` for fast, indexed metric search

## Installation

```bash
npm install @prodisco/prometheus-client
```

## Quick Start

```typescript
import { PrometheusClient, MetricSearchEngine } from '@prodisco/prometheus-client';

// Create client and search engine
const client = new PrometheusClient({ endpoint: 'http://prometheus:9090' });
const search = new MetricSearchEngine(client);

// 1. DISCOVER metrics with semantic search
const memoryMetrics = await search.search('memory usage');
console.log(memoryMetrics);
// [{ name: 'container_memory_working_set_bytes', type: 'gauge', help: 'Current working set in bytes' }, ...]

// 2. EXECUTE PromQL with discovered metric names
const result = await client.executeRange('container_memory_working_set_bytes', {
  start: new Date(Date.now() - 3600000), // 1 hour ago
  end: new Date(),
  step: '5m'
});
console.log(result.data);
```

## API Reference

### MetricSearchEngine

Semantic search for discovering available metrics. **Use this first** before executing queries.

```typescript
import { PrometheusClient, MetricSearchEngine } from '@prodisco/prometheus-client';

const client = new PrometheusClient({ endpoint: 'http://prometheus:9090' });
const search = new MetricSearchEngine(client);
```

#### Methods

##### `search(query: string, options?: MetricSearchOptions): Promise<MetricInfo[]>`

Search metrics by natural language. Searches both metric names AND descriptions.

```typescript
// Find memory-related metrics
const metrics = await search.search('memory usage');

// Find CPU metrics, filter by type
const gauges = await search.search('cpu', { type: 'gauge', limit: 10 });
```

##### `index(force?: boolean): Promise<number>`

Manually index/refresh metrics from Prometheus. Called automatically on first search.

```typescript
const count = await search.index();
console.log(`Indexed ${count} metrics`);
```

##### `list(options?: MetricSearchOptions): Promise<MetricInfo[]>`

List all indexed metrics.

```typescript
const allMetrics = await search.list({ limit: 100 });
```

### PrometheusClient

Execute PromQL queries against Prometheus. **Note**: You should know the metric names first - use `MetricSearchEngine.search()` to discover them.

```typescript
import { PrometheusClient } from '@prodisco/prometheus-client';

const client = new PrometheusClient({
  endpoint: 'http://prometheus:9090',
  timeout: 30000, // optional, default 30s
});
```

#### Methods

##### `execute(promql: string, time?: Date): Promise<InstantQueryResult>`

Execute an instant PromQL query.

```typescript
// First discover metrics: await search.search('http requests')
// Then execute with known metric name:
const result = await client.execute('http_requests_total');
```

##### `executeRange(promql: string, range: TimeRange): Promise<RangeQueryResult>`

Execute a range PromQL query over a time period.

```typescript
// First discover metrics: await search.search('memory')
// Then execute with known metric name:
const result = await client.executeRange('node_memory_MemTotal_bytes', {
  start: new Date(Date.now() - 3600000), // 1 hour ago
  end: new Date(),
  step: '5m',
});

result.data.forEach(series => {
  console.log(`Labels: ${JSON.stringify(series.labels)}`);
  series.samples.forEach(s => {
    console.log(`  ${new Date(s.time * 1000)}: ${s.value}`);
  });
});
```

##### `listMetrics(): Promise<MetricInfo[]>`

Get raw metric metadata from Prometheus. For semantic search, use `MetricSearchEngine` instead.

```typescript
const metrics = await client.listMetrics();
```

##### `labelNames(): Promise<string[]>`

Get all label names.

##### `labelValues(label: string): Promise<string[]>`

Get all values for a specific label.

##### `isHealthy(): Promise<boolean>`

Check if Prometheus is reachable.

### Helper Function

##### `createMetricSearchEngine(endpoint: string): MetricSearchEngine`

Create a MetricSearchEngine directly from an endpoint.

```typescript
import { createMetricSearchEngine } from '@prodisco/prometheus-client';

const search = createMetricSearchEngine('http://prometheus:9090');
const metrics = await search.search('disk usage');
```

## Types

### MetricInfo

```typescript
interface MetricInfo {
  name: string;      // Metric name (e.g., "http_requests_total")
  type: MetricType;  // 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown'
  help: string;      // Description
}
```

### MetricSearchOptions

```typescript
interface MetricSearchOptions {
  limit?: number;    // Max results (default: 20)
  type?: MetricType; // Filter by metric type
}
```

### TimeRange

```typescript
interface TimeRange {
  start: Date | number;  // Start time
  end: Date | number;    // End time
  step: string;          // Step interval (e.g., "15s", "1m", "5m")
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROMETHEUS_URL` | Prometheus server endpoint | - |

## License

ISC
