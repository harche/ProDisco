# @prodisco/loki-client

Typed Grafana Loki client for querying logs via the REST API. Provides a clean TypeScript interface with support for LogQL queries, label discovery, and multi-tenant deployments.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Types](#types)
- [Time Range Formats](#time-range-formats)
- [Environment Variables](#environment-variables)
- [License](#license)

## Features

- **LogQL Queries**: Execute log and metric queries with full TypeScript support
- **Label Discovery**: Explore available labels and their values
- **Multi-Tenant Support**: Built-in tenant ID header support for multi-tenant Loki
- **Flexible Time Ranges**: Use ISO strings, Unix timestamps, or relative times (e.g., "1h", "30m")

## Installation

```bash
npm install @prodisco/loki-client
```

## Quick Start

```typescript
import { LokiClient } from '@prodisco/loki-client';

// Create client
const client = new LokiClient({ baseUrl: 'http://localhost:3100' });

// 1. DISCOVER available labels
const labels = await client.labels();
console.log(labels); // ["app", "namespace", "pod", ...]

// 2. GET values for a specific label
const namespaces = await client.labelValues('namespace');
console.log(namespaces); // ["default", "kube-system", ...]

// 3. QUERY logs with LogQL
const result = await client.queryRange('{namespace="kube-system"}', {
  since: '1h',
  limit: 100,
});

result.logs.forEach(log => {
  console.log(`[${log.timestamp.toISOString()}] ${log.line}`);
});
```

## API Reference

### LokiClient

Main client for interacting with Grafana Loki.

```typescript
import { LokiClient } from '@prodisco/loki-client';

const client = new LokiClient({
  baseUrl: 'http://localhost:3100',
  tenantId: 'my-tenant',  // optional, for multi-tenant Loki
  timeout: 30000,         // optional, default 30s
});
```

#### Methods

##### `labels(options?: LabelValuesOptions): Promise<string[]>`

Get all label names.

```typescript
const labels = await client.labels();
console.log(labels); // ["app", "namespace", "pod", ...]

// With time range
const recentLabels = await client.labels({ since: '24h' });
```

##### `labelValues(label: string, options?: LabelValuesOptions): Promise<string[]>`

Get all values for a specific label.

```typescript
const namespaces = await client.labelValues('namespace');
console.log(namespaces); // ["default", "kube-system", ...]

// Filter by LogQL query
const appPods = await client.labelValues('pod', {
  query: '{app="nginx"}',
  since: '1h',
});
```

##### `series(selectors: string[], options?): Promise<Record<string, string>[]>`

Get log stream series matching selectors.

```typescript
const series = await client.series(['{namespace="default"}'], { since: '1h' });
console.log(series);
// [{ app: "nginx", namespace: "default", pod: "nginx-abc123" }, ...]
```

##### `queryRange(logQL: string, options?: QueryRangeOptions): Promise<QueryRangeLogsResult>`

Query logs using LogQL. Returns parsed log entries.

```typescript
const result = await client.queryRange('{app="nginx"} |= "error"', {
  since: '1h',
  limit: 100,
  direction: 'backward', // most recent first (default)
});

// Access flattened logs
result.logs.forEach(log => {
  console.log(`[${log.timestamp.toISOString()}] ${log.labels.pod}: ${log.line}`);
});

// Or access grouped by stream
result.streams.forEach(stream => {
  console.log(`Stream: ${JSON.stringify(stream.labels)}`);
  stream.entries.forEach(entry => {
    console.log(`  ${entry.line}`);
  });
});
```

##### `queryRangeMatrix(logQL: string, options?: QueryRangeOptions): Promise<QueryRangeMatrixResult>`

Query for matrix/metric results. Use for LogQL metric queries like `rate()` or `count_over_time()`.

```typescript
const result = await client.queryRangeMatrix('rate({app="nginx"}[5m])', {
  since: '1h',
});

result.metrics.forEach(series => {
  console.log(`Labels: ${JSON.stringify(series.labels)}`);
  series.values.forEach(sample => {
    console.log(`  ${sample.timestamp.toISOString()}: ${sample.value}`);
  });
});
```

##### `ready(): Promise<boolean>`

Check if Loki is ready.

```typescript
const isReady = await client.ready();
console.log(isReady); // true
```

## Types

### LokiClientOptions

```typescript
interface LokiClientOptions {
  baseUrl: string;     // Loki server URL (e.g., "http://localhost:3100")
  tenantId?: string;   // Optional tenant ID for multi-tenant Loki
  timeout?: number;    // Request timeout in milliseconds (default: 30000)
}
```

### QueryRangeOptions

```typescript
interface QueryRangeOptions {
  start?: string | number;           // Start time (ISO string, Unix timestamp, or relative)
  end?: string | number;             // End time
  since?: string;                    // Relative time range (e.g., "1h", "30m", "24h")
  limit?: number;                    // Maximum log entries to return
  direction?: 'forward' | 'backward'; // Query direction (default: "backward")
}
```

### LabelValuesOptions

```typescript
interface LabelValuesOptions {
  start?: string | number;  // Start time
  end?: string | number;    // End time
  since?: string;           // Relative time range
  query?: string;           // LogQL query to filter label values
}
```

### LogEntry

```typescript
interface LogEntry {
  timestamp: Date;                    // Timestamp as Date object
  timestampNanos: string;             // Timestamp in nanoseconds
  line: string;                       // Log line content
  labels: Record<string, string>;     // Stream labels
}
```

### LogStream

```typescript
interface LogStream {
  labels: Record<string, string>;     // Stream labels
  entries: Array<{
    timestamp: Date;
    timestampNanos: string;
    line: string;
  }>;
}
```

### MetricSeries

```typescript
interface MetricSeries {
  labels: Record<string, string>;     // Metric labels
  values: MetricSample[];             // Sample values over time
}

interface MetricSample {
  timestamp: Date;                    // Timestamp as Date object
  value: number;                      // Metric value
}
```

### QueryRangeLogsResult

```typescript
interface QueryRangeLogsResult {
  logs: LogEntry[];                   // Flattened log entries (sorted by timestamp desc)
  streams: LogStream[];               // Raw streams with their labels
  stats?: Record<string, unknown>;    // Statistics from Loki
}
```

### QueryRangeMatrixResult

```typescript
interface QueryRangeMatrixResult {
  metrics: MetricSeries[];            // Metric series
  stats?: Record<string, unknown>;    // Statistics from Loki
}
```

## Time Range Formats

The client accepts multiple time formats:

| Format | Example | Description |
|--------|---------|-------------|
| Relative | `"1h"`, `"30m"`, `"7d"` | Relative to now (s, m, h, d, w) |
| ISO String | `"2024-01-15T10:00:00Z"` | ISO 8601 timestamp |
| Unix Timestamp | `1705312800` | Seconds since epoch |

```typescript
// Using relative time (recommended)
await client.queryRange('{app="nginx"}', { since: '1h' });

// Using explicit start/end
await client.queryRange('{app="nginx"}', {
  start: '2024-01-15T10:00:00Z',
  end: '2024-01-15T11:00:00Z',
});

// Using Unix timestamps
await client.queryRange('{app="nginx"}', {
  start: 1705312800,
  end: 1705316400,
});
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_URL` | Loki server endpoint | - |
| `LOKI_TENANT_ID` | Multi-tenant org ID | - |

## License

MIT
