#!/usr/bin/env tsx

/**
 * Example script to list Kubernetes nodes using the generated TypeScript modules
 */

import { listNodes } from './generated/servers/kubernetes/index.js';

async function main() {
  try {
    console.log('Fetching nodes...\n');

    const result = await listNodes({});

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error listing nodes:', error);
    process.exit(1);
  }
}

main();
