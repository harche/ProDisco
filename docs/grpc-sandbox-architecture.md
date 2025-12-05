# gRPC Sandbox Architecture

This document describes the gRPC-based sandbox execution architecture used in ProDisco. The design decouples code execution from the MCP server, enabling flexible deployment options and improved isolation.

## Overview

The sandbox system follows a client-server model inspired by Kubernetes' kubelet/containerd architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Server                              │
│  ┌─────────────────┐    ┌──────────────────────────────────┐   │
│  │ searchTools     │    │ runSandbox Tool                  │   │
│  │ (API discovery) │    │ (thin gRPC client wrapper)       │   │
│  └─────────────────┘    └──────────────┬───────────────────┘   │
│                                        │                        │
└────────────────────────────────────────┼────────────────────────┘
                                         │ gRPC over Unix Socket
                                         │ unix:///tmp/prodisco-sandbox.sock
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Sandbox gRPC Server                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ Executor     │  │ CacheManager │  │ SandboxService        │ │
│  │ (VM + esbuild│  │ (dedup,      │  │ (Execute, HealthCheck)│ │
│  │  transform)  │  │  persist)    │  │                       │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│                                                                 │
│  Pre-configured: k8s client, KubeConfig, prometheus-query      │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Kubernetes-Aware Server
The gRPC sandbox server has Kubernetes and Prometheus context baked in:
- Loads `KubeConfig` from the environment at startup
- Provides pre-configured `k8s` module and `kc` (KubeConfig instance)
- Supports `require("prometheus-query")` for metrics queries

### 2. In-Repo but Extractable
The sandbox server lives in `packages/sandbox-server/` as an npm workspace package. This allows:
- Easy development and testing alongside the MCP server
- Future extraction to a separate repository if needed
- Independent versioning and deployment

### 3. Flexible Transport: Unix Socket or TCP
Communication supports both Unix domain sockets and TCP:

**Unix Socket (default)** - Best for local execution:
- Low latency
- Simple setup with no network configuration
- Secure by default (file system permissions)

**TCP Transport** - Enables remote execution:
- Connect to sandbox servers on different hosts
- Suitable for containerized deployments
- Configurable via options or environment variables

### 4. Language-Agnostic Protocol
The gRPC protocol is designed to be language-agnostic:
- `Execute` RPC accepts generic "code" (not TypeScript-specific)
- Different server implementations could execute Go, Python, etc.
- The protocol focuses on execution semantics, not language details

## Directory Structure

```
packages/sandbox-server/
├── proto/
│   └── sandbox.proto              # gRPC service definition
├── src/
│   ├── generated/                 # Auto-generated TypeScript from proto
│   │   └── sandbox.ts
│   ├── server/
│   │   ├── index.ts               # Server entry point
│   │   ├── sandbox-service.ts     # gRPC service implementation
│   │   ├── executor.ts            # VM execution logic
│   │   └── cache-manager.ts       # Script caching with deduplication
│   └── client/
│       └── index.ts               # gRPC client wrapper
├── package.json
├── tsconfig.json
└── buf.gen.yaml                   # Proto code generation config
```

## Protocol Definition

The gRPC service is defined in `proto/sandbox.proto`:

```protobuf
syntax = "proto3";

package prodisco.sandbox.v1;

service SandboxService {
  rpc Execute(ExecuteRequest) returns (ExecuteResponse);
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
}

message ExecuteRequest {
  oneof source {
    string code = 1;        // Code to execute
    string cached = 2;      // Name of cached script to run
  }
  optional int32 timeout_ms = 3;
}

message ExecuteResponse {
  bool success = 1;
  string output = 2;
  optional string error = 3;
  int64 execution_time_ms = 4;
  optional string cached_as = 5;
}

message HealthCheckRequest {}

message HealthCheckResponse {
  bool healthy = 1;
  string kubernetes_context = 2;
}
```

## Component Details

### MCP Server (`src/server.ts`)

The MCP server spawns the sandbox server as a subprocess on startup:

```typescript
async function startSandboxServer(): Promise<void> {
  const sandboxServerPath = path.resolve(__dirname, '../packages/sandbox-server/dist/server/index.js');
  const socketPath = process.env.SANDBOX_SOCKET_PATH || '/tmp/prodisco-sandbox.sock';

  sandboxProcess = spawn('node', [sandboxServerPath], {
    env: {
      ...process.env,
      SANDBOX_SOCKET_PATH: socketPath,
      SCRIPTS_CACHE_DIR,
    },
  });

  // Wait for health check to pass
  const client = getSandboxClient({ socketPath });
  const healthy = await client.waitForHealthy(10000);
  if (!healthy) {
    throw new Error('Sandbox server failed to start within timeout');
  }
}
```

### runSandbox Tool (`src/tools/kubernetes/runSandbox.ts`)

The MCP tool is a thin wrapper that forwards requests to the gRPC server:

