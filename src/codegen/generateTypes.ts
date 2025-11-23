#!/usr/bin/env tsx
/**
 * Generate inline TypeScript interfaces for Kubernetes tools
 * 
 * Usage: npm run codegen
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { extractInterfaceFromFile, findKubernetesTypeFile } from './typeExtractor.js';
import { generateExpandedInterface } from './interfaceGenerator.js';
import { TOOL_TYPE_MAPPINGS } from './toolMapping.js';

const DRY_RUN = process.argv.includes('--dry-run');

console.log('🔧 Kubernetes Type Generator');
console.log('============================\n');

if (DRY_RUN) {
  console.log('⚠️  DRY RUN MODE - No files will be modified\n');
}

for (const mapping of TOOL_TYPE_MAPPINGS) {
  console.log(`📄 Processing ${mapping.toolFile}...`);
  console.log(`   Type: ${mapping.kubernetesType} -> ${mapping.resultTypeName}`);

  // Special handling for simple types
  if (mapping.kubernetesType === 'string' || 
      mapping.kubernetesType.startsWith('Array<') ||
      mapping.kubernetesType === 'object') {
    console.log(`   ⏭️  Skipping (simple type)\n`);
    continue;
  }

  // Find the Kubernetes type file
  const typeFile = findKubernetesTypeFile(mapping.kubernetesType);
  
  if (!typeFile) {
    console.log(`   ❌ Could not find type file for ${mapping.kubernetesType}\n`);
    continue;
  }

  console.log(`   📖 Reading from ${path.basename(typeFile)}`);

  // Extract the interface
  const interfaceInfo = extractInterfaceFromFile(typeFile, mapping.kubernetesType);
  
  if (!interfaceInfo) {
    console.log(`   ❌ Could not extract interface ${mapping.kubernetesType}\n`);
    continue;
  }

  console.log(`   ✅ Extracted ${interfaceInfo.fields.length} fields`);

  // Generate the inline interface code
  const interfaceCode = generateExpandedInterface(
    mapping.resultTypeName,
    mapping.kubernetesType,
    interfaceInfo
  );

  if (DRY_RUN) {
    console.log(`   📝 Generated interface (${interfaceCode.split('\n').length} lines)`);
    console.log(`\n${interfaceCode}\n`);
    continue;
  }

  // Read the tool file
  const toolFilePath = path.resolve(process.cwd(), mapping.toolFile);
  
  if (!fs.existsSync(toolFilePath)) {
    console.log(`   ❌ Tool file not found: ${toolFilePath}\n`);
    continue;
  }

  const toolFileContent = fs.readFileSync(toolFilePath, 'utf-8');
  
  // Parse the tool file using TypeScript compiler
  const sourceFile = ts.createSourceFile(
    toolFilePath,
    toolFileContent,
    ts.ScriptTarget.Latest,
    true
  );

  // Find the interface declaration
  let interfaceNode: ts.InterfaceDeclaration | undefined;
  let interfaceStart = -1;
  let interfaceEnd = -1;

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && 
        node.name.text === mapping.resultTypeName &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      interfaceNode = node;
      // Get the full start (including JSDoc)
      interfaceStart = node.getFullStart();
      interfaceEnd = node.getEnd();
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!interfaceNode) {
    console.log(`   ⚠️  Could not find existing interface ${mapping.resultTypeName} to replace`);
    console.log();
    continue;
  }

  // Replace the interface
  const beforeInterface = toolFileContent.substring(0, interfaceStart);
  const afterInterface = toolFileContent.substring(interfaceEnd);
  const newContent = beforeInterface + interfaceCode + afterInterface;

  fs.writeFileSync(toolFilePath, newContent, 'utf-8');
  console.log(`   ✅ Updated interface in ${mapping.toolFile}`);
  console.log();
}

console.log('✨ Done!\n');

if (!DRY_RUN) {
  console.log('💡 Next steps:');
  console.log('   1. Review the generated interfaces');
  console.log('   2. Run: npm run build');
  console.log('   3. Run: npm test');
  console.log('   4. Commit the changes\n');
}

