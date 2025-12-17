/**
 * Extractor module - Extract types, methods, and functions from TypeScript packages
 */

import { join } from 'path';
import type {
  ExtractionOptions,
  ExtractionResult,
  ExtractionError,
  ExtractedType,
  ExtractedMethod,
  ExtractedFunction,
} from './types.js';
import {
  resolvePackage,
  findDtsFiles,
  getPackageJson,
  findMainEsmJs,
  buildEsmExportSurface,
} from './package-resolver.js';
import { extractTypesFromFile } from './type-extractor.js';
import { extractMethodsFromFile } from './method-extractor.js';
import { extractFunctionsFromFile } from './function-extractor.js';

// Re-export types
export * from './types.js';

// Re-export utilities
export { resolvePackage, findDtsFiles } from './package-resolver.js';
export { extractTypesFromFile } from './type-extractor.js';
export { extractMethodsFromFile } from './method-extractor.js';
export { extractFunctionsFromFile } from './function-extractor.js';
export * from './ast-parser.js';

/**
 * Extract types, methods, and functions from an npm package
 */
export function extractFromPackage(options: ExtractionOptions): ExtractionResult {
  const {
    packageName,
    dtsFiles: providedDtsFiles,
    typeFilter,
    methodFilter,
    classFilter,
    basePath = process.cwd(),
  } = options;

  const types: ExtractedType[] = [];
  const methods: ExtractedMethod[] = [];
  const functions: ExtractedFunction[] = [];
  const errors: ExtractionError[] = [];

  // Resolve package if no files provided
  let dtsFiles = providedDtsFiles;
  let exportAliases: Map<string, string> | undefined;
  let publicExports: Set<string> | undefined;
  let jsSurface:
    | ReturnType<typeof buildEsmExportSurface>
    | undefined;

  if (!dtsFiles || dtsFiles.length === 0) {
    const packageInfo = resolvePackage(packageName, basePath);

    if (!packageInfo) {
      errors.push({
        file: packageName,
        message: `Could not resolve package: ${packageName}`,
      });
      return { packageName, types, methods, functions, errors };
    }

    dtsFiles = packageInfo.allDtsFiles;
    exportAliases = packageInfo.exportAliases;
    publicExports = packageInfo.publicExports;

    // JS fallback: if no .d.ts files exist, attempt to index from ESM JavaScript source.
    if (dtsFiles.length === 0) {
      const packageJsonPath = join(packageInfo.packagePath, 'package.json');
      const packageJson = getPackageJson(packageJsonPath);

      if (!packageJson) {
        errors.push({
          file: packageName,
          message: `No .d.ts files found and could not read package.json for package: ${packageName}`,
        });
        return { packageName, types, methods, functions, errors };
      }

      const entryFile = findMainEsmJs(packageInfo.packagePath, packageJson);
      if (!entryFile) {
        errors.push({
          file: packageName,
          message: `No .d.ts files found and no ESM JavaScript entrypoint found for package: ${packageName}`,
        });
        return { packageName, types, methods, functions, errors };
      }

      jsSurface = buildEsmExportSurface(entryFile);
      if (jsSurface.publicExports.size === 0) {
        errors.push({
          file: packageName,
          message: `No .d.ts files found and no ESM exports discovered for package: ${packageName}`,
        });
        return { packageName, types, methods, functions, errors };
      }
    }
  }

  // Create filter functions
  const typeFilterFn =
    typeof typeFilter === 'function'
      ? typeFilter
      : typeFilter instanceof RegExp
        ? (name: string) => typeFilter.test(name)
        : undefined;

  const methodFilterFn =
    typeof methodFilter === 'function'
      ? methodFilter
      : methodFilter instanceof RegExp
        ? (name: string) => methodFilter.test(name)
        : undefined;

  const classFilterFn =
    typeof classFilter === 'function'
      ? classFilter
      : classFilter instanceof RegExp
        ? (name: string) => classFilter.test(name)
        : undefined;

  // === JS fallback extraction (ESM-only) ===
  if (jsSurface) {
    for (const filePath of jsSurface.filesToParse) {
      const allowlist = jsSurface.exportAllowlistByFile.get(filePath);
      if (!allowlist || allowlist.size === 0) {
        continue;
      }
      const aliases = jsSurface.aliasMapByFile.get(filePath);

      try {
        // Extract types (classes) and filter to public surface
        const fileTypes = extractTypesFromFile(filePath, packageName, {
          allowlist,
          aliases,
        });
        const filteredTypes = typeFilterFn
          ? fileTypes.filter((t) => typeFilterFn(t.name))
          : fileTypes;
        types.push(...filteredTypes);

        // Extract methods, then filter by exported classes (file-level allowlist) and apply aliases.
        const rawMethods = extractMethodsFromFile(filePath, packageName);
        const fileMethods = rawMethods
          .filter((m) => allowlist.has(m.className))
          .map((m) => {
            const internalClassName = m.className;
            const publicClassName = aliases?.get(internalClassName) ?? internalClassName;
            const description =
              m.description === `${m.name} method of ${internalClassName}`
                ? `${m.name} method of ${publicClassName}`
                : m.description;
            return {
              ...m,
              className: publicClassName,
              description,
            };
          })
          .filter((m) => (classFilterFn ? classFilterFn(m.className) : true));

        const filteredMethods = methodFilterFn
          ? fileMethods.filter((m) => methodFilterFn(m.name))
          : fileMethods;
        methods.push(...filteredMethods);

        // Extract functions and filter to public surface + apply aliases
        const fileFunctions = extractFunctionsFromFile(filePath, packageName, {
          allowlist,
          aliases,
        });
        const filteredFunctions = methodFilterFn
          ? fileFunctions.filter((f) => methodFilterFn(f.name))
          : fileFunctions;
        functions.push(...filteredFunctions);
      } catch (error) {
        errors.push({
          file: filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { packageName, types, methods, functions, errors };
  }

  // === TypeScript declaration (.d.ts) extraction ===
  for (const filePath of dtsFiles!) {
    try {
      // Extract types
      const fileTypes = extractTypesFromFile(filePath, packageName);
      const filteredTypes = typeFilterFn
        ? fileTypes.filter((t) => typeFilterFn(t.name))
        : fileTypes;
      types.push(...filteredTypes);

      // Extract methods (pass classFilter, exportAliases, and publicExports for proper filtering)
      const fileMethods = extractMethodsFromFile(
        filePath,
        packageName,
        classFilterFn,
        exportAliases,
        publicExports
      );
      const filteredMethods = methodFilterFn
        ? fileMethods.filter((m) => methodFilterFn(m.name))
        : fileMethods;
      methods.push(...filteredMethods);

      // Extract functions
      const fileFunctions = extractFunctionsFromFile(filePath, packageName);
      const filteredFunctions = methodFilterFn
        ? fileFunctions.filter((f) => methodFilterFn(f.name))
        : fileFunctions;
      functions.push(...filteredFunctions);
    } catch (error) {
      errors.push({
        file: filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    packageName,
    types,
    methods,
    functions,
    errors,
  };
}

/**
 * Extract from specific .d.ts files
 */
export function extractFromFiles(
  files: string[],
  libraryName: string,
  options?: {
    typeFilter?: RegExp | ((name: string) => boolean);
    methodFilter?: RegExp | ((name: string) => boolean);
  }
): ExtractionResult {
  return extractFromPackage({
    packageName: libraryName,
    dtsFiles: files,
    typeFilter: options?.typeFilter,
    methodFilter: options?.methodFilter,
  });
}
