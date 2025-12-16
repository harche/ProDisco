/**
 * Resolve npm packages and find their .d.ts files
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import * as ts from 'typescript';
import type { PackageInfo } from './types.js';

/**
 * Resolve a package and find all its .d.ts files
 */
export function resolvePackage(
  packageName: string,
  basePath: string = process.cwd()
): PackageInfo | null {
  const nodeModulesPath = join(basePath, 'node_modules');

  // Handle scoped packages (e.g., @kubernetes/client-node)
  const packagePath = packageName.startsWith('@')
    ? join(nodeModulesPath, ...packageName.split('/'))
    : join(nodeModulesPath, packageName);

  if (!existsSync(packagePath)) {
    return null;
  }

  const packageJsonPath = join(packagePath, 'package.json');
  const packageJson = getPackageJson(packageJsonPath);

  if (!packageJson) {
    return null;
  }

  // Find main .d.ts file
  const mainDts = findMainDts(packagePath, packageJson);

  // Find types directory
  const typesDir = findTypesDir(packagePath, packageJson);

  // Find all .d.ts files
  let allDtsFiles = findDtsFiles(packagePath, typesDir);

  // Ensure mainDts is included in allDtsFiles if it exists
  if (mainDts && !allDtsFiles.includes(mainDts)) {
    allDtsFiles = [mainDts, ...allDtsFiles];
  }

  // Build export info from main .d.ts (alias map + public exports)
  let exportAliases: Map<string, string> | undefined;
  let publicExports: Set<string> | undefined;

  if (mainDts) {
    const exportInfo = buildExportInfo(mainDts);
    exportAliases = exportInfo.aliasMap;
    publicExports = exportInfo.publicExports;
  }

  return {
    packageName,
    packagePath,
    mainDts,
    typesDir,
    allDtsFiles,
    exportAliases,
    publicExports,
  };
}

/**
 * Read and parse package.json
 */