```typescript
async execute(input) {
  const { code, cached, timeout = 30000 } = input;
  const client = getSandboxClient();

  const result = await client.execute({
    code,
    cached,
    timeoutMs: timeout,
  });

  return {
    success: result.success,
    output: result.output,
    error: result.error,
    executionTime: result.executionTimeMs,
    cachedScript: result.cachedAs,
  };
}
```

### gRPC Client (`packages/sandbox-server/src/client/index.ts`)

The client provides a high-level interface with connection management:

```typescript
export class SandboxClient {
  private client: SandboxServiceClient;

  constructor(options: SandboxClientOptions = {}) {
    const socketPath = options.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
    this.client = new SandboxServiceClient(
      `unix://${socketPath}`,
      grpc.credentials.createInsecure()
    );
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const request: ExecuteRequest = {
      timeoutMs: options.timeoutMs,
      source: undefined,
    };

    if (options.code) {
      request.source = { $case: 'code', code: options.code };
    } else if (options.cached) {
      request.source = { $case: 'cached', cached: options.cached };
    }

    return new Promise((resolve, reject) => {
      this.client.execute(request, (error, response) => {
        if (error) reject(error);
        else resolve(/* map response */);
      });
    });
  }

  async healthCheck(): Promise<{ healthy: boolean; kubernetesContext: string }>;
  async waitForHealthy(timeoutMs: number): Promise<boolean>;
  close(): void;
}

