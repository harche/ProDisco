# ProDisco (Progressive Disclosure Kubernetes MCP Server)

ProDisco gives AI agents **Kubernetes access + Prometheus metrics + Loki logs + advanced analytics** through two unified tools. It follows Anthropic's [Progressive Disclosure](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern: the MCP server exposes search tools which surface API methods, agents discover them to write code, execute it in a sandbox, and only the final console output returns to the agent.

**Beyond simple resource fetching** - ProDisco includes statistical analysis, machine learning, and signal processing libraries for in-depth cluster observability:

- **Log Querying** - Search Loki logs with LogQL, explore labels, and analyze log streams
- **Anomaly Detection** - Find outliers using z-scores and standard deviations
- **Trend Forecasting** - Predict resource exhaustion with polynomial regression
- **Correlation Analysis** - Discover relationships between metrics with Pearson correlation
- **Periodic Pattern Detection** - Identify scheduled jobs using FFT frequency analysis
- **Capacity Planning** - Forecast when you'll hit resource limits

[![Watch the demo](https://img.youtube.com/vi/W-DyrsGRJeQ/maxresdefault.jpg)](https://www.youtube.com/watch?v=W-DyrsGRJeQ)

---

## Table of Contents

- [Why Progressive Disclosure?](#why-progressive-disclosure)
- [Quick Start](#quick-start)
  - [Add to Claude Code](#add-to-claude-code)
  - [Environment Variables](#environment-variables)
  - [Development Setup](#development-setup)
  - [HTTP Transport](#http-transport)
- [Available Tools](#available-tools)
  - [kubernetes.searchTools](#kubernetessearchtools)
  - [kubernetes.runSandbox](#kubernetesrunsandbox)
- [Advanced Analytics](#advanced-analytics)
- [Advanced Deployment](#advanced-deployment)
  - [Container Isolation](#container-isolation)
  - [Transport Security (TLS/mTLS)](#transport-security-tlsmtls)
- [Testing](#testing)
- [Additional Documentation](#additional-documentation)
- [License](#license)

---

## Why Progressive Disclosure?

Anthropic's latest guidance explains why MCP servers should progressively reveal capabilities instead of dumping every tool definition into the model context. When agents explore a filesystem of TypeScript modules, they only load what they need and process data inside the execution environment, then return a concise result to the chat. This keeps token usage low, improves latency, and avoids copying large intermediate payloads through the model ([source](https://www.anthropic.com/engineering/code-execution-with-mcp)).

ProDisco goes a step further: instead of exposing custom TypeScript modules, it provides a structured parameter search tool that dynamically extracts methods from upstream libraries using TypeScript AST parsing. This means:

- **Zero maintenance** - Methods are extracted directly from library `.d.ts` files
- **Always current** - Upgrading a dependency automatically exposes new methods
- **Type-safe** - Full parameter types and return types included

---

## Quick Start

### Add to Claude Code

```bash
# Set environment variables first (--env flag may not work reliably)
export KUBECONFIG="${HOME}/.kube/config"

# Then add the MCP server
claude mcp add ProDisco -- npx -y @prodisco/k8s-mcp
```

**With Prometheus (optional):**

```bash
export KUBECONFIG="${HOME}/.kube/config"
export PROMETHEUS_URL="http://localhost:9090"
claude mcp add ProDisco -- npx -y @prodisco/k8s-mcp
```

**Remove if needed:**

```bash
claude mcp remove ProDisco
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KUBECONFIG` | No | Path to kubeconfig (defaults to `~/.kube/config`) |
| `K8S_CONTEXT` | No | Kubernetes context (defaults to current context) |
| `PROMETHEUS_URL` | No | Prometheus server URL for metrics queries |
| `LOKI_URL` | No | Loki server URL for log queries |

> **Important:** Export environment variables before running `claude mcp add`. The `--env` flag may not reliably pass variables to the MCP server process.

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

**Startup Options:**

| Flag | Description |
|------|-------------|
| `--clear-cache` | Clear the scripts cache before starting |
| `--transport <mode>` | Transport mode: `stdio` (default) or `http` |
| `--host <host>` | HTTP host to bind to (default: `127.0.0.1`) |
| `--port <port>` | HTTP port (default: `3000`, implies `--transport http`) |

```bash
node dist/server.js --clear-cache
```

### HTTP Transport

ProDisco supports HTTP transport for network-based MCP connections, enabling remote access and containerized deployments.

**Start in HTTP mode:**

```bash
# HTTP mode on default port (3000)
node dist/server.js --transport http

# HTTP mode on custom port
node dist/server.js --port 8080

# HTTP mode on all interfaces (for network access)
node dist/server.js --host 0.0.0.0 --port 3000
```

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode (`stdio` or `http`) |
| `MCP_HOST` | `127.0.0.1` | HTTP host to bind to |
| `MCP_PORT` | `3000` | HTTP port to listen on |

**HTTP Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check, returns `{"status":"ok"}` |
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP) |

**Example: Connect with curl**

```bash
# Health check
curl http://localhost:3000/health

# Initialize MCP session
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'

# Use session ID from response header for subsequent requests
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id-from-init>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

The HTTP transport uses the MCP SDK's `StreamableHTTPServerTransport`, which supports session management via `mcp-session-id` headers and Server-Sent Events (SSE) for streaming responses.

---

## Available Tools

ProDisco exposes two tools:

### kubernetes.searchTools

A unified search interface for discovering methods across all supported libraries: Kubernetes API, Prometheus, Loki, and Analytics.

| Mode | Purpose | Example |
|------|---------|---------|
| `search` (default) | Search all indexed methods | `{ query: "Pod" }` or `{ documentType: "loki" }` |
| `types` | Get TypeScript type definitions | `{ mode: "types", types: ["V1Pod.spec"] }` |

**Document Types:**

| Type | Description |
|------|-------------|
| `kubernetes` | Kubernetes API methods (CoreV1Api, AppsV1Api, etc.) |
| `prometheus` | Prometheus client methods (query, metadata, alerts) |
| `prometheus-metric` | Live Prometheus metrics (requires PROMETHEUS_URL) |
| `loki` | Loki client methods (queryRange, labels, series) |
| `analytics` | Statistics/ML libraries (simple-statistics, ml-regression, etc.) |
| `script` | Cached sandbox scripts |
| `all` | Search all document types (default) |

**Examples:**

```typescript
// Find Pod-related methods (searches all types)
{ query: "Pod" }

// Filter by document type
{ query: "Pod", documentType: "kubernetes" }

// Find Loki query methods
{ documentType: "loki", action: "query" }

// Find Prometheus methods by category
{ documentType: "prometheus", action: "query" }

// Discover cluster metrics
{ documentType: "prometheus-metric", query: "cpu" }

// Find analytics functions
{ documentType: "analytics", library: "simple-statistics" }

// Search cached scripts
{ documentType: "script", query: "deployment" }

// Get type definitions with path navigation
{ mode: "types", types: ["V1Deployment.spec.template.spec"] }

// Exclude certain actions/libraries
{ query: "Pod", exclude: { actions: ["delete"], libraries: ["CustomObjectsApi"] } }
```

For comprehensive documentation, see [docs/search-tools.md](docs/search-tools.md).

### kubernetes.runSandbox

Execute TypeScript code in a sandboxed environment for Kubernetes, Prometheus, and Loki operations.

**Execution Modes:**

| Mode | Purpose | Key Parameters |
|------|---------|----------------|
| `execute` (default) | Blocking execution | `code` or `cached`, `timeout` |
| `stream` | Real-time output streaming | `code` or `cached`, `timeout` |
| `async` | Background execution | `code` or `cached`, `timeout` |
| `status` | Check async execution | `executionId`, `wait`, `outputOffset` |
| `cancel` | Cancel running execution | `executionId` |
| `list` | List active executions | `states`, `limit` |

**Sandbox Environment:**

- `k8s` - Full `@kubernetes/client-node` library
- `kc` - Pre-configured KubeConfig instance
- `console` - Captured output (log, error, warn, info)
- `require()` - Whitelisted modules:
  - `@kubernetes/client-node` - Kubernetes API client
  - `prometheus-query` - Prometheus PromQL queries
  - `@prodisco/loki-client` - Loki LogQL queries
  - `simple-statistics` - Descriptive stats, z-scores, regression
  - `ml-regression` - Polynomial, exponential, power regression
  - `mathjs` - Matrix operations, linear algebra
  - `fft-js` - Fast Fourier Transform for signal analysis
- `process.env` - Environment variables (PROMETHEUS_URL, LOKI_URL, etc.)

**Examples:**

```typescript
// Execute code (default mode)
{
  code: `
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await api.listNamespacedPod({ namespace: 'default' });
    console.log(\`Found \${pods.items.length} pods\`);
  `
}

// Run a cached script
{ cached: "script-2025-01-01T12-00-00-abc123.ts" }

// Stream mode - real-time output
{ mode: "stream", code: "for(let i=0; i<5; i++) console.log(i)" }

// Async mode - start long-running task
{ mode: "async", code: "longRunningTask()" }

// Check async execution status
{ mode: "status", executionId: "abc-123", wait: true }

// Cancel a running execution
{ mode: "cancel", executionId: "abc-123" }

// Query Loki logs
{
  code: `
    const { LokiClient } = require('@prodisco/loki-client');
    const client = new LokiClient({ baseUrl: process.env.LOKI_URL });
    const result = await client.queryRange('{namespace="default"}', { since: '1h', limit: 100 });
    result.logs.forEach(log => console.log(\`[\${log.timestamp.toISOString()}] \${log.line}\`));
  `
}
```

For architecture details, see [docs/grpc-sandbox-architecture.md](docs/grpc-sandbox-architecture.md).

---

## Advanced Analytics

ProDisco goes beyond simple resource fetching - it provides **statistical analysis, machine learning, and signal processing** capabilities for deep cluster observability.

**Available Libraries:**

| Library | Purpose |
|---------|---------|
| `simple-statistics` | Mean, median, std dev, z-scores, percentiles, linear regression, correlation |
| `ml-regression` | Polynomial, exponential, and power regression for trend forecasting |
| `mathjs` | Matrix operations, linear algebra, symbolic math |
| `fft-js` | Fast Fourier Transform for detecting periodic patterns |

**Example Prompts:**

| Use Case | Prompt |
|----------|--------|
| **Log Analysis** | "Query Loki for error logs from the nginx app in the last hour. Show me the most common error patterns." |
| **Cluster Health** | "Analyze CPU and memory usage across all pods. Calculate mean, median, standard deviation, and identify outliers using z-scores. Show pods above the 95th percentile." |
| **Memory Leaks** | "Check for memory leaks. Fetch memory usage over 2 hours and use linear regression to identify pods with increasing memory." |
| **Anomaly Detection** | "Analyze network traffic and detect anomalies. Find receive/transmit rates more than 2 standard deviations from normal." |
| **Correlation** | "Find correlations between CPU and memory usage. Tell me if high CPU correlates with high memory." |
| **Periodic Patterns** | "Use FFT analysis on node CPU to detect periodic patterns. Are there dominant frequencies suggesting scheduled jobs?" |
| **Capacity Planning** | "Analyze resource trends and use polynomial regression to forecast when we might hit resource limits." |

For detailed examples with code and output, see [docs/analytics.md](docs/analytics.md).

---

## Advanced Deployment

### Container Isolation

For stronger isolation, run the sandbox server in a Kubernetes cluster and connect via TCP.

**1. Deploy the sandbox server:**

```bash
# Build and load the image (for kind clusters)
docker build -f packages/sandbox-server/Dockerfile -t prodisco/sandbox-server:latest .
kind load docker-image prodisco/sandbox-server:latest

# Deploy
kubectl apply -f packages/sandbox-server/k8s/deployment.yaml

# Port-forward to access locally
kubectl -n prodisco port-forward service/sandbox-server 50051:50051
```

**2. Configure the MCP server to use TCP:**

```bash
export KUBECONFIG="${HOME}/.kube/config"
export SANDBOX_USE_TCP=true
export SANDBOX_TCP_HOST=localhost
export SANDBOX_TCP_PORT=50051
claude mcp add ProDisco -- npx -y @prodisco/k8s-mcp
```

**Transport Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_USE_TCP` | `false` | Use TCP instead of local subprocess |
| `SANDBOX_TCP_HOST` | `localhost` | Sandbox server host |
| `SANDBOX_TCP_PORT` | `50051` | Sandbox server port |

### Transport Security (TLS/mTLS)

For production deployments, the sandbox server supports TLS and mutual TLS (mTLS):

| Mode | Description |
|------|-------------|
| `insecure` | No encryption (default, for local development) |
| `tls` | Server-side TLS (client verifies server identity) |
| `mtls` | Mutual TLS (both client and server authenticate) |

**Configuration:**

```bash
# Server-side TLS
export SANDBOX_TRANSPORT_MODE=tls
export SANDBOX_TLS_CERT_PATH=/path/to/server.crt
export SANDBOX_TLS_KEY_PATH=/path/to/server.key

# Client-side (MCP server)
export SANDBOX_TRANSPORT_MODE=tls
export SANDBOX_TLS_CA_PATH=/path/to/ca.crt
```

For Kubernetes deployments, use cert-manager to automate certificate management. See the [k8s/cert-manager](packages/sandbox-server/k8s/cert-manager) directory for ready-to-use manifests.

For full architecture and security details, see [docs/grpc-sandbox-architecture.md](docs/grpc-sandbox-architecture.md).

---

## Testing

### Integration Tests

End-to-end testing with KIND cluster + Claude Agent SDK:

```bash
npm run test:integration
```

For detailed testing instructions, see [docs/integration-testing.md](docs/integration-testing.md).

---

## Additional Documentation

| Document | Description |
|----------|-------------|
| [docs/analytics.md](docs/analytics.md) | **Advanced analytics guide** - anomaly detection, forecasting, correlation, FFT analysis |
| [docs/search-tools.md](docs/search-tools.md) | Complete searchTools reference with examples and technical architecture |
| [docs/grpc-sandbox-architecture.md](docs/grpc-sandbox-architecture.md) | Sandbox architecture, gRPC protocol, and security configuration |
| [docs/integration-testing.md](docs/integration-testing.md) | Integration test workflow and container tests |

---

## License

MIT
