/**
 * Code generation for progressive disclosure via code execution.
 * Generates TypeScript wrapper files that Claude can discover and import.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubernetesToolMetadata } from '../tools/kubernetes/metadata.js';

interface ToolWrapper {
  name: string;
  description: string;
  functionName: string;
  pascalName: string;
  modulePath: string;
  exportName: string;
}

export async function generateToolWrappers(outputDir: string): Promise<void> {
  // Create output directory structure
  const serversDir = path.join(outputDir, 'servers');
  const kubernetesDir = path.join(serversDir, 'kubernetes');
  await fs.mkdir(kubernetesDir, { recursive: true });

  // Note: client.ts is manually maintained in generated/servers/client.ts
  // It provides the callMCPTool function that communicates with the MCP server

  // Generate wrapper for each tool metadata entry
  const wrappers: ToolWrapper[] = [];
  
  for (const entry of kubernetesToolMetadata) {
    const tool = entry.tool;
    const functionName = tool.name.replace('kubernetes.', '');
    const pascalName = toPascalCase(functionName);
    
    const wrapperMeta = {
      name: tool.name,
      description: tool.description,
      functionName,
      pascalName,
      modulePath: entry.sourceModulePath,
      exportName: entry.exportName,
    };
    wrappers.push(wrapperMeta);

    await generateToolWrapper(
      kubernetesDir,
      tool.name,
      tool.description,
      functionName,
      pascalName,
      entry.sourceModulePath,
      entry.exportName,
    );
  }

  // Generate index file that exports all tools
  await generateIndexFile(kubernetesDir, wrappers);

  // Generate README
  await generateReadme(outputDir, wrappers);

  console.error(`✅ Generated ${wrappers.length} tool wrappers in ${outputDir}`);
}

// client.ts is manually maintained - no longer generated

async function generateToolWrapper(
  dir: string,
  toolName: string,
  description: string,
  functionName: string,
  pascalName: string,
  modulePath: string,
  exportName: string,
): Promise<void> {
  const toolsDir = path.dirname(fileURLToPath(new URL('../tools/kubernetes/metadata.ts', import.meta.url)));
  const moduleAbsolutePath = path.resolve(toolsDir, modulePath);
  const relativeImportPath = normalizeImportPath(path.relative(dir, moduleAbsolutePath));
  const inputType = `${pascalName}Input`;
  const resultType = `${pascalName}Result`;
  
  const wrapperCode = `import { ${exportName} } from '${relativeImportPath}';
import type { ${inputType}, ${resultType} } from '${relativeImportPath}';

/**
 * ${description}
 * 
 * All Kubernetes complexity (authentication, API clients, etc.) is handled
 * by the backend modules. Just provide the input parameters.
 */
export async function ${functionName}(input: ${inputType}): Promise<${resultType}> {
  return ${exportName}.execute(input);
}
`;

  await fs.writeFile(path.join(dir, `${functionName}.ts`), wrapperCode);
}

async function generateIndexFile(dir: string, wrappers: ToolWrapper[]): Promise<void> {
  const exports = wrappers
    .map((w) => `export { ${w.functionName} } from './${w.functionName}.js';`)
    .join('\n');
  
  const indexCode = `/**
 * Kubernetes MCP Server Tools
 * 
 * Import and use these functions in your code to interact with Kubernetes.
 * All operations return structured data from the cluster.
 */

${exports}
`;

  await fs.writeFile(path.join(dir, 'index.ts'), indexCode);
}

async function generateReadme(outputDir: string, wrappers: ToolWrapper[]): Promise<void> {
  const toolList = wrappers
    .map((w) => `- **${w.functionName}**: ${w.description}`)
    .join('\n');
  
  const readmeContent = `# Kubernetes MCP Server - Code Execution Mode

This directory contains generated TypeScript wrappers for Kubernetes operations.

## Usage

\`\`\`typescript
import * as k8s from './servers/kubernetes';

// List all pods
const pods = await k8s.listPods({ namespace: 'default' });
console.log(\`Found \${pods.totalItems} pods\`);

// Get specific pod details
const pod = await k8s.getPod({ 
  namespace: 'default', 
  name: 'nginx-abc123' 
});
console.log(\`Pod status: \${pod.summary.phase}\`);

// Get logs
const logs = await k8s.getPodLogs({
  namespace: 'default',
  podName: 'nginx-abc123',
  tailLines: 100
});
console.log(logs.logs);
\`\`\`

## Available Operations

${toolList}

## Progressive Disclosure

Discover tools by exploring the filesystem:
1. List \`./servers/\` to see available servers
2. List \`./servers/kubernetes/\` to see operations
3. Read the tool file you need to see its interface
4. Import and use it in your code
`;

  await fs.writeFile(path.join(outputDir, 'README.md'), readmeContent);
}

function normalizeImportPath(relativePath: string): string {
  const posixPath = relativePath.split(path.sep).join('/');
  if (posixPath.startsWith('.')) {
    return posixPath;
  }
  return `./${posixPath}`;
}

function toPascalCase(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

