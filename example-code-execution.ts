/**
 * Example: Code Execution with MCP Pattern
 * 
 * This demonstrates how Claude writes code to interact with Kubernetes.
 * All complexity (authentication, API clients, etc.) is hidden.
 * Data flows through code, not through Claude's context window.
 */

import * as k8s from './generated/servers/kubernetes/index.js';

// Example 1: Simple pod listing
console.log('=== Example 1: List Pods ===');
const pods = await k8s.listPods({ namespace: 'demo' });
console.log(`Found ${pods.totalItems} pods in demo namespace`);

// Example 2: Filter and process data in code (not in context!)
console.log('\n=== Example 2: Find Failing Pods ===');
const allPods = await k8s.listPods({}); // All namespaces
const failingPods = allPods.items.filter(p => p.phase !== 'Running');
console.log(`${failingPods.length} pods are not running`);
if (failingPods.length > 0) {
  console.log('Failing pods:', failingPods.map(p => `${p.namespace}/${p.name}`));
}

// Example 3: Get logs for a specific pod
console.log('\n=== Example 3: Get Pod Logs ===');
if (pods.items.length > 0) {
  const firstPod = pods.items[0];
  const logs = await k8s.getPodLogs({
    namespace: firstPod.namespace,
    podName: firstPod.name,
    tailLines: 10,
  });
  console.log(`Last 10 lines from ${firstPod.name}:`);
  console.log(logs.logs);
}

// Example 4: Compose multiple operations
console.log('\n=== Example 4: Deployment Health Check ===');
const deployments = await k8s.listDeployments({ namespace: 'demo' });
for (const deploy of deployments.items) {
  if (deploy.availableReplicas < deploy.desiredReplicas) {
    console.log(`⚠️  ${deploy.name}: ${deploy.availableReplicas}/${deploy.desiredReplicas} ready`);
  } else {
    console.log(`✅ ${deploy.name}: All replicas ready`);
  }
}

console.log('\n=== Benefits ===');
console.log('✅ No Kubernetes client code needed');
console.log('✅ No authentication/kubeconfig handling');
console.log('✅ Data filtered in code, not in context');
console.log('✅ Only console.log output goes to Claude');

