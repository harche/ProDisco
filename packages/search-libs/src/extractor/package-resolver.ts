/**
 * Resolve npm packages and find their .d.ts files
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname, isAbsolute } from 'path';
import * as ts from 'typescript';
import type { PackageInfo } from './types.js';

/**
 * Resolve a package and find all its .d.ts files
 * @param packageName - Name of the package to resolve
 * @param basePath - Base path(s) to search for node_modules. Can be a single path or array of paths.
 */
export function resolvePackage(
  packageName: string,
  basePath: string | string[] = process.cwd()
): PackageInfo | null {
  const basePaths = Array.isArray(basePath) ? basePath : [basePath];

  // Try each base path until we find the package
  for (const base of basePaths) {
    const nodeModulesPath = join(base, 'node_modules');

    // Handle scoped packages (e.g., @kubernetes/client-node)
    const packagePath = packageName.startsWith('@')
      ? join(nodeModulesPath, ...packageName.split('/'))
      : join(nodeModulesPath, packageName);

    if (!existsSync(packagePath)) {
      continue;
    }

    const packageJsonPath = join(packagePath, 'package.json');
    const packageJson = getPackageJson(packageJsonPath);

    if (!packageJson) {
      continue;
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

  return null;
}

/**
 * Find the main ESM JavaScript entry file for a package.
 *
 * This is intended as a fallback for packages that ship no `.d.ts` files.
 * Scope: ESM only (`.js` with `"type":"module"` or `.mjs`). CommonJS (`.cjs`)
 * is intentionally out of scope.
 */
export function findMainEsmJs(
  packagePath: string,
  packageJson: Record<string, unknown>
): string | undefined {
  const pkgType = typeof packageJson.type === 'string' ? packageJson.type : undefined;
  const isTypeModule = pkgType === 'module';

  // 1) Prefer conditional exports root entry: exports["."] (import -> default)
  const exportsField = packageJson.exports as unknown;
  const rootExport =
    exportsField && typeof exportsField === 'object'
      ? (exportsField as Record<string, unknown>)['.'] ?? exportsField
      : exportsField;

  const exportCandidate =
    pickConditionalExportPath(rootExport, { prefer: ['import', 'default'] }) ??
    // Some packages put the path directly at exports["."] as a string
    (typeof rootExport === 'string' ? rootExport : undefined);

  if (exportCandidate) {
    const resolved = resolvePackageEsmFile(packagePath, exportCandidate, {
      allowJsExtension: true,
      allowMjsExtension: true,
      // Any path coming from `exports` for ESM import/default is treated as ESM-capable.
      requireTypeModuleForJs: false,
      isTypeModule,
    });
    if (resolved) return resolved;
  }

  // 2) Try "module" field (commonly ESM build)
  const moduleField = packageJson.module as string | undefined;
  if (typeof moduleField === 'string') {
    const resolved = resolvePackageEsmFile(packagePath, moduleField, {
      allowJsExtension: true,
      allowMjsExtension: true,
      requireTypeModuleForJs: false,
      isTypeModule,
    });
    if (resolved) return resolved;
  }

  // 3) Try "main" field (only if it looks like ESM)
  const mainField = packageJson.main as string | undefined;
  if (typeof mainField === 'string') {
    const resolved = resolvePackageEsmFile(packagePath, mainField, {
      allowJsExtension: true,
      allowMjsExtension: true,
      // If `main` points at `.js`, only treat it as ESM when package.json is type:module.
      requireTypeModuleForJs: true,
      isTypeModule,
    });
    if (resolved) return resolved;
  }

  // 4) Common patterns
  const patterns = [
    'dist/index.js',
    'dist/index.mjs',
    'lib/index.js',
    'lib/index.mjs',
    'index.js',
    'index.mjs',
  ];

  for (const pattern of patterns) {
    const resolved = resolvePackageEsmFile(packagePath, pattern, {
      allowJsExtension: true,
      allowMjsExtension: true,
      requireTypeModuleForJs: true,
      isTypeModule,
    });
    if (resolved) return resolved;
  }

  return undefined;
}

interface ResolveEsmFileOptions {
  allowJsExtension: boolean;
  allowMjsExtension: boolean;
  requireTypeModuleForJs: boolean;
  isTypeModule: boolean;
}

function resolvePackageEsmFile(
  packagePath: string,
  packageRelativePath: string,
  options: ResolveEsmFileOptions
): string | undefined {
  // Disallow absolute paths in package.json to avoid escaping the package folder.
  if (isAbsolute(packageRelativePath)) return undefined;

  // Normalize leading "./"
  const rel = packageRelativePath.startsWith('./')
    ? packageRelativePath.slice(2)
    : packageRelativePath;

  const base = join(packagePath, rel);

  // Direct file match
  const direct = resolveEsmFileCandidate(base, options);
  if (direct) return direct;

  // If extensionless, try common ESM extensions + index files
  if (!extname(base)) {
    const extCandidates: string[] = [];
    if (options.allowJsExtension) extCandidates.push(`${base}.js`);
    if (options.allowMjsExtension) extCandidates.push(`${base}.mjs`);

    for (const c of extCandidates) {
      const resolved = resolveEsmFileCandidate(c, options);
      if (resolved) return resolved;
    }

    const indexCandidates: string[] = [];
    if (options.allowJsExtension) indexCandidates.push(join(base, 'index.js'));
    if (options.allowMjsExtension) indexCandidates.push(join(base, 'index.mjs'));

    for (const c of indexCandidates) {
      const resolved = resolveEsmFileCandidate(c, options);
      if (resolved) return resolved;
    }
  }

  return undefined;
}

function resolveEsmFileCandidate(
  filePath: string,
  options: ResolveEsmFileOptions
): string | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  const ext = extname(filePath).toLowerCase();
  if (ext === '.cjs') return undefined;

  if (ext === '.mjs') return filePath;

  if (ext === '.js') {
    if (options.requireTypeModuleForJs && !options.isTypeModule) {
      return undefined;
    }
    return filePath;
  }

  // Unsupported extension for JS fallback
  return undefined;
}

function pickConditionalExportPath(
  value: unknown,
  options: { prefer: string[] }
): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return undefined;

  const obj = value as Record<string, unknown>;

  // Prefer known condition keys first.
  for (const key of options.prefer) {
    const v = obj[key];
    if (key === 'types') continue;
    if (typeof v === 'string') return v;
    const nested = pickConditionalExportPath(v, options);
    if (nested) return nested;
  }

  // As a fallback, search any nested condition (but skip require/types).
  for (const [key, v] of Object.entries(obj)) {
    if (key === 'types' || key === 'require') continue;
    if (typeof v === 'string') return v;
    const nested = pickConditionalExportPath(v, options);
    if (nested) return nested;
  }

  return undefined;
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
 * Result of computing the public export surface of an ESM JavaScript package entry.
 *
 * - `filesToParse`: entry + all statically referenced re-export targets (relative only)
 * - `exportAllowlistByFile`: per-file set of declaration names that are part of the public API
 * - `aliasMapByFile`: per-file map from declaration name -> public export name (when renamed)
 */
export interface ESMExportSurface {
  entryFile: string;
  filesToParse: string[];
  exportAllowlistByFile: Map<string, Set<string>>;
  aliasMapByFile: Map<string, Map<string, string>>;
  /** Names users can import from the package entry (public surface) */
  publicExports: Set<string>;
}

interface ResolvedExportTarget {
  originFile: string;
  originName: string;
}

/**
 * Build the public export surface for an ESM entry file.
 *
 * This follows only *relative* static re-exports (`./...`). Re-exports from
 * dependencies are intentionally ignored.
 */
export function buildEsmExportSurface(entryFile: string): ESMExportSurface {
  const visitedFiles = new Set<string>();
  const exportCache = new Map<string, Map<string, ResolvedExportTarget>>();
  const inProgress = new Set<string>();

  function resolveModuleExports(filePath: string): Map<string, ResolvedExportTarget> {
    if (exportCache.has(filePath)) {
      return exportCache.get(filePath)!;
    }

    if (inProgress.has(filePath)) {
      // Cycle detected; treat as empty to avoid infinite recursion.
      return new Map();
    }

    inProgress.add(filePath);
    visitedFiles.add(filePath);

    const exports = new Map<string, ResolvedExportTarget>();

    if (!existsSync(filePath)) {
      exportCache.set(filePath, exports);
      inProgress.delete(filePath);
      return exports;
    }

    let sourceCode = '';
    try {
      sourceCode = readFileSync(filePath, 'utf-8');
    } catch {
      exportCache.set(filePath, exports);
      inProgress.delete(filePath);
      return exports;
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    // Track relative imports so we can resolve "import { foo } from './x.js'; export { foo }"
    const importMap = new Map<
      string,
      { sourceFile: string; importedName: string }
    >();

    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;

      const moduleSpec = stmt.moduleSpecifier.text;
      const resolved = resolveRelativeEsmModule(filePath, moduleSpec);
      if (!resolved) continue;

      const clause = stmt.importClause;
      if (!clause) continue;

      // Default import: import foo from './x.js'
      if (clause.name) {
        importMap.set(clause.name.text, {
          sourceFile: resolved,
          importedName: 'default',
        });
      }

      const named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const localName = el.name.text;
          const importedName = el.propertyName?.text ?? el.name.text;
          importMap.set(localName, { sourceFile: resolved, importedName });
        }
      }
    }

    function addExport(exportName: string, target: ResolvedExportTarget) {
      exports.set(exportName, target);
    }

    for (const stmt of sourceFile.statements) {
      // export { ... } [from '...']
      if (ts.isExportDeclaration(stmt)) {
        const moduleSpec =
          stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
            ? stmt.moduleSpecifier.text
            : undefined;

        if (moduleSpec && moduleSpec.startsWith('.')) {
          const resolved = resolveRelativeEsmModule(filePath, moduleSpec);
          if (!resolved) continue;

          const targetExports = resolveModuleExports(resolved);

          // export { a, b as c } from './x.js'
          if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
            for (const el of stmt.exportClause.elements) {
              const exportedName = el.name.text;
              const requestedName = el.propertyName?.text ?? el.name.text;
              const target = targetExports.get(requestedName);
              if (target) {
                addExport(exportedName, target);
              }
            }
          }

          // export * from './x.js'
          if (!stmt.exportClause) {
            for (const [name, target] of targetExports) {
              // export * does not re-export default
              if (name === 'default') continue;
              if (!exports.has(name)) {
                addExport(name, target);
              }
            }
          }

          continue;
        }

        // export { a, b as c } (local or imported bindings)
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const exportedName = el.name.text;
            const localName = el.propertyName?.text ?? el.name.text;

            const imported = importMap.get(localName);
            if (imported && imported.importedName !== '*') {
              const targetExports = resolveModuleExports(imported.sourceFile);
              const target = targetExports.get(imported.importedName);
              if (target) {
                addExport(exportedName, target);
              }
              continue;
            }

            addExport(exportedName, { originFile: filePath, originName: localName });
          }
        }
      }

      // export default <expr>;
      if (ts.isExportAssignment(stmt)) {
        if (stmt.isExportEquals) continue;
        if (ts.isIdentifier(stmt.expression)) {
          const localName = stmt.expression.text;
          const imported = importMap.get(localName);
          if (imported && imported.importedName !== '*') {
            const targetExports = resolveModuleExports(imported.sourceFile);
            const target = targetExports.get(imported.importedName);
            if (target) {
              addExport('default', target);
            }
          } else {
            addExport('default', { originFile: filePath, originName: localName });
          }
        }
      }

      // export function foo() {} / export default function foo() {}
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!isExported) continue;
        const isDefault = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (isDefault) {
          addExport('default', { originFile: filePath, originName: stmt.name.text });
        } else {
          addExport(stmt.name.text, { originFile: filePath, originName: stmt.name.text });
        }
      }

      // export class Foo {} / export default class Foo {}
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!isExported) continue;
        const isDefault = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (isDefault) {
          addExport('default', { originFile: filePath, originName: stmt.name.text });
        } else {
          addExport(stmt.name.text, { originFile: filePath, originName: stmt.name.text });
        }
      }

      // export const foo = ...
      if (ts.isVariableStatement(stmt)) {
        const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!isExported) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            addExport(decl.name.text, { originFile: filePath, originName: decl.name.text });
          }
        }
      }
    }

    exportCache.set(filePath, exports);
    inProgress.delete(filePath);
    return exports;
  }

  const entryExports = resolveModuleExports(entryFile);

  const exportAllowlistByFile = new Map<string, Set<string>>();
  const aliasMapByFile = new Map<string, Map<string, string>>();
  const publicExports = new Set<string>();

  for (const [publicName, target] of entryExports) {
    publicExports.add(publicName);

    const { originFile, originName } = target;
    let allow = exportAllowlistByFile.get(originFile);
    if (!allow) {
      allow = new Set<string>();
      exportAllowlistByFile.set(originFile, allow);
    }
    allow.add(originName);

    if (originName !== publicName) {
      let aliases = aliasMapByFile.get(originFile);
      if (!aliases) {
        aliases = new Map<string, string>();
        aliasMapByFile.set(originFile, aliases);
      }
      aliases.set(originName, publicName);
    }
  }

  return {
    entryFile,
    filesToParse: Array.from(visitedFiles),
    exportAllowlistByFile,
    aliasMapByFile,
    publicExports,
  };
}

