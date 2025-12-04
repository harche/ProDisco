# ProDisco (Progressive Disclosure Kubernetes MCP Server)

ProDisco gives AI agents **Kubernetes access + Prometheus metrics analysis** through two unified tools. It follows Anthropic's [Progressive Disclosure](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern: the MCP server exposes search tools which surface API methods, agents discover them to write code, execute it in a sandbox, and only the final console output returns to the agent.

**Two tools:**
- **kubernetes.searchTools** - Discover API methods, type definitions, cached scripts, and Prometheus methods
- **kubernetes.runSandbox** - Execute TypeScript code in a sandboxed VM environment

## Why Progressive Disclosure Matters

Anthropic's latest guidance explains why MCP servers should progressively reveal capabilities instead of dumping every tool definition into the model context. When agents explore a filesystem of TypeScript modules, they only load what they need and process data inside the execution environment, then return a concise result to the chat. This keeps token usage low, improves latency, and avoids copying large intermediate payloads through the model ([source](https://www.anthropic.com/engineering/code-execution-with-mcp)).

ProDisco goes a step further: instead of exposing custom TypeScript modules, it provides a structured parameter search tool that dynamically extracts methods from upstream libraries using TypeScript AST parsing. This means:
- **Zero maintenance** - Methods are extracted directly from library `.d.ts` files
- **Always current** - Upgrading a dependency automatically exposes new methods
- **Type-safe** - Full parameter types and return types included


---

## Demo

![Demo](docs/demo3.gif)

---

## Quick Start

### Add to Claude Code

Add ProDisco to Claude Code with a single command:

```bash
claude mcp add ProDisco --env KUBECONFIG="${HOME}/.kube/config" -- npx -y @prodisco/k8s-mcp
```

**With Prometheus (optional):**
```bash
claude mcp add ProDisco \
  --env KUBECONFIG="${HOME}/.kube/config" \
  --env PROMETHEUS_URL="http://localhost:9090" \
  -- npx -y @prodisco/k8s-mcp
```

Remove if needed:
```bash
claude mcp remove ProDisco
```

**Environment variables:**
| Variable | Required | Description |
|----------|----------|-------------|
| `KUBECONFIG` | No | Path to kubeconfig (defaults to `~/.kube/config`) |
| `K8S_CONTEXT` | No | Kubernetes context (defaults to current context) |
| `PROMETHEUS_URL` | No | Prometheus server URL for metrics queries |

> **Important:** These environment variables must be set where the MCP server runs. The `runSandbox` tool executes code within the MCP server process, which needs access to your kubeconfig and/or Prometheus endpoint.

> **Tip:** If you're using a kind cluster for local testing, you can port-forward to Prometheus:
> ```bash
> kubectl port-forward -n monitoring svc/prometheus-server 9090:80
> ```
> Then set `PROMETHEUS_URL="http://localhost:9090"`

### Development Setup

For local development:

```bash
git clone https://github.com/harche/ProDisco.git
cd ProDisco
npm install
npm run build
claude mcp add --transport stdio prodisco -- node dist/server.js
claude mcp remove prodisco # remove when you're done
```

### Startup Options

| Flag | Description |
|------|-------------|
| `--clear-cache` | Clear the scripts cache before starting |

Example:
```bash
node dist/server.js --clear-cache
```

---

## Available Tools

ProDisco exposes two tools:

### kubernetes.runSandbox

Execute TypeScript code in a sandboxed VM environment for Kubernetes and Prometheus operations.

**Input:**
```typescript
{
  // Provide one of:
  code?: string;     // TypeScript code to execute directly
  cached?: string;   // Name of a cached script to run (from searchTools results)

  timeout?: number;  // Execution timeout in ms (default: 30000, max: 120000)
}
```

**Sandbox Environment:**
- `k8s` - Full `@kubernetes/client-node` library
- `kc` - Pre-configured KubeConfig instance
- `console` - Captured output (log, error, warn, info)
- `require()` - Whitelisted modules: `@kubernetes/client-node`, `prometheus-query`
- `process.env` - Environment variables (PROMETHEUS_URL, etc.)

**Examples:**
```typescript
// Execute code directly
{
  code: `
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await api.listNamespacedPod({ namespace: 'default' });
    console.log(\`Found \${pods.items.length} pods\`);
  `
}

