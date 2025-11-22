import { listPods } from '../../generated/servers/kubernetes/listPods.js';
import { getPod } from '../../generated/servers/kubernetes/getPod.js';

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const namespace = args.find(arg => arg.startsWith('--namespace='))?.split('=')[1] || 'kube-system';

  // List all pods and filter for etcd
  console.log(`Searching for etcd pods in namespace: ${namespace}\n`);
  const podList = await listPods({ namespace });

  const etcdPods = podList.items.filter(pod => pod.name.includes('etcd'));

  if (etcdPods.length === 0) {
    console.log('No etcd pods found');
    return;
  }

  console.log(`Found ${etcdPods.length} etcd pod(s):\n`);

  // Get detailed information for each etcd pod
  for (const pod of etcdPods) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Pod: ${pod.name}`);
    console.log(`${'='.repeat(80)}\n`);

    const details = await getPod({
      namespace: pod.namespace || namespace,
      name: pod.name
    });

    console.log('Summary:');
    console.log(`  Name: ${details.summary.name}`);
    console.log(`  Namespace: ${details.summary.namespace}`);
    console.log(`  UID: ${details.summary.uid}`);
    console.log(`  Phase: ${details.summary.phase}`);
    console.log(`  Pod IP: ${details.summary.podIP}`);
    console.log(`  Node: ${details.summary.nodeName}`);
    console.log(`  QoS Class: ${details.summary.qosClass}`);
    console.log(`  Ready: ${details.summary.readyContainers}/${details.summary.totalContainers}`);
    console.log(`  Restarts: ${details.summary.restarts}`);
    console.log(`  Age: ${details.summary.ageSeconds ? Math.floor(details.summary.ageSeconds / 60) + ' minutes' : 'N/A'}`);
    console.log(`  Created: ${details.summary.creationTimestamp}`);

    if (Object.keys(details.summary.labels || {}).length > 0) {
      console.log('\nLabels:');
      for (const [key, value] of Object.entries(details.summary.labels || {})) {
        console.log(`  ${key}: ${value}`);
      }
    }

    console.log('\nContainers:');
    for (const container of details.spec.containers || []) {
      console.log(`  - ${container.name}`);
      console.log(`    Image: ${container.image}`);
      if (container.ports && container.ports.length > 0) {
        console.log(`    Ports:`, container.ports);
      }
      if (container.resources) {
        console.log(`    Resources:`, container.resources);
      }
    }

    console.log('\nStatus:');
    console.log(`  Phase: ${details.status.phase}`);
    console.log(`  Pod IP: ${details.status.podIP}`);
    console.log(`  Host IP: ${details.status.hostIP}`);

    if (details.status.conditions && details.status.conditions.length > 0) {
      console.log('\nConditions:');
      for (const condition of details.status.conditions) {
        console.log(`  - ${JSON.stringify(condition)}`);
      }
    }

    if (details.status.containerStatuses && details.status.containerStatuses.length > 0) {
      console.log('\nContainer Statuses:');
      for (const status of details.status.containerStatuses) {
        console.log(`  - ${JSON.stringify(status)}`);
      }
    }

    if (details.summary.failingConditions.length > 0) {
      console.log('\n⚠️  Failing Conditions:');
      for (const condition of details.summary.failingConditions) {
        console.log(`  Type: ${condition.type}`);
        console.log(`  Status: ${condition.status}`);
        console.log(`  Reason: ${condition.reason}`);
        console.log(`  Message: ${condition.message}`);
      }
    }
  }
}

main().catch(console.error);
