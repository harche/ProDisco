# searchTools Reference

The `kubernetes.searchTools` tool is a unified interface for discovering Kubernetes API methods, type definitions, cached scripts, and Prometheus/statistics library methods. It supports four modes designed for progressive disclosure: start with method discovery, drill into types as needed, reuse existing scripts, and analyze metrics with Prometheus.

## Quick Reference

| Mode | Purpose | Required Params | Example |
|------|---------|-----------------|---------|
| `methods` | Find API methods | `resourceType` | `{ resourceType: "Pod" }` |
| `types` | Get type definitions | `types` | `{ mode: "types", types: ["V1Pod"] }` |
| `scripts` | Search cached scripts | (none) | `{ mode: "scripts", searchTerm: "logs" }` |
| `prometheus` | Search Prometheus/stats methods | (none) | `{ mode: "prometheus", methodPattern: "mean" }` |

---

## Part 1: User Guide

### Methods Mode (Default)

Search for Kubernetes API methods by resource type. This is the starting point for most workflows.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resourceType` | string | Yes | Resource type to search (e.g., "Pod", "Deployment", "Service") |
| `action` | string | No | Filter by action: `list`, `read`, `create`, `delete`, `patch`, `replace`, `connect`, `get`, `watch` |
| `scope` | enum | No | Filter by scope: `namespaced`, `cluster`, or `all` (default) |
| `exclude` | object | No | Exclude specific actions or API classes |
| `limit` | number | No | Max results (default: 10, max: 50) |
| `offset` | number | No | Skip N results for pagination (default: 0) |

**Examples:**

```typescript
// List all Pod-related methods
{ resourceType: "Pod" }

// Find namespaced list operations for Pods
{ resourceType: "Pod", action: "list", scope: "namespaced" }

// Deployment create methods
{ resourceType: "Deployment", action: "create" }

// Pod methods, excluding delete and connect actions
{ resourceType: "Pod", exclude: { actions: ["delete", "connect"] } }

// Pod methods, excluding CoreV1Api (shows PolicyV1Api, AutoscalingV1Api, etc.)
{ resourceType: "Pod", exclude: { apiClasses: ["CoreV1Api"] } }

// Pagination: get results 11-20
{ resourceType: "Pod", limit: 10, offset: 10 }
```

**Response Structure:**

```typescript
{
  mode: "methods",
  summary: string,          // Human-readable result summary
  tools: [{                 // Array of matching API methods
    apiClass: string,       // e.g., "CoreV1Api"
    methodName: string,     // e.g., "listNamespacedPod"
    resourceType: string,   // e.g., "Pod"
    description: string,
    parameters: [...],      // Method parameters with types
    example: string,        // Complete usage example
    inputSchema: {...},     // Parameter schema
    outputSchema: {...},    // Return value schema
  }],
  totalMatches: number,     // Total matching methods (for pagination)
  relevantScripts: [...],   // Cached scripts matching the search
  facets: {                 // Result breakdown for refining search
    apiClass: { "CoreV1Api": 15, "AppsV1Api": 3 },
    action: { "list": 5, "read": 4, "create": 3 },
    scope: { "namespaced": 10, "cluster": 5 }
  },
  pagination: {
    offset: number,
    limit: number,
    hasMore: boolean
  },
  paths: {
    scriptsDirectory: string  // Where to write new scripts
  }
}
```

---

### Types Mode

Get TypeScript type definitions from the `@kubernetes/client-node` library. Supports dot-notation for navigating to nested types.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `types` | string[] | Yes | Type names or paths to resolve |
| `depth` | number | No | Nested type resolution depth (1-2, default: 1) |

**Path Navigation:**

Use dot notation to navigate to nested types:

```typescript
// Get the V1Pod type
{ mode: "types", types: ["V1Pod"] }

// Navigate to spec (returns V1PodSpec)
{ mode: "types", types: ["V1Pod.spec"] }

// Navigate to containers (returns V1Container - array element type)
{ mode: "types", types: ["V1Pod.spec.containers"] }

// Get multiple types at once
{ mode: "types", types: ["V1Pod", "V1Deployment", "V1Service"] }

// Include nested types at depth 2
{ mode: "types", types: ["V1Pod"], depth: 2 }
```

**Response Structure:**

```typescript
{
  mode: "types",
  summary: string,
  types: {
    "V1Pod": {
      name: "V1Pod",
      definition: "V1Pod {\n  metadata?: V1ObjectMeta\n  spec?: V1PodSpec\n  ...\n}",
      file: "./node_modules/@kubernetes/client-node/dist/gen/models/V1Pod.d.ts",
      nestedTypes: ["V1ObjectMeta", "V1PodSpec", "V1PodStatus"]
    }
  }
}
```

---

### Scripts Mode

Search and discover cached scripts in `~/.prodisco/scripts/cache/`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `searchTerm` | string | No | Search term (omit to list all scripts) |
| `limit` | number | No | Max results (default: 10, max: 50) |
| `offset` | number | No | Skip N results for pagination |

**Examples:**

```typescript
// List all cached scripts
{ mode: "scripts" }

