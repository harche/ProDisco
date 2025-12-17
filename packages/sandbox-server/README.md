# @prodisco/sandbox-server

A gRPC-based sandbox server for secure TypeScript/JavaScript code execution with Kubernetes and Prometheus context. Designed to decouple code execution from MCP servers, enabling flexible deployment options and improved isolation.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Execution Modes](#execution-modes)
  - [Synchronous Execution](#synchronous-execution)
  - [Streaming Execution](#streaming-execution)
  - [Async Execution with Polling](#async-execution-with-polling)
  - [Test Execution](#test-execution)
- [Sandbox Environment](#sandbox-environment)
  - [Allowed Modules](#allowed-modules)
  - [Available Globals](#available-globals)
  - [Custom Module Configuration](#custom-module-configuration)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Transport Security](#transport-security)
- [API Reference](#api-reference)
  - [SandboxClient](#sandboxclient)
  - [Singleton Pattern](#singleton-pattern)
- [Docker & Kubernetes Deployment](#docker--kubernetes-deployment)
- [Development](#development)
- [Protocol](#protocol)
- [Architecture](#architecture)
- [License](#license)

## Features

- **Secure Sandboxed Execution** - Run untrusted code in Node.js VM with restricted module access
- **TypeScript Support** - Execute TypeScript directly with esbuild transformation
- **Multiple Execution Modes** - Synchronous, streaming, async, and test execution
- **Unit Testing** - Built-in test runner with structured results using uvu assertions
- **Kubernetes Integration** - Pre-configured access to `@kubernetes/client-node`
- **Prometheus/Loki Support** - Query metrics and logs from within scripts
- **Script Caching** - Automatic caching with content-based deduplication
- **Flexible Transport** - Unix socket (default) or TCP with optional TLS/mTLS
- **Container Ready** - Dockerfile and Kubernetes manifests included

## Installation

```bash
npm install @prodisco/sandbox-server
```

## Quick Start

### Starting the Server

```bash
# Using the CLI
npx sandbox-server

# Or programmatically
import { startServer } from '@prodisco/sandbox-server/server';

const server = await startServer({
  socketPath: '/tmp/prodisco-sandbox.sock',
  cacheDir: '/tmp/prodisco-scripts',
});
```

### Using the Client

```typescript
import { SandboxClient } from '@prodisco/sandbox-server/client';

const client = new SandboxClient();

// Simple execution
const result = await client.execute({
  code: `
    const k8s = require('@kubernetes/client-node');
    console.log('Kubernetes client loaded:', typeof k8s.CoreV1Api);
  `,
  timeoutMs: 30000,
});

console.log(result.success);  // true
console.log(result.output);   // "Kubernetes client loaded: function"
```

## Execution Modes

| Mode | Method | Use Case |
|------|--------|----------|
| **Synchronous** | `execute()` | Simple scripts, short execution time |
| **Streaming** | `executeStream()` | Real-time output, long-running scripts |
| **Async** | `executeAsync()` | Background execution with polling |
| **Test** | `executeTest()` | Unit testing with structured results |

### Synchronous Execution

```typescript
const result = await client.execute({
  code: 'console.log("Hello, World!");',
  timeoutMs: 30000,
});

// Result:
// {
//   success: true,
//   output: "Hello, World!",
//   executionTimeMs: 45
// }
```

### Streaming Execution

```typescript
for await (const chunk of client.executeStream({ code: longRunningScript })) {
  if (chunk.type === 'output') {
    process.stdout.write(chunk.data);
  } else if (chunk.type === 'error') {
    process.stderr.write(chunk.data);
  } else if (chunk.type === 'result') {
    console.log('Finished:', chunk.data.success);
  }
}
```

### Async Execution with Polling

```typescript
// Start execution
const { executionId } = await client.executeAsync({
  code: `
    for (let i = 0; i < 10; i++) {
      console.log("Processing:", i);
      await new Promise(r => setTimeout(r, 100));
    }
  `,
});

// Poll for status
const status = await client.getExecution(executionId, { wait: true });
console.log(status.state);  // 'completed'
console.log(status.output); // Processing output

// Or cancel if needed
await client.cancelExecution(executionId);
```

### Test Execution

Run unit tests with structured results using the built-in uvu test framework:

```typescript
const result = await client.executeTest({
  code: `
    function fibonacci(n: number): number[] {
      if (n <= 0) return [];
      if (n === 1) return [0];
      const seq = [0, 1];
      for (let i = 2; i < n; i++) {
        seq.push(seq[i-1] + seq[i-2]);
      }
      return seq;
    }
  `,
  tests: `
    test("fibonacci(0) returns empty array", () => {
      assert.equal(fibonacci(0), []);
    });

    test("fibonacci(5) returns correct sequence", () => {
      assert.equal(fibonacci(5), [0, 1, 1, 2, 3]);
    });

    test("each number is sum of previous two", () => {
      const seq = fibonacci(10);
      for (let i = 2; i < seq.length; i++) {
        assert.is(seq[i], seq[i-1] + seq[i-2]);
      }
    });
  `,
});

// Result:
// {
//   success: true,
//   summary: { total: 3, passed: 3, failed: 0, skipped: 0 },
//   tests: [
//     { name: 'fibonacci(0) returns empty array', passed: true, durationMs: 0 },
//     { name: 'fibonacci(5) returns correct sequence', passed: true, durationMs: 0 },
//     { name: 'each number is sum of previous two', passed: true, durationMs: 1 }
//   ],
//   executionTimeMs: 45
// }
```

**Important:** In test mode, `test()` and `assert` are pre-injected globals. Do NOT import them.

**Available Assertions:**

| Assertion | Description |
|-----------|-------------|
| `assert.is(a, b)` | Strict equality (`===`) |
| `assert.equal(a, b)` | Deep equality for objects/arrays |
| `assert.ok(val)` | Truthy check |
| `assert.not(val)` | Falsy check |
| `assert.throws(fn)` | Expects function to throw |

## Sandbox Environment

### Allowed Modules

By default, the sandbox allows these modules:

- `@kubernetes/client-node` - Kubernetes API client
- `@prodisco/prometheus-client` - Prometheus metrics queries
- `@prodisco/loki-client` - Loki log queries
- `simple-statistics` - Statistical analysis functions
- `uvu` - Test framework (always available for test mode)

### Available Globals

```typescript
// Console methods
console.log(), console.error(), console.warn(), console.info()

// Timers
setTimeout, setInterval, clearTimeout, clearInterval

// Built-ins
Promise, JSON, Buffer, Date, Math, Array, Object, String, Number, Boolean, Error

// Environment
process.env  // Read-only access to environment variables
```

### Custom Module Configuration

Configure allowed modules via environment variable or config file:

```bash
# Environment variable (JSON array or comma-separated)
export SANDBOX_ALLOWED_MODULES='["@kubernetes/client-node","lodash"]'

# Or via config file
export PRODISCO_CONFIG_PATH=/path/to/config.yaml
```

Config file format:
```yaml
libraries:
  - name: "@kubernetes/client-node"
    description: "Kubernetes API client"
  - name: "lodash"
    description: "Utility library"
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_SOCKET_PATH` | `/tmp/prodisco-sandbox.sock` | Unix socket path |
| `SANDBOX_USE_TCP` | `false` | Use TCP instead of Unix socket |
| `SANDBOX_TCP_HOST` | `0.0.0.0` / `localhost` | TCP host (server/client) |
| `SANDBOX_TCP_PORT` | `50051` | TCP port |
| `SCRIPTS_CACHE_DIR` | `/tmp/prodisco-scripts` | Cache directory |
| `SANDBOX_ALLOWED_MODULES` | (see above) | Allowed require() modules |
| `SANDBOX_MODULES_BASE_PATH` | `process.cwd()` | node_modules resolution base |

### Transport Security

| Variable | Description |
|----------|-------------|
| `SANDBOX_TRANSPORT_MODE` | `insecure`, `tls`, or `mtls` |
| `SANDBOX_TLS_CERT_PATH` | Server certificate path |
| `SANDBOX_TLS_KEY_PATH` | Server private key path |
| `SANDBOX_TLS_CA_PATH` | CA certificate path |
| `SANDBOX_TLS_CLIENT_CERT_PATH` | Client cert (mTLS) |
| `SANDBOX_TLS_CLIENT_KEY_PATH` | Client key (mTLS) |

## API Reference

### SandboxClient

```typescript
class SandboxClient {
  constructor(options?: SandboxClientOptions);

  // Synchronous execution
  execute(options: ExecuteOptions): Promise<ExecuteResult>;

  // Streaming execution
  executeStream(options: ExecuteOptions): AsyncGenerator<StreamChunk>;
  executeStreamWithAbort(options: ExecuteOptions, signal?: AbortSignal): AsyncGenerator<StreamChunk>;

  // Async execution
  executeAsync(options: ExecuteOptions): Promise<{ executionId: string; state: ExecutionState }>;
  getExecution(id: string, options?: GetExecutionOptions): Promise<ExecutionStatus>;
  waitForExecution(id: string): Promise<ExecutionStatus>;
  cancelExecution(id: string): Promise<CancelResult>;
  listExecutions(options?: ListOptions): Promise<ExecutionSummary[]>;

  // Test execution
  executeTest(options: ExecuteTestOptions): Promise<TestExecutionResult>;

  // Cache management
  listCache(filter?: string): Promise<CacheEntry[]>;
  clearCache(): Promise<number>;

  // Health check
  healthCheck(): Promise<{ healthy: boolean; kubernetesContext: string }>;
  waitForHealthy(timeoutMs: number): Promise<boolean>;

  close(): void;
}
```

### Singleton Pattern

```typescript
import { getSandboxClient, closeSandboxClient } from '@prodisco/sandbox-server/client';

// Get or create shared client instance
const client = getSandboxClient({ socketPath: '/tmp/sandbox.sock' });

// Close when done
closeSandboxClient();
```

## Docker & Kubernetes Deployment

### Building the Container

```bash
docker build -f packages/sandbox-server/Dockerfile -t prodisco/sandbox-server:latest .
```

### Kubernetes Deployment

```bash
# Deploy to cluster
kubectl apply -f packages/sandbox-server/k8s/deployment.yaml

# Port forward for local access
kubectl -n prodisco port-forward service/sandbox-server 50051:50051
```

### Connecting to Containerized Server

```typescript
// Via port-forward
const client = new SandboxClient({
  useTcp: true,
  tcpHost: 'localhost',
  tcpPort: 50051,
});

// Via in-cluster DNS
const client = new SandboxClient({
  useTcp: true,
  tcpHost: 'sandbox-server.prodisco.svc.cluster.local',
  tcpPort: 50051,
});
```

## Development

### Building

```bash
npm run build
```

### Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Security tests
npm run test:security

# E2E tests (requires kind cluster)
npm run test:e2e:setup
npm run test:e2e
npm run test:e2e:teardown
```

### Regenerating Protobuf Types

```bash
npm run proto:generate
```

### Development Server

```bash
npm run dev
```

## Protocol

The gRPC service is defined in `proto/sandbox.proto`. Key RPCs:

```protobuf
service SandboxService {
  rpc Execute(ExecuteRequest) returns (ExecuteResponse);
  rpc ExecuteStream(ExecuteRequest) returns (stream ExecuteChunk);
  rpc ExecuteAsync(ExecuteRequest) returns (ExecuteAsyncResponse);
  rpc GetExecution(GetExecutionRequest) returns (GetExecutionResponse);
  rpc CancelExecution(CancelExecutionRequest) returns (CancelExecutionResponse);
  rpc ListExecutions(ListExecutionsRequest) returns (ListExecutionsResponse);
  rpc ExecuteTest(ExecuteTestRequest) returns (ExecuteTestResponse);
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
  rpc ListCache(ListCacheRequest) returns (ListCacheResponse);
  rpc ClearCache(ClearCacheRequest) returns (ClearCacheResponse);
}
```

## Architecture

See [docs/grpc-sandbox-architecture.md](../../docs/grpc-sandbox-architecture.md) for detailed architecture documentation.

```
+---------------------------------------------------------------------+
|                         MCP Server                                   |
|  +-------------------+    +--------------------------------------+   |
|  | searchTools       |    | runSandbox Tool                      |   |
|  | (API discovery)   |    | (thin gRPC client wrapper)           |   |
|  +-------------------+    +------------------+-------------------+   |
|                                              |                       |
+----------------------------------------------+-----------------------+
                                               | gRPC over Unix Socket
                                               v
+---------------------------------------------------------------------+
|                     Sandbox gRPC Server                              |
|  +---------------------------------------------------------------+   |
|  | SandboxService                                                 |   |
|  | (Execute, ExecuteStream, ExecuteAsync, ExecuteTest, ...)      |   |
|  +---------------------------------------------------------------+   |
|                              |                                       |
|  +----------------+  +-------+--------+  +----------------------+    |
|  | Executor       |  | Execution      |  | CacheManager         |    |
|  | (VM + esbuild) |  | Registry       |  | (dedup, persist)     |    |
|  +----------------+  +----------------+  +----------------------+    |
+---------------------------------------------------------------------+
```

## License

See the repository root for license information.