// Singleton pattern for connection reuse
let globalClient: SandboxClient | null = null;
export function getSandboxClient(options?: SandboxClientOptions): SandboxClient;
export function closeSandboxClient(): void;
```

### gRPC Server (`packages/sandbox-server/src/server/index.ts`)

The server binds to the Unix socket and handles graceful shutdown:

```typescript
export async function startServer(config: ServerConfig = {}): Promise<grpc.Server> {
  const socketPath = config.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;

  cleanupSocket(socketPath);  // Remove stale socket file

  const server = new grpc.Server();
  const sandboxService = createSandboxService({
    prometheusUrl: config.prometheusUrl || process.env.PROMETHEUS_URL,
    cacheDir: config.cacheDir || process.env.SCRIPTS_CACHE_DIR,
  });

  server.addService(SandboxServiceService, sandboxService);

  return new Promise((resolve, reject) => {
    server.bindAsync(
      `unix://${socketPath}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) reject(error);
        else resolve(server);
      }
    );
  });
}
```

### Executor (`packages/sandbox-server/src/server/executor.ts`)

The executor runs code in a Node.js VM with a sandboxed context:

```typescript
export class Executor {
  private kc: k8s.KubeConfig;

  constructor(config: ExecutorConfig = {}) {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
  }

  async execute(code: string, timeoutMs: number = 30000): Promise<ExecuteResult> {
    // Transform TypeScript to JavaScript
    const transformed = await esbuild.transform(code, {
      loader: 'ts',
      target: 'node18',
      format: 'cjs',
    });

    // Create sandbox context
    const context = vm.createContext({
      k8s,
      kc: this.kc,
      console: capturedConsole,
      require: sandboxRequire,  // Whitelisted modules only
      process: { env: process.env },
      setTimeout, setInterval, clearTimeout, clearInterval,
      Buffer, JSON, Date, Math, Promise, Array, Object, /* ... */
    });

    // Execute with timeout
    const script = new vm.Script(`(async () => { ${transformed.code} })()`);
    await script.runInContext(context, { timeout: timeoutMs });

    return { success: true, output: capturedOutput, executionTimeMs };
  }
}
```

### Cache Manager (`packages/sandbox-server/src/server/cache-manager.ts`)

The cache manager handles script persistence with deduplication:

```typescript
export class CacheManager {
  private mutex = new Mutex();

  async cacheScript(code: string): Promise<string | null> {
    const release = await this.mutex.acquire();
    try {
      const hash = this.hashCode(code);

      // Check for existing script with same content
      const existing = await this.findByHash(hash);
      if (existing) return null;  // Already cached

      const filename = this.generateFilename(code, hash);
      const content = this.addHeader(code);
      await fs.writeFile(path.join(this.cacheDir, filename), content);

      return filename;
    } finally {
      release();
    }
  }

  async findScript(nameOrPattern: string): Promise<string | null> {
    // Try exact match, then without extension, then partial match
  }
}
```

## Execution Flow

### 1. New Code Execution

```
User → MCP Server → runSandbox Tool → gRPC Client
                                           │
                                           ▼
                                      ExecuteRequest
                                      { code: "...", timeout_ms: 30000 }
                                           │
                                           ▼ (Unix Socket)
                                           │
                    gRPC Server ◄──────────┘
                         │
                         ▼
                    SandboxService.Execute()
                         │
                    ┌────┴────┐
                    ▼         ▼
               Executor  CacheManager
               (VM run)  (save if success)
                    │         │
                    └────┬────┘
                         ▼
                    ExecuteResponse
                    { success: true, output: "...", cached_as: "script-abc123.ts" }
                         │
                         ▼ (Unix Socket)
                         │
User ◄── MCP Server ◄── runSandbox Tool ◄── gRPC Client
```

### 2. Cached Script Execution

```
User → MCP Server → runSandbox Tool → gRPC Client
                                           │
                                           ▼
                                      ExecuteRequest
                                      { cached: "list-pods.ts" }
                                           │
                                           ▼ (Unix Socket)
                                           │
                    gRPC Server ◄──────────┘
                         │
                         ▼
                    SandboxService.Execute()
                         │
                         ▼
                    CacheManager.findScript("list-pods.ts")
                         │
                         ▼
                    Executor.execute(cachedCode)
                         │
                         ▼
                    ExecuteResponse
                    { success: true, output: "...", cached_as: null }
```

## Error Handling

| Error Type | gRPC Status | Description |
|------------|-------------|-------------|
| Script not found | `NOT_FOUND` | Cached script doesn't exist |
| Syntax error | `INVALID_ARGUMENT` | TypeScript/JavaScript parse error |
| Timeout | `DEADLINE_EXCEEDED` | Execution exceeded timeout |
| Module not allowed | `PERMISSION_DENIED` | Attempted to require blocked module |
| Runtime error | `INTERNAL` | Uncaught exception during execution |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_SOCKET_PATH` | `/tmp/prodisco-sandbox.sock` | Unix socket path |
| `SANDBOX_USE_TCP` | `false` | Use TCP transport instead of Unix socket (`true` or `1`) |
| `SANDBOX_TCP_HOST` | `0.0.0.0` (server) / `localhost` (client) | TCP host to bind/connect to |
| `SANDBOX_TCP_PORT` | `50051` | TCP port to bind/connect to |
| `SCRIPTS_CACHE_DIR` | `/tmp/prodisco-scripts` | Directory for cached scripts |
| `PROMETHEUS_URL` | (none) | Prometheus server URL |
| `KUBECONFIG` | `~/.kube/config` | Kubernetes config path |

## Testing

Tests start a real gRPC server with a test-specific socket:

```typescript
beforeAll(async () => {
  process.env.SANDBOX_SOCKET_PATH = '/tmp/prodisco-sandbox-test.sock';
  grpcServer = await startServer({ socketPath: TEST_SOCKET_PATH });

  const client = getSandboxClient({ socketPath: TEST_SOCKET_PATH });
  await client.waitForHealthy(5000);
});

afterAll(() => {
  closeSandboxClient();
  grpcServer.forceShutdown();
});
```

Run tests with:
```bash
npm test
```

## TCP Transport

The sandbox server supports TCP transport for remote execution. This enables running the sandbox server on a different host or in a container.

### Server Configuration

Start the server with TCP transport:

```typescript
// Programmatic configuration
import { startServer } from '@prodisco/sandbox-server';

await startServer({
  useTcp: true,
  tcpHost: '0.0.0.0',  // Bind to all interfaces
  tcpPort: 50051,
});

// Or using environment variables
// SANDBOX_USE_TCP=true SANDBOX_TCP_HOST=0.0.0.0 SANDBOX_TCP_PORT=50051 node server.js
```

### Client Configuration

Connect to a remote sandbox server:

```typescript
import { SandboxClient } from '@prodisco/sandbox-server';

// Explicit TCP configuration
const client = new SandboxClient({
  useTcp: true,
  tcpHost: 'sandbox.example.com',
  tcpPort: 50051,
});

// Or infer TCP from host/port (useTcp is optional when host/port are specified)
const client2 = new SandboxClient({
  tcpHost: 'sandbox.example.com',
  tcpPort: 50051,
});

// Or using environment variables
// SANDBOX_USE_TCP=true SANDBOX_TCP_HOST=sandbox.example.com SANDBOX_TCP_PORT=50051
const client3 = new SandboxClient();
```

### Choosing Between Unix Socket and TCP

| Use Case | Recommended Transport |
|----------|----------------------|
| Local development | Unix socket (default) |
| MCP server and sandbox on same host | Unix socket |
| Sandbox in separate container | TCP |
| Sandbox on remote host | TCP |
| Production with network isolation | TCP with TLS (see Future Enhancements) |

## Future Enhancements

### TLS/mTLS
Secure communication for production deployments:
```typescript
const credentials = grpc.credentials.createSsl(
  fs.readFileSync('ca.pem'),
  fs.readFileSync('client-key.pem'),
  fs.readFileSync('client-cert.pem')
);
```

### Container Isolation
Run the sandbox server in a container for stronger isolation:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sandbox-server
spec:
  containers:
  - name: sandbox
    image: prodisco/sandbox-server:latest
    ports:
    - containerPort: 50051
```

### Streaming Execution
Add streaming RPC for long-running scripts:
```protobuf
service SandboxService {
  rpc ExecuteStream(ExecuteRequest) returns (stream ExecuteChunk);
}
```
