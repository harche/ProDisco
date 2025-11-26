# ProDisco (Progressive Disclosure Kubernetes MCP Server)

ProDisco gives AI agents Kubernetes access that closely follows Anthropic’s [Progressive Disclosure](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern: the MCP server exposes search tools which in turn surface TypeScript modules, agents discover them to write code, and only the final console output returns to the agent.

## Why Progressive Disclosure Matters

Anthropic’s latest guidance explains why MCP servers should progressively reveal capabilities instead of dumping every tool definition into the model context. When agents explore a filesystem of TypeScript modules, they only load what they need and process data inside the execution environment, then return a concise result to the chat. This keeps token usage low, improves latency, and avoids copying large intermediate payloads through the model ([source](https://www.anthropic.com/engineering/code-execution-with-mcp)).

ProDisco goes a step further: instead of exposing custom TypeScript modules, it provides a structured parameter search tool that returns the most suitable methods from the official Kubernetes client library, including the type definitions for their input and return values. This lets agents dynamically interact with the upstream Kubernetes library while avoiding any ongoing maintenance burden in this repository to mirror or wrap those APIs.


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

ProDisco exposes a single tool with three modes for agents to discover and interact with the Kubernetes API.

For comprehensive documentation including architecture details and example workflows, see [docs/search-tools.md](docs/search-tools.md).

### kubernetes.searchTools

Find Kubernetes API methods, get type definitions, or search cached scripts.

**Input:**
```typescript
{
  // Mode selection
  mode?: 'methods' | 'types' | 'scripts';  // default: 'methods'

  // Methods mode parameters
  resourceType?: string;  // e.g., "Pod", "Deployment", "Service"
  action?: string;        // e.g., "list", "read", "create", "delete", "patch", "replace", "connect"
  scope?: 'namespaced' | 'cluster' | 'all';  // default: 'all'
  exclude?: {             // Optional: filter out methods
    actions?: string[];      // e.g., ["delete", "create"]
    apiClasses?: string[];   // e.g., ["CoreV1Api"]
  };

  // Types mode parameters
  types?: string[];       // Type names or property paths
  depth?: number;         // Nested type depth (default: 1, max: 2)

  // Scripts mode parameters
  searchTerm?: string;    // Search term (omit to list all scripts)

  // Shared parameters (all modes)
  limit?: number;         // Max results (default: 10, max: 50)
  offset?: number;        // Skip N results for pagination (default: 0)
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

// Search for logging scripts
{ mode: "scripts", searchTerm: "logs" }

// Paginate through scripts
{ mode: "scripts", limit: 5, offset: 5 }
```

---

## Integration Tests

End-to-end testing instructions (KIND cluster + Claude Agent SDK driver) now live in `docs/integration-testing.md`. The workflow is manual-only for now and assumes your Anthropic credentials are already configured. Run it locally with:

```bash
npm run test:integration
```

---

## License

MIT