function resolveRelativeEsmModule(fromFilePath: string, moduleSpec: string): string | null {
  if (!moduleSpec.startsWith('.')) return null;

  const base = join(dirname(fromFilePath), moduleSpec);

  // Direct path
  const direct = resolveRelativeEsmCandidate(base);
  if (direct) return direct;

  // Extensionless: try .js/.mjs and index files
  if (!extname(base)) {
    const js = resolveRelativeEsmCandidate(`${base}.js`);
    if (js) return js;
    const mjs = resolveRelativeEsmCandidate(`${base}.mjs`);
    if (mjs) return mjs;

    const idxJs = resolveRelativeEsmCandidate(join(base, 'index.js'));
    if (idxJs) return idxJs;
    const idxMjs = resolveRelativeEsmCandidate(join(base, 'index.mjs'));
    if (idxMjs) return idxMjs;
  } else {
    // If spec points to .js but only .mjs exists (or vice versa), try swapping.
    const ext = extname(base).toLowerCase();
    if (ext === '.js') {
      const swap = resolveRelativeEsmCandidate(base.replace(/\.js$/i, '.mjs'));
      if (swap) return swap;
    }
    if (ext === '.mjs') {
      const swap = resolveRelativeEsmCandidate(base.replace(/\.mjs$/i, '.js'));
      if (swap) return swap;
    }
  }

  return null;
}

function resolveRelativeEsmCandidate(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const ext = extname(filePath).toLowerCase();
  if (ext !== '.js' && ext !== '.mjs') return null;
  return filePath;
}

/**
 * @deprecated Use buildExportInfo instead
 */
export function buildExportAliasMap(mainDtsPath: string): Map<string, string> {
  return buildExportInfo(mainDtsPath).aliasMap;
}
