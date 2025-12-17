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

export interface ExtractFunctionsOptions {
  /** If provided, only functions whose *local* name is in the set will be returned. */
  allowlist?: Set<string>;
  /** Optional rename map from localName -> publicName */
  aliases?: Map<string, string>;
}

function isJavaScriptFile(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs');
}

/**
 * Extract all exported functions from a TypeScript file
 */
export function extractFunctionsFromFile(
  filePath: string,
  libraryName: string,
  options?: ExtractFunctionsOptions
): ExtractedFunction[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = createSourceFile(filePath, sourceCode);

  const functions: ExtractedFunction[] = [];
  const allowlist = options?.allowlist;
  const aliases = options?.aliases;
  const defaultReturnType = isJavaScriptFile(filePath) ? 'any' : 'void';

  function pushWithAlias(func: ExtractedFunction) {
    const publicName = aliases?.get(func.name) ?? func.name;
    if (publicName !== func.name) {
      func = {
        ...func,
        name: publicName,
        signature: buildSignature(publicName, func.parameters, func.returnType),
      };
    }
    functions.push(func);
  }

  function visit(node: ts.Node) {
    // Extract function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const localName = node.name.text;
      if (allowlist && !allowlist.has(localName)) {
        // Not part of the public surface (or not requested)
      } else {
        const extracted = extractFunctionDeclaration(
          node,
          sourceFile,
          libraryName,
          filePath,
          defaultReturnType
        );
        if (extracted) pushWithAlias(extracted);
      }
    }

    // Extract exported variable declarations that are arrow functions
    if (ts.isVariableStatement(node)) {
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword
      );
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          const localName = decl.name.text;
          const shouldInclude = allowlist
            ? allowlist.has(localName)
            : isExported;
          if (!shouldInclude) continue;

          const extracted = extractArrowFunction(
            decl,
            decl.initializer,
            sourceFile,
            libraryName,
            filePath,
            defaultReturnType
          );
          if (extracted) pushWithAlias(extracted);
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
  filePath: string,
  defaultReturnType: string
): ExtractedFunction | null {
  if (!node.name) return null;

  const name = node.name.text;

  // Skip internal functions
  if (name.startsWith('_')) {
    return null;
  }

  const description = getJSDocDescription(node) || `${name} function`;
  const parameters = extractParameterInfo(node.parameters, sourceFile);
  const returnType = node.type?.getText(sourceFile) || defaultReturnType;
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
  filePath: string,
  defaultReturnType: string
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
  if (!returnType) {
    // For JS (and TS without annotations), we default to a safe "any"
    returnType = defaultReturnType === 'any' ? 'any' : ts.isArrowFunction(func) ? 'any' : defaultReturnType;
  }

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
