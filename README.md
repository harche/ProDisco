# ProDisco (Progressive Disclosure Kuberentes MCP Server)

ProDisco gives MCP agents Kubernetes access that exactly follows Anthropic’s [Progressive Disclosure](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern: the server exposes TypeScript modules, agents discover them through the filesystem, write code, and only the final console output returns to the chat.

## Why Progressive Disclosure Matters

Anthropic’s latest guidance explains why MCP servers should progressively reveal capabilities instead of dumping every tool definition into the model context. When agents explore a filesystem of TypeScript modules, as they do with ProDisco, they only load what they need and process data inside the execution environment, then return a concise result to the chat. This keeps token usage low, improves latency, and avoids copying large intermediate payloads through the model ([source](https://www.anthropic.com/engineering/code-execution-with-mcp)).

In practice that means:
- Agents only see a single advertised tool (`kubernetes.searchTools`); they call it with structured parameters (resourceType, action, scope) to discover the TypeScript modules (get pods, list nodes, fetch logs, etc.) that the server exposes, then write their own code to compose those modules without loading unused schemas.
- Letting the model issue one instruction instead of micromanaging dozens of sequential tool calls.
- Agents can mix and match multiple Kubernetes modules joining pod stats with node health, or correlating events with logs without shuttling raw outputs between tools in the chat loop, which dramatically cuts token usage.

ProDisco ships with this layout out of the box, so any Claude Code or MCP-enabled agent can immediately adopt the progressive-disclosure workflow.

---

## Demo

![Demo](docs/demo.gif)

---

## Quick Start

### Add to Claude Code

Add ProDisco to Claude Code with a single command:

```bash
claude mcp add ProDisco --env KUBECONFIG="${HOME}/.kube/config" -- npx -y @prodisco/k8s-mcp
```
Remove if needed:
```bash
claude mcp remove ProDisco
```

**Optional environment variables:**
- `KUBECONFIG`: Path to your kubeconfig file (defaults to `~/.kube/config`)
- `K8S_CONTEXT`: Kubernetes context to use (defaults to current context)

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

### Scripts cache convention

**Script Location:** `~/.prodisco/scripts/cache/`

ProDisco automatically creates a `~/.prodisco/scripts/cache/` directory in your home directory for storing helper scripts. This ensures scripts work from any directory and persist across sessions.

---

## Available Tools

ProDisco exposes two main tools for agents to discover and interact with the Kubernetes API:

### 1. kubernetes.searchTools

Find Kubernetes API methods by resource type and action.

**Input:**
```typescript
{
  resourceType: string;  // e.g., "Pod", "Deployment", "Service"
  action?: string;       // e.g., "list", "read", "create", "delete", "patch", "replace", "connect"
  scope?: 'namespaced' | 'cluster' | 'all';  // default: 'all'
  exclude?: {            // Optional: filter out methods
    actions?: string[];     // e.g., ["delete", "create"]
    apiClasses?: string[];  // e.g., ["CoreV1Api"]
  };
  limit?: number;        // Max results (default: 10, max: 50)
}
```

**Example Queries:**
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

// Pod methods excluding delete from CoreV1Api only (AND logic)
{ resourceType: "Pod", exclude: { actions: ["delete"], apiClasses: ["CoreV1Api"] } }
```

### 2. kubernetes.getTypeDefinition

Get detailed TypeScript type definitions for Kubernetes types.

**Input:**
```typescript
{
  types: string[];      // Type names or property paths
                        // Examples: ["V1Pod", "V1Deployment.spec", "V1Pod.spec.containers"]
  depth?: number;       // Nested type depth (default: 1, max: 2)
}
```

**Dot Notation Support:**
Navigate directly to nested types:
- `V1Deployment.spec` → Returns `V1DeploymentSpec` type
- `V1Pod.spec.containers` → Returns `V1Container` type (array element)
- `V1Pod.status.conditions` → Returns `V1PodCondition` type

---

## Integration Tests

End-to-end testing instructions (KIND cluster + Claude Agent SDK driver) now live in `docs/integration-testing.md`. The workflow is manual-only for now and assumes your Anthropic credentials are already configured. Run it locally with:

```bash
npm run test:integration
```

---

## License

MIT