export function getPackageJson(
  packageJsonPath: string
): Record<string, unknown> | null {
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const content = readFileSync(packageJsonPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Find the main .d.ts file for a package
 */
function findMainDts(
  packagePath: string,
  packageJson: Record<string, unknown>
): string | undefined {
  // Check "types" or "typings" field
  const typesField = (packageJson.types || packageJson.typings) as
    | string
    | undefined;
  if (typesField) {
    const typesPath = join(packagePath, typesField);
    if (existsSync(typesPath)) {
      return typesPath;
    }
  }

  // Check "exports" field for types
  const exports = packageJson.exports as Record<string, unknown> | undefined;
  if (exports && typeof exports === 'object') {
    // Check root export
    const rootExport = exports['.'] as Record<string, unknown> | undefined;
    if (rootExport && typeof rootExport === 'object') {
      const typesPath = rootExport.types as string | undefined;
      if (typesPath) {
        const fullPath = join(packagePath, typesPath);
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
  }

  // Try common patterns
  const patterns = [
    'dist/index.d.ts',
    'lib/index.d.ts',
    'index.d.ts',
    'types/index.d.ts',
  ];

  for (const pattern of patterns) {
    const fullPath = join(packagePath, pattern);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return undefined;
}

/**
 * Find the types directory for a package
 */
function findTypesDir(
  packagePath: string,
  packageJson: Record<string, unknown>
): string | undefined {
  // Check if there's a types directory
  const patterns = ['types', 'typings', 'dist', 'lib'];

  for (const pattern of patterns) {
    const dirPath = join(packagePath, pattern);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      // Check if it contains .d.ts files
      const files = readdirSync(dirPath);
      if (files.some((f) => f.endsWith('.d.ts'))) {
        return dirPath;
      }
    }
  }

  // For K8s client, check dist/gen
  const k8sGenPath = join(packagePath, 'dist', 'gen');
  if (existsSync(k8sGenPath)) {
    return k8sGenPath;
  }

  return undefined;
}

/**
 * Find all .d.ts files in a package
 */
export function findDtsFiles(
  packagePath: string,
  typesDir?: string,
  maxDepth: number = 5
): string[] {
  const files: string[] = [];
  const visited = new Set<string>();

  function walkDir(dir: string, depth: number) {
    if (depth > maxDepth || visited.has(dir)) {
      return;
    }
    visited.add(dir);

    if (!existsSync(dir)) {
      return;
    }

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        // Skip node_modules and hidden directories
        if (entry === 'node_modules' || entry.startsWith('.')) {
          continue;
        }

        const fullPath = join(dir, entry);

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            walkDir(fullPath, depth + 1);
          } else if (entry.endsWith('.d.ts')) {
            // Skip test files and internal files
            if (
              !entry.includes('.test.') &&
              !entry.includes('.spec.') &&
              !entry.includes('__')
            ) {
              files.push(fullPath);
            }
          }
        } catch {
          // Skip files we can't access
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  // Start from types directory if available, otherwise from package root
  if (typesDir) {
    walkDir(typesDir, 0);
  }

  // Also check dist directory if not already covered
  const distPath = join(packagePath, 'dist');
  if (!typesDir?.startsWith(distPath) && existsSync(distPath)) {
    walkDir(distPath, 0);
  }

  // Check lib directory
  const libPath = join(packagePath, 'lib');
  if (!typesDir?.startsWith(libPath) && existsSync(libPath)) {
    walkDir(libPath, 0);
  }

  // Check src directory (some packages like simple-statistics store .d.ts files here)
  const srcPath = join(packagePath, 'src');
  if (!typesDir?.startsWith(srcPath) && existsSync(srcPath)) {
    walkDir(srcPath, 0);
  }

  return files;
}

/**
 * Get all exportable types from a package's main entry point
 */
export function getPackageExports(
  packagePath: string,
  packageJson: Record<string, unknown>
): string[] {
  const exports: string[] = [];

  // Check "exports" field
  const exportsField = packageJson.exports as Record<string, unknown> | undefined;
  if (exportsField && typeof exportsField === 'object') {
    for (const key of Object.keys(exportsField)) {
      if (key !== '.' && !key.startsWith('./')) {
        continue;
      }
      exports.push(key === '.' ? 'default' : key.slice(2));
    }
  }

  return exports;
}

/**
 * Result of parsing exports from a package entry point
 */
export interface ExportParseResult {
  /** Map of internal class names to their exported aliases (e.g., ObjectCoreV1Api -> CoreV1Api) */
  aliasMap: Map<string, string>;
  /** Set of all publicly exported names (the names users see and use) */
  publicExports: Set<string>;
}

/**
 * Parse exports from a package's entry point to determine:
 * 1. Which names are publicly exported (visible to users)
 * 2. Which internal names map to which public aliases
 *
 * Parses export statements like:
 *   export { ObjectCoreV1Api as CoreV1Api } from './gen/api/coreV1Api';
 *   export { SomeClass } from './module';  // No alias, SomeClass is public
 *   export class PublicClass { }  // Directly exported class
 *
 * Recursively follows `export * from './module'` re-exports.
 */
export function buildExportInfo(mainDtsPath: string): ExportParseResult {
  const aliasMap = new Map<string, string>();
  const publicExports = new Set<string>();
  const visitedFiles = new Set<string>();

  function processFile(filePath: string) {
    // Avoid infinite loops
    if (visitedFiles.has(filePath)) {
      return;
    }
    visitedFiles.add(filePath);

    if (!existsSync(filePath)) {
      return;
    }

    try {
      const sourceCode = readFileSync(filePath, 'utf-8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceCode,
        ts.ScriptTarget.Latest,
        true
      );

      const fileDir = dirname(filePath);

      // Walk through all statements looking for export declarations
      function visit(node: ts.Node) {
        // Handle: export { InternalName as PublicName } from '...';
        // Handle: export { Name } from '...';  (no alias)
        if (ts.isExportDeclaration(node)) {
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) {
              const exportedName = element.name.text;

              if (element.propertyName) {
                // Aliased export: export { Internal as Public }
                const internalName = element.propertyName.text;
                aliasMap.set(internalName, exportedName);
                publicExports.add(exportedName);
              } else {
                // Direct export: export { Name }
                publicExports.add(exportedName);
              }
            }
          }

          // Handle: export * from './module';
          // Recursively follow re-exports
          if (!node.exportClause && node.moduleSpecifier) {
            const moduleSpec = (node.moduleSpecifier as ts.StringLiteral).text;
            if (moduleSpec.startsWith('.')) {
              // Resolve relative path
              let resolvedPath = join(fileDir, moduleSpec);

              // Try with .d.ts extension
              if (!resolvedPath.endsWith('.d.ts')) {
                if (resolvedPath.endsWith('.js')) {
                  resolvedPath = resolvedPath.replace(/\.js$/, '.d.ts');
                } else {
                  resolvedPath = resolvedPath + '.d.ts';
                }
              }

              // Also try index.d.ts if file doesn't exist
              if (!existsSync(resolvedPath)) {
                const indexPath = join(fileDir, moduleSpec, 'index.d.ts');
                if (existsSync(indexPath)) {
                  resolvedPath = indexPath;
                }
              }

              processFile(resolvedPath);
            }
          }
        }

        // Handle: export class ClassName { }
        if (ts.isClassDeclaration(node) && node.name) {
          const hasExportModifier = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword
          );
          if (hasExportModifier) {
            publicExports.add(node.name.text);
          }
        }

        // Handle: export interface InterfaceName { }
        if (ts.isInterfaceDeclaration(node) && node.name) {
          const hasExportModifier = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword
          );
          if (hasExportModifier) {
            publicExports.add(node.name.text);
          }
        }

        // Handle: export function functionName() { }
        if (ts.isFunctionDeclaration(node) && node.name) {
          const hasExportModifier = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword
          );
          if (hasExportModifier) {
            publicExports.add(node.name.text);
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    } catch {
      // Silently ignore parsing errors
    }
  }

  processFile(mainDtsPath);
  return { aliasMap, publicExports };
}

/**
 * @deprecated Use buildExportInfo instead
 */
export function buildExportAliasMap(mainDtsPath: string): Map<string, string> {
  return buildExportInfo(mainDtsPath).aliasMap;
}
