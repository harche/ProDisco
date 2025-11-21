/**
 * Code generation for progressive disclosure via code execution.
 * Generates TypeScript wrapper files that Claude can discover and import.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import { kubernetesTools } from '../tools/kubernetes/index.js';

interface ToolWrapper {
  name: string;
  description: string;
  inputSchema: unknown;
  functionName: string;
}

export async function generateToolWrappers(outputDir: string): Promise<void> {
  // Create output directory structure
  const serversDir = path.join(outputDir, 'servers');
  const kubernetesDir = path.join(serversDir, 'kubernetes');
  await fs.mkdir(kubernetesDir, { recursive: true });

  // Note: client.ts is manually maintained in generated/servers/client.ts
  // It provides the callMCPTool function that communicates with the MCP server

  // Generate wrapper for each tool
  const wrappers: ToolWrapper[] = [];
  
  for (const tool of kubernetesTools) {
    // Skip searchTools - not needed in code execution mode
    if (tool.name === 'kubernetes.searchTools') continue;

    const functionName = tool.name.replace('kubernetes.', '');
    const schema = zodToJsonSchema(tool.schema as ZodTypeAny);
    
    wrappers.push({
      name: tool.name,
      description: tool.description,
      inputSchema: schema,
      functionName,
    });

    await generateToolWrapper(kubernetesDir, tool.name, tool.description, functionName, schema);
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
  schema: unknown,
): Promise<void> {
  // Generate TypeScript interface from JSON Schema
  const inputInterface = generateInterfaceFromSchema(functionName, schema);
  
  const wrapperCode = `import { callMCPTool } from '../client.js';

${inputInterface}

/**
 * ${description}
 * 
 * All Kubernetes complexity (authentication, API clients, etc.) is handled
 * by the MCP server. Just provide the input parameters.
 */
export async function ${functionName}(input: ${functionName}Input): Promise<any> {
  return callMCPTool('${toolName}', input);
}
`;

  await fs.writeFile(path.join(dir, `${functionName}.ts`), wrapperCode);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateInterfaceFromSchema(functionName: string, schema: any): string {
  const properties = schema.properties || {};
  const required = schema.required || [];
  
  const fields: string[] = [];
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [propName, propSchema] of Object.entries<any>(properties)) {
    const isRequired = required.includes(propName);
    const propType = mapJsonSchemaTypeToTS(propSchema);
    const optional = isRequired ? '' : '?';
    
    // Add JSDoc comment if description exists
    if (propSchema.description) {
      fields.push(`  /** ${propSchema.description} */`);
    }
    
    fields.push(`  ${propName}${optional}: ${propType};`);
  }
  
  return `export interface ${functionName}Input {\n${fields.join('\n')}\n}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapJsonSchemaTypeToTS(schema: any): string {
  if (schema.type === 'string') {
    if (schema.enum) {
      return schema.enum.map((v: string) => `'${v}'`).join(' | ');
    }
    return 'string';
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return 'number';
  }
  if (schema.type === 'boolean') {
    return 'boolean';
  }
  if (schema.type === 'array') {
    const items = schema.items ? mapJsonSchemaTypeToTS(schema.items) : 'any';
    return `${items}[]`;
  }
  if (schema.type === 'object') {
    if (schema.additionalProperties) {
      return 'Record<string, any>';
    }
    return 'object';
  }
  if (schema.anyOf || schema.oneOf) {
    const schemas = schema.anyOf || schema.oneOf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return schemas.map((s: any) => mapJsonSchemaTypeToTS(s)).join(' | ');
  }
  return 'any';
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