// Search for pod-related scripts
{ mode: "scripts", searchTerm: "pod" }

// Search for logging scripts
{ mode: "scripts", searchTerm: "logs" }

// Paginate through all scripts
{ mode: "scripts", limit: 5, offset: 5 }
```

**Response Structure:**

```typescript
{
  mode: "scripts",
  summary: string,
  scripts: [{
    filename: "get-pod-logs.ts",
    filePath: "/Users/you/.prodisco/scripts/cache/get-pod-logs.ts",
    description: "Get logs from a pod in the default namespace",
    apiClasses: ["CoreV1Api"]
  }],
  totalMatches: number,
  pagination: { offset, limit, hasMore },
  paths: { scriptsDirectory: string }
}
```

---

### Prometheus Mode

Search for Prometheus API methods. This mode exposes methods from the `prometheus-query` library for querying Prometheus.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | enum | No | Filter by category: `query`, `metadata`, `alerts`, `metrics`, or `all` (default) |
| `methodPattern` | string | No | Search pattern for method names or metric names (e.g., "query", "labels", "pod", "gpu") |
| `limit` | number | No | Max results (default: 10, max: 50) |
| `offset` | number | No | Skip N results for pagination (default: 0) |

**Categories:**

| Category | Description |
|----------|-------------|
| `query` | PromQL instant/range queries |
| `metadata` | Labels, series, targets, metrics metadata |
| `alerts` | Alerting rules and active alerts |
| `metrics` | Discover actual metrics from your Prometheus cluster with descriptions |

**Examples:**

```typescript
// List all prometheus methods
{ mode: "prometheus" }

// Find PromQL query methods
{ mode: "prometheus", category: "query" }

// Find metadata methods
{ mode: "prometheus", category: "metadata" }

// Search for specific methods
{ mode: "prometheus", methodPattern: "query" }

// Paginate through all methods
{ mode: "prometheus", limit: 20, offset: 20 }

// Discover actual metrics from cluster (requires PROMETHEUS_URL)
{ mode: "prometheus", category: "metrics" }

// Find pod-related metrics
{ mode: "prometheus", category: "metrics", methodPattern: "pod" }

// Find GPU metrics (DCGM, nvidia, etc.)
{ mode: "prometheus", category: "metrics", methodPattern: "gpu" }
```

**Metrics Category Response:**

When using `category: "metrics"`, metrics are grouped by semantic category for easier discovery:
- **STATUS & LIFECYCLE** - status, phase, ready, restart metrics
- **CPU & COMPUTE** - cpu, throttle metrics
- **MEMORY** - memory, mem metrics
- **NETWORK** - network, receive, transmit, rx, tx metrics
- **STORAGE** - storage, disk, volume, fs metrics
- **OTHER** - everything else

The response includes a "NEXT STEPS" section showing how to:
1. Get labels for a metric using `labelNames()`
2. Query a metric using `instantQuery()`

**Response Structure:**

```typescript
{
  mode: "prometheus",
  summary: string,          // Human-readable result summary
  methods: [{               // Array of matching methods
    library: "prometheus-query",
    className?: string,     // e.g., "PrometheusDriver"
    methodName: string,     // e.g., "instantQuery", "rangeQuery"
    category: string,       // e.g., "query", "metadata", "alerts"
    description: string,
    parameters: [...],      // Method parameters with types
    returnType: string,
    example: string,        // Usage example
  }],
  totalMatches: number,
  libraries: {
    "prometheus-query": { installed: true, version: "^3.3.2" }
  },
  usage: string,            // Quick usage guide
  facets: {
    category: { "query": 2, "metadata": 10, "alerts": 5 }
  },
  pagination: { offset, limit, hasMore },
  paths: { scriptsDirectory: string }
}
```

**Environment Configuration:**

- `PROMETHEUS_URL` is **required** for executing queries - set it when adding the MCP server:

```bash
claude mcp add ProDisco \
  --env KUBECONFIG="${HOME}/.kube/config" \
  --env PROMETHEUS_URL="http://prometheus:9090" \
  -- npx -y @prodisco/k8s-mcp
```

If `PROMETHEUS_URL` is not set:
- Prometheus methods are still discoverable
- The response includes a warning that execution requires configuration

---

### Example Agent Workflows

#### Workflow 1: List Pods in a Namespace

```
Step 1: Discover the API method
> { resourceType: "Pod", action: "list", scope: "namespaced" }

Step 2: Get type definition for understanding the response
> { mode: "types", types: ["V1Pod.spec", "V1Pod.status"] }

Step 3: Write and run the script
> Write to ~/.prodisco/scripts/cache/list-pods.ts
> Run: npx tsx ~/.prodisco/scripts/cache/list-pods.ts
```

#### Workflow 2: Create a Deployment

```
Step 1: Find the create method
> { resourceType: "Deployment", action: "create" }

