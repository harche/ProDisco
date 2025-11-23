# Integration Test Workflow

This project ships with an end-to-end integration test that proves an MCP agent
can connect to a live Kubernetes cluster, discover the generated tools, and
return structured JSON describing running pods. The flow is intentionally
interactive: it provisions a disposable KIND cluster, runs the MCP server
against it, and drives Claude via the TypeScript Agent SDK so the whole stack is
exercised together.

## Requirements

- Docker Engine (the KIND nodes run as Docker containers)
- `kind`, `kubectl`, `npm`, and `npx` available on your `PATH`
- `tsx` (installed automatically with project dependencies)
- A working Anthropic API configuration (e.g. `ANTHROPIC_API_KEY` already set)
- macOS or Linux host with permissions to run Docker

> Authentication is **not** validated by these scripts—they assume your CLI
> environment is already authorized before executing any calls.

## Running the Test

```bash
npm run test:integration
```

The runner script accepts a few optional environment variables:

| Variable        | Default   | Description                                  |
|-----------------|-----------|----------------------------------------------|
| `CLUSTER_NAME`  | `mcp-int` | KIND cluster name                            |
| `KIND_BIN`      | `kind`    | Custom path to the `kind` binary             |
| `KUBECTL_BIN`   | `kubectl` | Custom path to `kubectl`                     |
| `CLAUDE_INT_MODEL` | *(unset)* | Optional override for the Claude model |

All generated artifacts (kubeconfig, Claude response JSON, logs) live under
`artifacts/integration/`.

## What the Runner Does

The `scripts/integration/run-kind-integration.sh` script performs the following:

1. Spins up a KIND cluster (`kind create cluster --name $CLUSTER_NAME`).
2. Applies `tests/fixtures/sample-workload.yaml`, which creates a namespace plus
   a two-replica StatefulSet so pod names are deterministic.
3. Waits until both pods in `demo-int` are Ready.
4. Builds the MCP server (`npm run build && npm run codegen`).
5. Invokes `scripts/integration/claude-driver.ts`, which:
   - Uses the TypeScript Agent SDK to start the MCP server via stdio transport,
     attaching Claude to it with the structured-output schema described in the
     [Agent SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
   - Runs in bypass-permissions mode so no manual approvals are needed.
   - Prompts Claude to list the pods in `demo-int` and forces JSON output.
   - Writes the structured output to `artifacts/integration/claude-output.json`.
   - When run with `npm run test:integration -- --verbose`, streams key SDK events
     (tool calls, thinking updates, final result) to the console for debugging.
6. Runs `scripts/integration/verify-claude-output.ts` to ensure Claude reported
   both StatefulSet pods (`demo-nginx-0`, `demo-nginx-1`).
7. Tears everything down by deleting the KIND cluster.

If any step fails, the script aborts immediately and still attempts to delete
the cluster.

## Debugging Tips

- Logs from the runner stream to stdout; rerun with `bash -x` for more detail.
- KIND clusters stick around only if teardown fails. You can inspect them with
  `kind get clusters` or delete manually via `kind delete cluster --name mcp-int`.
- The Claude driver writes progress to stdout—review `artifacts/integration/`
  whenever verification fails.

CI currently skips this workflow; it is intended for manual validation on a
developer workstation.