// Run a cached script by name
{ cached: "script-2025-01-01T12-00-00-abc123.ts" }
```

### kubernetes.searchTools

A unified search interface with four modes:

| Mode | Purpose | Example |
|------|---------|---------|
| `methods` | Find Kubernetes API methods | `{ resourceType: "Pod", action: "list" }` |
| `types` | Get TypeScript type definitions | `{ mode: "types", types: ["V1Pod.spec"] }` |
| `scripts` | Search cached scripts | `{ mode: "scripts", searchTerm: "logs" }` |
| `prometheus` | Find Prometheus API methods | `{ mode: "prometheus", category: "query" }` |

For comprehensive documentation including architecture details and example workflows, see [docs/search-tools.md](docs/search-tools.md).

**Input:**
```typescript
{
  // Mode selection
  mode?: 'methods' | 'types' | 'scripts' | 'prometheus';  // default: 'methods'

  // Methods mode - Kubernetes API discovery
  resourceType?: string;  // e.g., "Pod", "Deployment", "Service"
  action?: string;        // e.g., "list", "read", "create", "delete", "patch"
  scope?: 'namespaced' | 'cluster' | 'all';
  exclude?: { actions?: string[]; apiClasses?: string[] };

  // Types mode - TypeScript definitions
  types?: string[];       // e.g., ["V1Pod", "V1Deployment.spec"]
  depth?: number;         // Nested type depth (1-2)

  // Scripts mode - Cached script discovery
  searchTerm?: string;    // Search term (omit to list all)

  // Prometheus mode - Prometheus API discovery and metrics
  category?: 'query' | 'metadata' | 'alerts' | 'metrics' | 'all';
  methodPattern?: string; // e.g., "query", "labels", "pod", "gpu"

  // Shared parameters
  limit?: number;         // Max results (default: 10)
  offset?: number;        // Pagination offset
}
```

**Methods Mode Examples:**
```typescript
// List all Pod-related methods
{ resourceType: "Pod" }

// List namespaced Pods
{ resourceType: "Pod", action: "list", scope: "namespaced" }

// Create Deployment
{ resourceType: "Deployment", action: "create" }

// Pod methods excluding delete actions
{ resourceType: "Pod", exclude: { actions: ["delete"] } }

// Pod methods excluding CoreV1Api (shows only PolicyV1Api, AutoscalingV1Api, etc.)
{ resourceType: "Pod", exclude: { apiClasses: ["CoreV1Api"] } }
```

**Types Mode Examples:**
```typescript
// Get V1Pod type definition
{ mode: "types", types: ["V1Pod"] }

// Get multiple types
{ mode: "types", types: ["V1Pod", "V1Deployment", "V1Service"] }

// Navigate to nested types using dot notation
{ mode: "types", types: ["V1Deployment.spec"] }  // Returns V1DeploymentSpec
{ mode: "types", types: ["V1Pod.spec.containers"] }  // Returns V1Container (array element)
{ mode: "types", types: ["V1Pod.status.conditions"] }  // Returns V1PodCondition

// Include nested types at depth 2
{ mode: "types", types: ["V1Pod"], depth: 2 }
```

**Scripts Mode Examples:**
```typescript
// List all cached scripts
{ mode: "scripts" }

// Search for pod-related scripts
{ mode: "scripts", searchTerm: "pod" }
```

**Prometheus Mode Examples:**
```typescript
// List all available methods
{ mode: "prometheus" }

// Find PromQL query methods
{ mode: "prometheus", category: "query" }

// Find metadata methods (labels, series, targets)
{ mode: "prometheus", category: "metadata" }

// Search for specific methods
{ mode: "prometheus", methodPattern: "query" }

// Discover actual metrics from your cluster
{ mode: "prometheus", category: "metrics", methodPattern: "pod" }

// Find GPU metrics
{ mode: "prometheus", category: "metrics", methodPattern: "gpu" }
```

**Available Categories (Prometheus Mode):**

| Category | Methods | Use Case |
|----------|---------|----------|
| `query` | `instantQuery`, `rangeQuery` | Execute PromQL queries |
| `metadata` | `series`, `labelNames`, `labelValues`, `targets` | Explore metrics metadata |
| `alerts` | `rules`, `alerts`, `alertmanagers` | Access alerting information |
| `metrics` | (dynamic from cluster) | Discover actual metrics with descriptions |

---

## Integration Tests

End-to-end testing instructions (KIND cluster + Claude Agent SDK driver) now live in `docs/integration-testing.md`. The workflow is manual-only for now and assumes your Anthropic credentials are already configured. Run it locally with:

```bash
npm run test:integration
```

---

## License

MIT

