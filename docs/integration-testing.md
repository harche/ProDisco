# Integration Testing

This project ships with end-to-end integration tests that prove an MCP agent can connect to a live Kubernetes cluster, discover the generated tools, and execute operations. The tests are designed for manual validation on a developer workstation and CI automation.

---

## Table of Contents

- [Requirements](#requirements)
- [Claude Agent SDK Integration Test](#claude-agent-sdk-integration-test)
  - [Running the Test](#running-the-test)
  - [Environment Variables](#environment-variables)
  - [What the Runner Does](#what-the-runner-does)
  - [Debugging Tips](#debugging-tips)
- [Container Integration Tests](#container-integration-tests)
  - [Running Container Tests](#running-container-tests)
  - [Test Files](#test-files)
  - [What the Test Does](#what-the-test-does)
  - [Container Test Environment Variables](#container-test-environment-variables)
  - [Artifacts](#artifacts)

---

## Requirements

- Docker Engine (the KIND nodes run as Docker containers)
- `kind`, `kubectl`, `npm`, and `npx` available on your `PATH`
- `tsx` (installed automatically with project dependencies)
- A working Anthropic API configuration (e.g., `ANTHROPIC_API_KEY` already set)
- macOS or Linux host with permissions to run Docker

> **Note:** Authentication is **not** validated by these scripts - they assume your CLI environment is already authorized before executing any calls.

---

## Claude Agent SDK Integration Test

The Claude Agent SDK integration test provisions a disposable KIND cluster, runs the MCP server against it, and drives Claude via the TypeScript Agent SDK so the whole stack is exercised together.

### Running the Test

```bash
npm run test:integration
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_NAME` | `mcp-int` | KIND cluster name |
| `KIND_BIN` | `kind` | Custom path to the `kind` binary |
| `KUBECTL_BIN` | `kubectl` | Custom path to `kubectl` |
| `CLAUDE_INT_MODEL` | *(unset)* | Optional override for the Claude model |

All generated artifacts (kubeconfig, Claude response JSON, logs) live under `artifacts/integration/`.

### What the Runner Does

The `scripts/integration/run-kind-integration.sh` script performs the following:

1. **Cluster Setup** - Spins up a KIND cluster (`kind create cluster --name $CLUSTER_NAME`)
2. **Deploy Workloads** - Applies `tests/fixtures/sample-workload.yaml`, which creates a namespace plus a two-replica StatefulSet so pod names are deterministic
3. **Wait for Ready** - Waits until both pods in `demo-int` are Ready
4. **Build** - Builds the MCP server (`npm run build`)
5. **Run Claude Driver** - Invokes `scripts/integration/claude-driver.ts`, which:
   - Uses the TypeScript Agent SDK to start the MCP server via stdio transport, attaching Claude to it with the structured-output schema
   - Runs in bypass-permissions mode so no manual approvals are needed
   - Prompts Claude to list the pods in `demo-int` and forces JSON output
   - Writes the structured output to `artifacts/integration/claude-output.json`
   - When run with `npm run test:integration -- --verbose`, streams key SDK events (tool calls, thinking updates, final result) to the console for debugging
6. **Verify Output** - Runs `scripts/integration/verify-claude-output.ts` to ensure Claude reported both StatefulSet pods (`demo-nginx-0`, `demo-nginx-1`)
7. **Cleanup** - Tears everything down by deleting the KIND cluster

If any step fails, the script aborts immediately and still attempts to delete the cluster.

### Debugging Tips

- Logs from the runner stream to stdout; rerun with `bash -x` for more detail
- KIND clusters stick around only if teardown fails. Inspect them with `kind get clusters` or delete manually via `kind delete cluster --name mcp-int`
- The Claude driver writes progress to stdout - review `artifacts/integration/` whenever verification fails

> **Note:** CI currently skips this workflow; it is intended for manual validation on a developer workstation.

---

## Container Integration Tests

The project also includes automated container integration tests that run in CI. These tests verify the sandbox-server works correctly when deployed as a container in a Kubernetes cluster.

### Running Container Tests

```bash
./scripts/integration/run-container-integration.sh
```

Or with a custom local port (to avoid conflicts):

```bash
LOCAL_PORT=50053 ./scripts/integration/run-container-integration.sh
```

### Test Files

| File | Description |
|------|-------------|
| `scripts/integration/run-container-integration.sh` | Creates KIND cluster, builds/loads Docker image, deploys, and runs tests |
| `scripts/integration/container-tests.ts` | TypeScript tests for health check, code execution, K8s API access, caching, and error handling |
| `.github/workflows/ci.yml` | The `container-integration` job |

### What the Test Does

1. **Create Cluster** - Creates a KIND cluster (`sandbox-int`)
2. **Build Image** - Builds the sandbox-server Docker image
3. **Load and Deploy** - Loads the image into KIND and deploys using K8s manifests
4. **Port Forward** - Sets up port-forwarding to the sandbox-server service
5. **Run Test Suite** - Verifies:
   - Health check returns healthy with `inClusterContext`
   - Simple code and TypeScript execution
   - Kubernetes API access (list namespaces, list pods)
   - Script caching
   - Error and timeout handling
6. **Cleanup** - Cleans up the KIND cluster

### Container Test Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_NAME` | `sandbox-int` | KIND cluster name for container tests |
| `LOCAL_PORT` | `50052` | Local port for port-forwarding (avoids conflicts) |
| `KIND_BIN` | `kind` | Custom path to the `kind` binary |
| `KUBECTL_BIN` | `kubectl` | Custom path to `kubectl` |

### Artifacts

Container integration test artifacts are stored in `artifacts/container-integration/`:

| Artifact | Description |
|----------|-------------|
| `kubeconfig` | Kubeconfig for the test cluster |
| `deployment.yaml` | The actual manifest applied to the cluster |

---

## Related Documentation

- [gRPC Sandbox Architecture](grpc-sandbox-architecture.md) - Architecture details for the sandbox server being tested
- [searchTools Reference](search-tools.md) - Documentation for the API discovery tools
