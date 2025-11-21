#!/usr/bin/env tsx

/**
 * List all pods from all namespaces
 */

import { listPods } from './generated/servers/kubernetes/index.js';

async function main() {
  try {
    console.log('Fetching pods from all namespaces...\n');

    // Call without namespace to get all pods
    const result = await listPods({});

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error listing pods:', error);
    process.exit(1);
  }
}

main();
