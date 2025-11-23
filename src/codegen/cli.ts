#!/usr/bin/env node
/**
 * CLI tool to generate code execution wrappers
 */

import * as path from 'node:path';
import { generateToolWrappers } from './generator.js';

const outputDir = process.argv[2] || path.join(process.cwd(), 'dist');

console.error('🔧 Generating code execution wrappers for Kubernetes MCP server...');
console.error(`📁 Output directory: ${outputDir}`);

generateToolWrappers(outputDir)
  .then(() => {
    console.error('✅ Code generation complete!');
    console.error(`\n📖 See ${path.join(outputDir, 'README.md')} for usage instructions.`);
  })
  .catch((error) => {
    console.error('❌ Code generation failed:', error);
    process.exit(1);
  });

