/**
 * Extract methods from TypeScript class declarations
 */

import * as ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import type { ExtractedMethod } from './types.js';
import {
  createSourceFile,
  getJSDocDescription,
  extractParameterInfo,
  isAsyncMethod,
  isStaticMethod,
  isPrivateMember,
} from './ast-parser.js';

/**
 * Extract all methods from a TypeScript file
 *
 * @param filePath - Path to the .d.ts file
 * @param libraryName - Name of the library
 * @param classFilter - Optional filter function for class names
 * @param exportAliases - Optional map of internal class names to exported aliases
 * @param publicExports - Optional set of publicly exported names (only index these)
 */
export function extractMethodsFromFile(
  filePath: string,
  libraryName: string,
  classFilter?: (className: string) => boolean,
  exportAliases?: Map<string, string>,
  publicExports?: Set<string>
): ExtractedMethod[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = createSourceFile(filePath, sourceCode);

  const methods: ExtractedMethod[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const internalClassName = node.name.text;

      // Use exported alias if available (e.g., ObjectCoreV1Api -> CoreV1Api)
      const className = exportAliases?.get(internalClassName) ?? internalClassName;

      // If we have public exports info, only index classes that are publicly exported
      // A class is public if:
      // 1. Its internal name has an alias in the export map (aliased export)
      // 2. OR its name is directly in the public exports set
      if (publicExports && publicExports.size > 0) {
        const isAliasedExport = exportAliases?.has(internalClassName);
        const isDirectExport = publicExports.has(internalClassName);

        if (!isAliasedExport && !isDirectExport) {
          // This class is not publicly exported, skip it
          return;
        }
      }

      // Apply class filter if provided (filter on the public name)
      if (classFilter && !classFilter(className)) {
        return;
      }

      const classMethods = extractMethodsFromClass(
        node,
        sourceFile,
        libraryName,
        filePath,
        className // Pass the resolved className (with alias applied)
      );
      methods.push(...classMethods);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return methods;
}

/**
 * Extract methods from a class declaration
 *
 * @param classNode - The class declaration AST node
 * @param sourceFile - The source file containing the class
 * @param libraryName - Name of the library
 * @param filePath - Path to the source file
 * @param resolvedClassName - Optional pre-resolved class name (with export alias applied)
 */
export function extractMethodsFromClass(
  classNode: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string,
  resolvedClassName?: string
): ExtractedMethod[] {
  if (!classNode.name) return [];

  // Use resolved name if provided, otherwise use the internal name
  const className = resolvedClassName ?? classNode.name.text;
  const methods: ExtractedMethod[] = [];

  for (const member of classNode.members) {
    // Handle method declarations
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = member.name.getText(sourceFile);

      // Skip private methods, constructors, and internal methods
      if (
        methodName === 'constructor' ||
        isPrivateMember(member, sourceFile, methodName)
      ) {
        continue;
      }

      const description =
        getJSDocDescription(member) ||
        `${methodName} method of ${className}`;

      const parameters = extractParameterInfo(member.parameters, sourceFile);
      const returnType = member.type?.getText(sourceFile) || 'void';
      const isStatic = isStaticMethod(member);
      const isAsync = isAsyncMethod(member, sourceFile);

      methods.push({
        name: methodName,
        className,
        description,
        parameters,
        returnType,
        isStatic,
        isAsync,
        sourceFile: filePath,
        library: libraryName,
      });
    }

    // Handle method signatures (for interfaces/abstract classes)
    if (ts.isMethodSignature(member) && member.name) {
      const methodName = member.name.getText(sourceFile);

      // Skip private methods
      if (isPrivateMember(member, sourceFile, methodName)) {
        continue;
      }

      const description =
        getJSDocDescription(member) ||
        `${methodName} method of ${className}`;

      const parameters = extractParameterInfo(member.parameters, sourceFile);
      const returnType = member.type?.getText(sourceFile) || 'void';
      const isAsync = isAsyncMethod(member, sourceFile);

      methods.push({
        name: methodName,
        className,
        description,
        parameters,
        returnType,
        isStatic: false,
        isAsync,
        sourceFile: filePath,
        library: libraryName,
      });
    }
  }

  return methods;
}

/**
 * Extract methods from an interface declaration (for type libraries)
 */
export function extractMethodsFromInterface(
  interfaceNode: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedMethod[] {
  if (!interfaceNode.name) return [];

  const interfaceName = interfaceNode.name.text;
  const methods: ExtractedMethod[] = [];

  for (const member of interfaceNode.members) {
    if (ts.isMethodSignature(member) && member.name) {
      const methodName = member.name.getText(sourceFile);

      // Skip private methods
      if (methodName.startsWith('_')) {
        continue;
      }

      const description =
        getJSDocDescription(member) ||
        `${methodName} method of ${interfaceName}`;

      const parameters = extractParameterInfo(member.parameters, sourceFile);
      const returnType = member.type?.getText(sourceFile) || 'void';
      const isAsync = isAsyncMethod(member, sourceFile);

      methods.push({
        name: methodName,
        className: interfaceName,
        description,
        parameters,
        returnType,
        isStatic: false,
        isAsync,
        sourceFile: filePath,
        library: libraryName,
      });
    }
  }

  return methods;
}
