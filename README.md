# Kubernetes MCP Server (Code Execution Pattern)

Kubernetes access for Claude that exactly follows Anthropic’s [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern: the MCP server exposes TypeScript modules, Claude discovers them through the filesystem, writes code, and only the final console output returns to the chat. All Kubernetes auth/client logic stays hidden.

---

## Quick Start

```bash
npm install
npm run build
npm run codegen
claude mcp add --transport stdio kube-mcp -- node dist/server.js
claude mcp remove kube-mcp # remove when you're done
```

Only **one tool** (`kubernetes.searchTools`) appears in `tools/list`. Everything else is discovered via resources, so Claude naturally stays in code mode.

---

## What Claude Actually Does

### Example 1 – “List nodes of this Kubernetes cluster”
1. `kubernetes.searchTools(query="node")` → finds `kubernetes.listNodes`
2. `kubernetes.searchTools(detailLevel="full")` → inspects schema
3. `listMcpResources` → sees `servers/kubernetes/listNodes.ts`
4. `readMcpResource("file:///servers/kubernetes/listNodes.ts")`
5. Reads `list-nodes-example.ts`, then runs `npx tsx list-nodes-example.ts`
6. Returns a human summary (roles, CPU/memory, kubelet version, pressure signals)

Result excerpt:
```
Node: kubemcp-control-plane
- Role: Control Plane
- CPU: 14 cores / Memory: ~7.7 GB / Pods: 110
- Health: Ready ✓  MemoryPressure False ✓ ...
```

Actual Claude output:
```
> list nodes of this kubernetes cluster 



⏺ I'll help you list the nodes in your Kubernetes cluster. Let me first search for available Kubernetes

  tools.

⏺ kube-mcp - kubernetes.searchTools (MCP)(query: "node", detailLevel: "summary")

  ⎿  {                                                                           

       "summary": "Found 1 tool(s) matching "node":\n  - kubernetes.listNodes",

       "tools": [

     … +7 lines (ctrl+o to expand)

⏺ kube-mcp - kubernetes.searchTools (MCP)(query: "listNodes", detailLevel: "full")

  ⎿  {                                                                                

       "summary": "Found 1 tool(s) matching "listnodes":\n  - kubernetes.listNodes",

       "tools": [

     … +27 lines (ctrl+o to expand)

⏺ Let me check the example file in your repository to see how to properly list nodes:

⏺ Read(list-nodes-example.ts)

  ⎿  Read 23 lines

⏺ Perfect! Let me run this example script to list the nodes in your cluster:

⏺ Bash(npx tsx list-nodes-example.ts)

  ⎿  Fetching nodes...             

     {

     … +87 lines (ctrl+o to expand)

⏺ Your Kubernetes cluster has 1 node:

  Node: kubemcp-control-plane

  - Role: Control Plane

  - Status: Ready

  - Internal IP: 172.18.0.8

  - Kubelet Version: v1.34.0

  - OS: Debian GNU/Linux 12 (bookworm)

  - Container Runtime: containerd 2.1.3

  - Architecture: arm64

  Resources:

  - CPU: 14 cores (14 allocatable)

  - Memory: ~7.7 GB (8024876 Ki)

  - Pods Capacity: 110

  - Ephemeral Storage: ~910 GB

  Health Status:

  - Memory Pressure: False ✓

  - Disk Pressure: False ✓

  - PID Pressure: False ✓

  - Ready: True ✓

  The node is healthy and operational!
```

### Example 2 – “List all pods from all namespaces”
1. `kubernetes.searchTools(query="pod", detail="full")` → sees listPods/getPod/getPodLogs
2. `Search("**/servers/kubernetes/*.ts")` → enumerates modules
3. Reads `generated/servers/kubernetes/listPods.ts`
4. Creates `list-all-pods.ts`, imports `listPods`, and runs `npx tsx list-all-pods.ts`
5. Returns a curated summary (namespaces, readiness, IPs) instead of raw JSON

Result excerpt:
```
Found 11 pods across demo / kube-system / local-path-storage
- demo-nginx-6fb7c6888-gjhpn – Running, 1/1 ready, IP 10.244.0.5
- ...
All pods healthy; 0 restarts
```

Actual Claude output:
```
> list all pods from all namespaces 



⏺ kube-mcp - kubernetes.searchTools (MCP)(query: "pod", detailLevel: "full")

  ⎿ {                                                                                                      

      "summary": "Found 3 tool(s) matching "pod":\n  - kubernetes.listPods\n  - kubernetes.getPod\n  - ku

    bernetes.getPodLogs",

    … +76 lines (ctrl+o to expand)

⏺ Let me check the available TypeScript modules to see how to list pods:

⏺ Search(pattern: "**/servers/kubernetes/*.ts")

  ⎿  Found 13 files (ctrl+o to expand)

⏺ Read(generated/servers/kubernetes/listPods.ts)

  ⎿  Read 20 lines

⏺ Let me create a script to list all pods from all namespaces:

⏺ Write(list-all-pods.ts)

  ⎿  Wrote 24 lines to list-all-pods.ts                                 

     #!/usr/bin/env tsx

     /**

      * List all pods from all namespaces

      */

     import { listPods } from './generated/servers/kubernetes/index.js';

     async function main() {

       try {

     … +14 lines (ctrl+o to expand)

⏺ Bash(npx tsx list-all-pods.ts)

  ⎿  Fetching pods from all namespaces...

     {

     … +245 lines (ctrl+o to expand)

⏺ Found 11 pods running across 3 namespaces:

  demo (2 pods)

  - demo-nginx-6fb7c6888-gjhpn - Running, 1/1 ready, IP: 10.244.0.5

  - demo-nginx-6fb7c6888-rlwkp - Running, 1/1 ready, IP: 10.244.0.6

  kube-system (8 pods)

  - coredns-66bc5c9577-fxgf8 - Running, 1/1 ready, IP: 10.244.0.2

  - coredns-66bc5c9577-lh6kt - Running, 1/1 ready, IP: 10.244.0.3

  - etcd-kubemcp-control-plane - Running, 1/1 ready, IP: 172.18.0.8

  - kindnet-x4qpb - Running, 1/1 ready, IP: 172.18.0.8

  - kube-apiserver-kubemcp-control-plane - Running, 1/1 ready, IP: 172.18.0.8

  - kube-controller-manager-kubemcp-control-plane - Running, 1/1 ready, IP: 172.18.0.8

  - kube-proxy-qhmgq - Running, 1/1 ready, IP: 172.18.0.8

  - kube-scheduler-kubemcp-control-plane - Running, 1/1 ready, IP: 172.18.0.8

  local-path-storage (1 pod)

  - local-path-provisioner-7b8c8ddbd6-rzj65 - Running, 1/1 ready, IP: 10.244.0.4

  All pods are healthy with 0 restarts and no failing conditions.
```

These transcripts prove the progressive-disclosure workflow is live: Claude uses search → reads code → writes and executes TypeScript.

---

## License

MIT

