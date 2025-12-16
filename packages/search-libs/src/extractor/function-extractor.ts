/**
 * Extract standalone functions from TypeScript files
 */

import * as ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import type { ExtractedFunction, ParameterInfo } from './types.js';
import {
  createSourceFile,
  getJSDocDescription,
  extractParameterInfo,
  isAsyncMethod,
} from './ast-parser.js';

/**
 * Extract all exported functions from a TypeScript file
 */
export function extractFunctionsFromFile(
  filePath: string,
  libraryName: string
): ExtractedFunction[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = createSourceFile(filePath, sourceCode);

  const functions: ExtractedFunction[] = [];

  function visit(node: ts.Node) {
    // Extract function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const extracted = extractFunctionDeclaration(node, sourceFile, libraryName, filePath);
      if (extracted) functions.push(extracted);
    }

    // Extract exported variable declarations that are arrow functions
    if (ts.isVariableStatement(node)) {
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword
      );
      if (isExported) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer))
          ) {
            const extracted = extractArrowFunction(
              decl,
              decl.initializer,
              sourceFile,
              libraryName,
              filePath
            );
            if (extracted) functions.push(extracted);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

/**
 * Extract a function declaration
 */
function extractFunctionDeclaration(
  node: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedFunction | null {
  if (!node.name) return null;

  const name = node.name.text;

  // Skip internal functions
  if (name.startsWith('_')) {
    return null;
  }

  const description = getJSDocDescription(node) || `${name} function`;
  const parameters = extractParameterInfo(node.parameters, sourceFile);
  const returnType = node.type?.getText(sourceFile) || 'void';
  const signature = buildSignature(name, parameters, returnType);

  return {
    name,
    description,
    signature,
    parameters,
    returnType,
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Extract an arrow function or function expression
 */
function extractArrowFunction(
  decl: ts.VariableDeclaration,
  func: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedFunction | null {
  if (!ts.isIdentifier(decl.name)) return null;

  const name = decl.name.text;

  // Skip internal functions
  if (name.startsWith('_')) {
    return null;
  }

  const description =
    getJSDocDescription(decl) ||
    getJSDocDescription(func) ||
    `${name} function`;

  const parameters = extractParameterInfo(func.parameters, sourceFile);

  // Get return type from function or infer from arrow function
  let returnType = func.type?.getText(sourceFile);
  if (!returnType && ts.isArrowFunction(func)) {
    // For arrow functions without explicit return type, try to infer
    returnType = 'any';
  }
  returnType = returnType || 'void';

  const signature = buildSignature(name, parameters, returnType);

  return {
    name,
    description,
    signature,
    parameters,
    returnType,
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Build a function signature string
 */
function buildSignature(
  name: string,
  parameters: ParameterInfo[],
  returnType: string
): string {
  const paramStr = parameters
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
    .join(', ');

  return `${name}(${paramStr}): ${returnType}`;
}

/**
 * Extract functions from export declarations (for libraries that re-export)
 */
export function extractExportedFunctions(
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string,
  resolver?: (moduleName: string) => string | null
): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];

  function visit(node: ts.Node) {
    // Handle named exports: export { foo, bar }
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        const exportName = element.name.getText(sourceFile);

        // If there's a module specifier and a resolver, try to get the actual function
        if (node.moduleSpecifier && resolver) {
          const moduleSpec = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
          const resolvedPath = resolver(moduleSpec);

          if (resolvedPath) {
            const moduleFunctions = extractFunctionsFromFile(resolvedPath, libraryName);
            const found = moduleFunctions.find((f) => f.name === exportName);
            if (found) {
              functions.push(found);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}