Step 2: Get the full Deployment spec structure
> { mode: "types", types: ["V1Deployment.spec"], depth: 2 }

Step 3: Check for existing deployment scripts
> { mode: "scripts", searchTerm: "deployment" }

Step 4: Write the script using discovered types and examples
```

#### Workflow 3: Debug Pod Issues

```
Step 1: Find relevant methods
> { resourceType: "Pod", action: "read" }
> { resourceType: "Pod" }  // See connect methods for logs/exec

Step 2: Look for existing debug scripts
> { mode: "scripts", searchTerm: "logs" }
> { mode: "scripts", searchTerm: "debug" }

Step 3: Run existing script or adapt for your needs
> npx tsx ~/.prodisco/scripts/cache/get-pod-logs.ts
```

#### Workflow 4: Query P99 Latency from Prometheus

**Step 1:** Find query methods
```json
{ "mode": "prometheus", "category": "query" }
```

**Step 2:** Write the script using PromQL's built-in histogram_quantile:
```typescript
import { PrometheusDriver } from 'prometheus-query';

const prom = new PrometheusDriver({
  endpoint: process.env.PROMETHEUS_URL || 'http://prometheus:9090'
});

const end = new Date();
const start = new Date(end.getTime() - 60 * 60 * 1000); // 1 hour ago

// PromQL handles percentile calculation directly
const result = await prom.rangeQuery(
  'histogram_quantile(0.99, rate(apiserver_request_duration_seconds_bucket[5m]))',
  start, end, '1m'
);

const latestValue = result.result[0]?.values.slice(-1)[0]?.value;
console.log(`P99 latency: ${latestValue?.toFixed(3)}s`);
```

**Step 3:** Execute script
```bash
npx tsx ~/.prodisco/scripts/cache/api-latency-p99.ts
```

---

## Part 2: Technical Architecture

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
  documentType: 'enum',      // "method" | "script" | "prometheus" | "prometheus-metric"
  resourceType: 'string',    // Searchable: "Pod", "Deployment"
  methodName: 'string',      // Searchable: "listNamespacedPod", "mean", "rangeQuery", metric names
  description: 'string',     // Searchable: full description text
  searchTokens: 'string',    // CamelCase-split tokens for better matching
  action: 'enum',            // Filterable: "list", "create", "prometheus", "metric", etc.
  scope: 'enum',             // Filterable: "namespaced", "cluster", "prometheus"
  apiClass: 'enum',          // Filterable: "CoreV1Api", "prometheus-query", "prometheus-metric", etc.
  id: 'string',              // Unique identifier
  filePath: 'string',        // Script path (empty for methods)
  library: 'enum',           // Prometheus: "prometheus-query"
  category: 'enum',          // Prometheus: "query", "metadata", "alerts"
  metricType: 'enum',        // Prometheus metrics: "gauge", "counter", "histogram", "summary"
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
- All API methods from 10 API classes (~500+ methods)
- All cached scripts in `~/.prodisco/scripts/cache/`
- Prometheus library methods from `prometheus-query`
- **Prometheus cluster metrics** (background, non-blocking) - if `PROMETHEUS_URL` is set, actual metrics are fetched from the cluster and indexed. This runs in the background and refreshes every 30 minutes.

---

### Type Resolution System

Type definitions are extracted using the TypeScript Compiler API.

**Process:**
1. Parse the type path (e.g., `V1Deployment.spec.template.spec`)
2. Load the base type's `.d.ts` file from `@kubernetes/client-node`
3. For path navigation:
   - Find the property in the current type
   - Extract the property's type node
   - Resolve array types (`V1Container[]` → `V1Container`)
   - Resolve union types (`T | undefined` → `T`)
4. Recursively resolve nested types based on `depth` parameter

**Path Resolution Examples:**

| Input Path | Resolved Type |
|------------|---------------|
| `V1Pod` | V1Pod |
| `V1Pod.spec` | V1PodSpec |
| `V1Pod.spec.containers` | V1Container (array element) |
| `V1Pod.status.conditions` | V1PodCondition (array element) |

---

### Scripts Indexing

Scripts are indexed from `~/.prodisco/scripts/cache/` with real-time updates.

**Metadata Extraction:**

From each `.ts` file, we extract:
1. **Description**: First comment block (JSDoc or `//` comments)
2. **Resource Types**: From filename (e.g., `get-pod-logs.ts` → `["pod", "log"]`)
3. **API Classes**: From code patterns (e.g., `CoreV1Api`, `AppsV1Api`)
4. **Keywords**: From description text

**Filesystem Watcher:**

Using `chokidar`, the index updates automatically:
- `add`: New scripts are indexed immediately
- `change`: Modified scripts are re-indexed
- `unlink`: Deleted scripts are removed from index

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
- Script metadata (description, API classes)
- Full file paths for execution
- Pagination for large script collections

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
