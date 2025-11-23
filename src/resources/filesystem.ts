/**
 * Expose the generated TypeScript files as MCP resources
 * so Claude can discover and read them
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface FileResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export const PUBLIC_GENERATED_ROOT_PATH = '/dist/tools/kubernetes';
export const PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH = PUBLIC_GENERATED_ROOT_PATH.endsWith('/')
  ? PUBLIC_GENERATED_ROOT_PATH
  : `${PUBLIC_GENERATED_ROOT_PATH}/`;

export async function listGeneratedFiles(generatedDir: string): Promise<FileResource[]> {
  const resources: FileResource[] = [];
  
  try {
    await walkDirectory(generatedDir, generatedDir, resources);
  } catch (error) {
    console.error('Error listing generated files:', error);
  }
  
  return resources;
}

async function walkDirectory(baseDir: string, currentDir: string, resources: FileResource[]): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    
    if (entry.isDirectory()) {
      await walkDirectory(baseDir, fullPath, resources);
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      const posixRelativePath = toPosixPath(relativePath);
      const publicPath = path.posix.join(
        PUBLIC_GENERATED_ROOT_PATH_WITH_SLASH,
        posixRelativePath,
      );

      resources.push({
        uri: `file://${encodeURI(publicPath)}`,
        name: posixRelativePath,
        description: `TypeScript declaration file: ${posixRelativePath}`,
        mimeType: 'text/typescript',
      });
    }
  }
}

export async function readGeneratedFile(generatedDir: string, relativePath: string): Promise<string> {
  const fullPath = path.join(generatedDir, relativePath);
  
  // Security: ensure the path is within generatedDir
  const resolvedPath = path.resolve(fullPath);
  const resolvedBase = path.resolve(generatedDir);
  
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error('Access denied: path outside generated directory');
  }
  
  return await fs.readFile(fullPath, 'utf-8');
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

