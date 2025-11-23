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

## Quick Start

```bash
npm install
npm run build
claude mcp add --transport stdio prodisco -- node dist/server.js
claude mcp remove prodisco # remove when you're done
```

Only **one tool** (`kubernetes.searchTools`) is advertised to the agent. Everything else is discovered via resources, so agents naturally stay in code mode.

### Scripts cache convention

Agents should write any helper scripts to `scripts/cache/<name>.ts` and execute them with `npx tsx scripts/cache/<name>.ts --flag=value --another=value2` (add as many flags as needed). Scripts must parse CLI args (or env vars) for every required value—never hardcode namespaces, pod names, etc.—and should print a brief usage message if arguments are missing. The `kubernetes.searchTools` response now lists any cached scripts so agents can reuse or update them instead of creating duplicates.

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

// Delete Service
{ resourceType: "Service", action: "delete", scope: "namespaced" }
```

**Output Example:**
```
Found 1 method(s) for resource "Pod", action "list", scope "namespaced"

1. CoreV1Api.listNamespacedPod
   method_args: { namespace: "string" }
   return_values: response.items (array of Pod)
   return_types: export class V1PodList {
     key properties: apiVersion?: string;, items: Array<V1Pod>;, kind?: string;
     (use kubernetes.getTypeDefinition for complete type details)
```

**Key Features:**
- Structured parameter matching: specify resource type, action, and scope
- Shows all required parameters (including special cases like CustomObjectsApi)
- Clear indication of return structure (`response` vs `response.items`)
- Brief inline type information with key properties
- Available actions: list, read, create, delete, patch, replace, connect, get, watch

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

**Example Output:**
```typescript
{
  "V1Pod": {
    "name": "V1Pod",
    "definition": "V1Pod {\n  apiVersion?: string\n  kind?: string\n  metadata?: V1ObjectMeta\n  spec?: V1PodSpec\n  status?: V1PodStatus\n  ...\n}",
    "nestedTypes": ["V1ObjectMeta", "V1PodSpec", "V1PodStatus"]
  }
}
```

**Key Features:**
- Native TypeScript parsing (uses TypeScript Compiler API, no regex)
- Dot notation for navigating nested types
- Automatic resolution of `Array<T>`, unions, and type references
- Controlled depth to avoid overwhelming output

**Type Definitions Location:**
All type definitions are read from:
```
node_modules/@kubernetes/client-node/dist/gen/models/
```
This directory contains 852 `.d.ts` files with complete Kubernetes type information.

---

## Integration Tests

End-to-end testing instructions (KIND cluster + Claude Agent SDK driver) now live in `docs/integration-testing.md`. The workflow is manual-only for now and assumes your Anthropic credentials are already configured. Run it locally with:

```bash
npm run test:integration
```

---

## License

MIT

