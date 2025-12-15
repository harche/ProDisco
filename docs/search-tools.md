# searchTools Reference

The `kubernetes.searchTools` tool is a unified interface for discovering methods and types across all supported libraries: Kubernetes API, Prometheus, Loki, and Analytics. It provides a single unified search that indexes both API methods AND TypeScript type definitions.

Use `kubernetes.runSandbox` to execute discovered APIs. The sandbox provides `k8s`, `kc` (pre-configured KubeConfig), `console`, and `require()` for whitelisted modules including `prometheus-query`, `@prodisco/loki-client`, and analytics libraries.

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [User Guide](#user-guide)
  - [Search Mode](#search-mode)
  - [Type Definitions](#type-definitions)
- [Document Types](#document-types)
  - [Kubernetes Methods](#kubernetes-methods-documenttype-kubernetes)
  - [Prometheus Methods](#prometheus-methods-documenttype-prometheus)
  - [Prometheus Metrics](#prometheus-metrics-documenttype-prometheus-metric)
  - [Loki Methods](#loki-methods-documenttype-loki)
  - [Analytics Functions](#analytics-functions-documenttype-analytics)
  - [Cached Scripts](#cached-scripts-documenttype-script)
- [Example Workflows](#example-workflows)
  - [List Pods in a Namespace](#workflow-1-list-pods-in-a-namespace)
  - [Create a Deployment](#workflow-2-create-a-deployment)
  - [Reuse a Cached Script](#workflow-3-reuse-a-cached-script)
  - [Query P99 Latency from Prometheus](#workflow-4-query-p99-latency-from-prometheus)
  - [Query Loki Logs](#workflow-5-query-loki-logs)
- [Technical Architecture](#technical-architecture)
  - [Search Engine (Orama)](#search-engine-orama)
  - [Type Resolution System](#type-resolution-system)
  - [Scripts Indexing](#scripts-indexing)
  - [Response Format](#response-format)
- [API Classes Indexed](#api-classes-indexed)

---

## Quick Reference

**Key Parameters:**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | Search term for full-text search | `{ query: "Pod" }` |
| `documentType` | Filter by document type | `{ documentType: "kubernetes" }` |
| `category` | Filter by category (actions/kinds) | `{ category: "list" }` |
| `library` | Filter by library/API class | `{ library: "CoreV1Api" }` |

**Document Types:**

| Type | Description | Example |
|------|-------------|---------|
| `kubernetes` | Kubernetes API methods | `{ documentType: "kubernetes", query: "Pod" }` |
| `prometheus` | Prometheus client methods | `{ documentType: "prometheus", category: "query" }` |
| `prometheus-metric` | Live cluster metrics | `{ documentType: "prometheus-metric", query: "cpu" }` |
| `loki` | Loki client methods | `{ documentType: "loki", category: "query" }` |
| `analytics` | Statistics/ML functions | `{ documentType: "analytics", library: "simple-statistics" }` |
| `script` | Cached sandbox scripts | `{ documentType: "script", query: "deployment" }` |
| `type` | TypeScript type definitions | `{ documentType: "type", query: "V1Pod" }` |
| `all` (default) | Search all types | `{ query: "Pod" }` |

---

## User Guide

### Search Mode

Search for methods and types across all supported libraries using a unified query interface. Use `documentType` to filter by library type, and `category`/`library` for further refinement.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Search term - searches names, descriptions, and resource types |
| `documentType` | enum | No | Filter by type: `kubernetes`, `prometheus`, `prometheus-metric`, `loki`, `analytics`, `script`, `type`, or `all` (default) |
| `category` | string | No | Filter by category: K8s actions (list, create, read, delete, patch) or type kinds (class, interface, enum) or library categories (query, labels, descriptive, regression) |
| `library` | string | No | Filter by library/API class: K8s (CoreV1Api, AppsV1Api, etc.) or libraries (@kubernetes/client-node, prometheus-query, @prodisco/loki-client, simple-statistics, etc.) |
| `exclude` | object | No | Exclude specific categories or libraries: `{ categories: [...], libraries: [...] }` |
| `limit` | number | No | Max results (default: 10, max: 50) |
| `offset` | number | No | Skip N results for pagination (default: 0) |

**Examples:**

```typescript
// Search all types for "Pod" (returns both methods and type definitions)
{ query: "Pod" }

// Filter to Kubernetes methods only
{ query: "Pod", documentType: "kubernetes" }

// Find K8s list methods for Pods
{ query: "Pod", documentType: "kubernetes", category: "list" }

// Find Loki query methods
{ documentType: "loki", category: "query" }

// Find Prometheus methods
{ documentType: "prometheus", category: "query" }

// Find cluster metrics
{ documentType: "prometheus-metric", query: "cpu" }

// Find analytics functions
{ documentType: "analytics", library: "simple-statistics" }

// Search cached scripts
{ documentType: "script", query: "deployment" }

// Exclude delete actions
{ query: "Pod", exclude: { categories: ["delete"] } }

// Pagination: get results 11-20
{ query: "Pod", limit: 10, offset: 10 }
```

**Response Structure:**

```typescript
{
  summary: string,          // Human-readable result summary
  results: [{               // Array of matching methods/functions/types
    id: string,             // Unique identifier
    documentType: string,   // "kubernetes", "prometheus", "loki", "analytics", "script", "type"
    name: string,           // Method/function/type name
    description: string,
    library: string,        // API class or library name
    category: string,       // Action/category or type kind
    parameters?: [...],     // Method parameters with types
    returnType?: string,
    example?: string,       // Sandbox-compatible usage example
    // Type-specific fields (when documentType === "type"):
    typeDefinition?: string,  // Formatted type definition
    nestedTypes?: string[],   // Referenced type names for navigation
    typeKind?: string,        // "class", "interface", "enum", "type-alias"
  }],
  totalMatches: number,     // Total matching results (for pagination)
  relevantScripts: [{       // Cached scripts matching the search
    filename: string,
    description: string,
    apiClasses: string[]
  }],
  facets: {                 // Result breakdown for refining search
    documentType: { "kubernetes": 15, "type": 10, "loki": 3 },
    library: { "CoreV1Api": 15, "@kubernetes/client-node": 10 },
    category: { "list": 5, "class": 10, "query": 4 }
  },
  pagination: {
    offset: number,
    limit: number,
    hasMore: boolean
  },
  searchTime: number,       // Search duration in ms
  usage: string,            // Quick usage guide
}
```

---

### Type Definitions

TypeScript type definitions are indexed as first-class documents and can be searched like any other document type. Use `documentType: "type"` to search only types.

**Examples:**

```typescript
// Get the V1Pod type definition
{ query: "V1Pod", documentType: "type" }

// Find all Pod-related types
{ query: "Pod", documentType: "type" }

// Get types from a specific library
{ documentType: "type", library: "@kubernetes/client-node" }

// Find interface types
{ documentType: "type", category: "interface" }

// Search across everything (methods AND types)
{ query: "Deployment" }
```

**Navigating Nested Types:**

Type definitions include a `nestedTypes` field that lists referenced types. Query these types to navigate deeper:

```typescript
// Step 1: Get V1Deployment type
{ query: "V1Deployment", documentType: "type" }
// Response shows nestedTypes: ["V1DeploymentSpec", "V1ObjectMeta", ...]

// Step 2: Get the nested V1DeploymentSpec type
{ query: "V1DeploymentSpec", documentType: "type" }
// Response shows nestedTypes: ["V1PodTemplateSpec", ...]

// Step 3: Continue navigating as needed
{ query: "V1PodSpec", documentType: "type" }
```

**Type Response Fields:**

| Field | Description |
|-------|-------------|
| `typeDefinition` | Formatted TypeScript type definition |
| `nestedTypes` | Array of referenced type names for further navigation |
| `typeKind` | Type kind: `class`, `interface`, `enum`, or `type-alias` |

---

## Document Types

### Kubernetes Methods (documentType: "kubernetes")

Kubernetes API methods from `@kubernetes/client-node`. Filter by `category` for CRUD operations.

**Categories:** `list`, `read`, `create`, `delete`, `patch`, `replace`, `connect`, `watch`

**Example:**

```typescript
// Find Pod list methods
{ documentType: "kubernetes", query: "Pod", category: "list" }
```

---

### Prometheus Methods (documentType: "prometheus")

Methods from the `prometheus-query` library for querying Prometheus.

**Categories:** `query`, `metadata`, `alerts`

**Example:**

```typescript
// Find PromQL query methods
{ documentType: "prometheus", category: "query" }
```

**Environment:** Requires `PROMETHEUS_URL` for execution.

---

### Prometheus Metrics (documentType: "prometheus-metric")

Discover actual metrics from your Prometheus cluster. Requires `PROMETHEUS_URL` to be set.

**Example:**

```typescript
// Find CPU-related metrics
{ documentType: "prometheus-metric", query: "cpu" }

// Find GPU metrics
{ documentType: "prometheus-metric", query: "gpu" }
```

---

### Loki Methods (documentType: "loki")

Methods from the `@prodisco/loki-client` library for querying Loki logs.

**Categories:** `query`, `labels`, `streams`, `health`

**Methods:**

| Method | Category | Description |
|--------|----------|-------------|
| `queryRange` | query | Query logs using LogQL, returns parsed log entries |
| `queryRangeMatrix` | query | Query for metric results (rate, count_over_time) |
| `labels` | labels | Get all available label names |
| `labelValues` | labels | Get all values for a specific label |
| `series` | streams | Get log stream series matching selectors |
| `ready` | health | Check if Loki is ready |

**Examples:**

```typescript
// Find all Loki methods
{ documentType: "loki" }

// Find Loki query methods
{ documentType: "loki", category: "query" }

// Find Loki label methods
{ documentType: "loki", category: "labels" }
```

**Environment:** Requires `LOKI_URL` for execution.

**Sandbox Usage:**

```typescript
const { LokiClient } = require('@prodisco/loki-client');
const client = new LokiClient({ baseUrl: process.env.LOKI_URL });

// Query logs from the last hour
const result = await client.queryRange('{namespace="default"}', { since: '1h', limit: 100 });
result.logs.forEach(log => console.log(`[${log.timestamp.toISOString()}] ${log.line}`));

// Get available labels
const labels = await client.labels({ since: '24h' });
console.log('Labels:', labels);

// Get values for a label
const namespaces = await client.labelValues('namespace', { since: '24h' });
console.log('Namespaces:', namespaces);
```

---

### Analytics Functions (documentType: "analytics")

Statistical, machine learning, and signal processing functions.

**Libraries:**

| Library | Purpose |
|---------|---------|
| `simple-statistics` | Descriptive stats, z-scores, percentiles, linear regression, correlation |
| `ml-regression` | Polynomial, exponential, and power regression for trend forecasting |
| `mathjs` | Matrix operations, linear algebra, symbolic math |
| `fft-js` | Fast Fourier Transform for detecting periodic patterns |

**Categories:** `descriptive`, `regression`, `distribution`, `matrix`, `signal`

**Examples:**

```typescript
// Find all analytics functions
{ documentType: "analytics" }

// Filter by library
{ documentType: "analytics", library: "simple-statistics" }

// Search for regression functions
{ documentType: "analytics", query: "regression" }
```

**Common Use Cases:**

| Use Case | Library | Key Functions |
|----------|---------|---------------|
| Anomaly detection | simple-statistics | `mean`, `standardDeviation`, `zScore` |
| Outlier identification | simple-statistics | `quantile`, `interquartileRange` |
| Trend analysis | simple-statistics | `linearRegression`, `linearRegressionLine` |
| Correlation | simple-statistics | `sampleCorrelation`, `sampleCovariance` |
| Capacity forecasting | ml-regression | `PolynomialRegression`, `ExponentialRegression` |
| Periodic pattern detection | fft-js | `fft`, `util.fftMag`, `util.fftFreq` |
| Matrix operations | mathjs | `matrix`, `multiply`, `inv`, `eigs` |

For detailed examples, see [analytics.md](analytics.md).

---

### Cached Scripts (documentType: "script")

Scripts automatically cached when successfully executed via `runSandbox`.

**Example:**

```typescript
// List all cached scripts
{ documentType: "script" }

// Search for pod-related scripts
{ documentType: "script", query: "pod" }
```

**Usage:**

```typescript
// Run a cached script
runSandbox({ cached: "script-2025-01-01T12-00-00-abc123.ts" })
```

---

## Example Workflows

### Workflow 1: List Pods in a Namespace

```
Step 1: Discover the API method
> searchTools({ documentType: "kubernetes", query: "Pod", category: "list" })

Step 2: Get type definitions for understanding the response
> searchTools({ query: "V1Pod", documentType: "type" })
> searchTools({ query: "V1PodSpec", documentType: "type" })

Step 3: Execute in sandbox
> runSandbox({ code: `
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await api.listNamespacedPod({ namespace: 'default' });
    console.log(\`Found \${pods.items.length} pods\`);
    pods.items.forEach(p => console.log(p.metadata?.name));
  ` })
```

### Workflow 2: Create a Deployment

```
Step 1: Find the create method
> searchTools({ documentType: "kubernetes", query: "Deployment", category: "create" })

Step 2: Get the Deployment type and navigate to nested types
> searchTools({ query: "V1Deployment", documentType: "type" })
> searchTools({ query: "V1DeploymentSpec", documentType: "type" })

Step 3: Check for existing deployment scripts
> searchTools({ documentType: "script", query: "deployment" })

Step 4: Execute using discovered types
> runSandbox({ code: `...` })
```

### Workflow 3: Reuse a Cached Script

```
Step 1: Search for existing scripts
> searchTools({ documentType: "script", query: "logs" })

Step 2: Run cached script by filename
> runSandbox({ cached: "script-2025-01-01T12-00-00-abc123.ts" })
```

### Workflow 4: Query P99 Latency from Prometheus

**Step 1:** Find query methods

```json
{ "documentType": "prometheus", "category": "query" }
```

**Step 2:** Execute in sandbox:

```typescript
runSandbox({ code: `
  const { PrometheusDriver } = require('prometheus-query');
  const prom = new PrometheusDriver({ endpoint: process.env.PROMETHEUS_URL });

  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000); // 1 hour ago

  const result = await prom.rangeQuery(
    'histogram_quantile(0.99, rate(apiserver_request_duration_seconds_bucket[5m]))',
    start, end, '1m'
  );

  const latestValue = result.result[0]?.values.slice(-1)[0]?.value;
  console.log(\`P99 latency: \${latestValue?.toFixed(3)}s\`);
` })
```

### Workflow 5: Query Loki Logs

**Step 1:** Find Loki query methods

```json
{ "documentType": "loki", "category": "query" }
```

**Step 2:** Discover available labels

```typescript
runSandbox({ code: `
  const { LokiClient } = require('@prodisco/loki-client');
  const client = new LokiClient({ baseUrl: process.env.LOKI_URL });

  const labels = await client.labels({ since: '24h' });
  console.log('Available labels:', labels);

  const apps = await client.labelValues('app', { since: '24h' });
  console.log('Apps:', apps);
` })
```

**Step 3:** Query logs

```typescript
runSandbox({ code: `
  const { LokiClient } = require('@prodisco/loki-client');
  const client = new LokiClient({ baseUrl: process.env.LOKI_URL });

  const result = await client.queryRange('{app="nginx"} |= "error"', { since: '1h', limit: 50 });
  console.log(\`Found \${result.logs.length} error logs\`);
  result.logs.forEach(log => console.log(\`[\${log.timestamp.toISOString()}] \${log.line}\`));
` })
```

---

## Technical Architecture

### Search Engine (Orama)

searchTools uses [Orama](https://orama.com) for fast, typo-tolerant full-text search.

**Why Orama:**

- Sub-millisecond search performance
- Built-in typo tolerance (configurable per query)
- Faceted search for result breakdown
- Zero external dependencies (runs in-process)

**Index Schema:**

```typescript
const oramaSchema = {
  // Common fields (all document types)
  id: 'string',              // Unique identifier
  documentType: 'enum',      // "kubernetes" | "prometheus" | "loki" | "analytics" | "script" | "type"
  name: 'string',            // Searchable: method name OR type name
  description: 'string',     // Searchable: full description text
  searchTokens: 'string',    // CamelCase-split tokens for better matching
  library: 'enum',           // Filterable: API class or package name
  category: 'enum',          // Filterable: action (list, create) or type kind (class, interface)

  // Method-specific fields
  resourceType: 'string',    // K8s resource: "Pod", "Deployment"
  scope: 'enum',             // "namespaced" | "cluster" | "forAllNamespaces"
  filePath: 'string',        // Script file path
  metricType: 'enum',        // Prometheus metrics: "gauge", "counter", "histogram", "summary"

  // Type-specific fields
  properties: 'string',      // JSON: [{name, type, optional, description}]
  typeDefinition: 'string',  // Formatted type definition for display
  nestedTypes: 'string',     // Comma-separated referenced type names
  typeKind: 'enum',          // "class" | "interface" | "enum" | "type-alias"
};
```

**Boosting Strategy:**

```typescript
boost: {
  resourceType: 3,      // Exact resource matches are most important
  searchTokens: 2.5,    // CamelCase-split terms for partial matching
  methodName: 2,        // Method name matches
  description: 1,       // Description text
}
```

**Pre-warming:**

The index is pre-warmed at server startup via `warmupSearchIndex()` to avoid latency on the first search. This indexes:

- All Kubernetes API methods from 10 API classes (~950+ methods)
- TypeScript type definitions from all libraries (~900+ types)
- All cached scripts in `.cache/scripts/`
- Prometheus library methods from `prometheus-query`
- Loki library methods from `@prodisco/loki-client`
- Analytics library methods from `simple-statistics`, `ml-regression`, `mathjs`, `fft-js`
- **Prometheus cluster metrics** (background, non-blocking) - if `PROMETHEUS_URL` is set, actual metrics are fetched from the cluster and indexed. This runs in the background and refreshes every 30 minutes.

---

### Type Indexing System

Type definitions are extracted at startup using the TypeScript Compiler API and indexed as first-class documents in Orama.

**Process:**

1. Parse `.d.ts` files from supported libraries (`@kubernetes/client-node`, `prometheus-query`, `@prodisco/loki-client`, `mathjs`)
2. Extract classes, interfaces, enums, and type aliases
3. For each type:
   - Extract all properties with their types and optional markers
   - Identify referenced types (nested types) for navigation
   - Generate formatted type definitions for display
4. Index types in Orama with full-text search on name, description, and properties

**Navigating Types:**

Types include a `nestedTypes` field listing referenced types. Query these to explore deeper:

```typescript
// Step 1: Get V1Deployment type
{ query: "V1Deployment", documentType: "type" }
// Response shows nestedTypes: ["V1DeploymentSpec", "V1ObjectMeta", ...]

// Step 2: Query the nested type
{ query: "V1DeploymentSpec", documentType: "type" }
// Response shows nestedTypes: ["V1PodTemplateSpec", ...]
```

---

### Scripts Indexing

Scripts executed via `runSandbox` are automatically cached and indexed for future reuse.

**Automatic Caching:**

- Successfully executed scripts are saved to `.cache/scripts/` within the package directory
- Filenames use content-based hashing to prevent duplicates: `script-<timestamp>-<hash>.ts`
- Scripts are indexed immediately after caching for instant searchability

**Metadata Extraction:**

From each cached script, we extract:

1. **Description**: First comment block (JSDoc or `//` comments)
2. **API Classes**: From code patterns (e.g., `CoreV1Api`, `AppsV1Api`)
3. **Keywords**: From description text

---

### Response Format

**Methods Mode:**

- Relevant cached scripts shown first (top 5 matching)
- Faceted breakdown for search refinement
- Full method details with usage examples
- Pagination metadata

**Types Mode:**

- Formatted type definitions
- Nested type references for further exploration
- File location for reference

**Scripts Mode:**

- Script metadata (filename, description, API classes)
- Pagination for large script collections
- Use `runSandbox({ cached: "filename" })` to execute

---

## API Classes Indexed

| Class | Description |
|-------|-------------|
| CoreV1Api | Pods, Services, ConfigMaps, Secrets, Namespaces, Nodes |
| AppsV1Api | Deployments, StatefulSets, DaemonSets, ReplicaSets |
| BatchV1Api | Jobs, CronJobs |
| NetworkingV1Api | Ingresses, NetworkPolicies |
| RbacAuthorizationV1Api | Roles, RoleBindings, ClusterRoles |
| StorageV1Api | StorageClasses, PersistentVolumes |
| CustomObjectsApi | Custom Resource Definitions |
| ApiextensionsV1Api | CRD management |
| AutoscalingV1Api | HorizontalPodAutoscalers |
| PolicyV1Api | PodDisruptionBudgets |
