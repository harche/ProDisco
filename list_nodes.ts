import { listNodes } from './generated/servers/kubernetes/listNodes.js';

async function getNodes() {
  try {
    console.log('Listing cluster nodes...\n');

    const nodes = await listNodes({});

    console.log('Cluster Nodes:');
    console.log(JSON.stringify(nodes, null, 2));
  } catch (error) {
    console.error('Error listing nodes:', error);
  }
}

getNodes();
