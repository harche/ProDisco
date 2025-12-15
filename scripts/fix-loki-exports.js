#!/usr/bin/env node

/**
 * Fix for @openally/loki package exports bug.
 *
 * The package.json exports field specifies:
 *   "import": "./dist/index.mjs"
 *   "require": "./dist/index.js"
 *
 * But the actual files are:
 *   ./dist/index.js (ESM)
 *   ./dist/index.cjs (CommonJS)
 *
 * This script patches the package.json to fix the exports.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagePath = join(__dirname, '../node_modules/@openally/loki/package.json');

if (!existsSync(packagePath)) {
  console.log('[@openally/loki] Package not found, skipping patch');
  process.exit(0);
}

try {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));

  // Check if patch is needed
  if (pkg.exports?.['.']?.import === './dist/index.mjs') {
    pkg.exports['.'].import = './dist/index.js';
    pkg.exports['.'].require = './dist/index.cjs';

    writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[@openally/loki] Fixed exports field in package.json');
  } else {
    console.log('[@openally/loki] Exports already fixed or not applicable');
  }
} catch (error) {
  console.error('[@openally/loki] Failed to patch:', error.message);
}
