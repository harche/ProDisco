/**
 * TypeScript AST parsing utilities
 */

import * as ts from 'typescript';
import type { ParameterInfo } from './types.js';

/**
 * Create a TypeScript source file from source code
 */
export function createSourceFile(filePath: string, sourceCode: string): ts.SourceFile {
  return ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);
}

/**
 * Extract JSDoc comment from a node
 */
export function getJSDocDescription(node: ts.Node): string | undefined {
  const jsDocComments = ts.getJSDocCommentsAndTags(node);
  for (const comment of jsDocComments) {
    if (ts.isJSDoc(comment) && comment.comment) {
      if (typeof comment.comment === 'string') {
        return comment.comment;
      }
      // Handle JSDoc comment that is an array of nodes
      if (Array.isArray(comment.comment)) {
        return comment.comment
          .map((c) => (typeof c === 'string' ? c : c.getText()))
          .join('');
      }
    }
  }
  return undefined;
}

/**
 * Extract nested type references from a TypeNode
 * Returns all type references found in the node
 */
export function extractNestedTypeRefs(
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile
): string[] {
  if (!typeNode) {
    return [];
  }

  const refs: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName.getText(sourceFile);
      if (!refs.includes(typeName)) {
        refs.push(typeName);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(typeNode);
  return refs;
}

/**
 * Extract parameter information from a function/method signature
 */
export function extractParameterInfo(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile
): ParameterInfo[] {
  const result: ParameterInfo[] = [];

  for (const param of params) {
    const name = param.name.getText(sourceFile);
    const type = param.type?.getText(sourceFile) || 'any';
    const optional = !!param.questionToken || !!param.initializer;
    const description = getJSDocDescription(param);

    result.push({ name, type, optional, description });
  }

  return result;
}

/**
 * Split camelCase/PascalCase identifiers into separate words for better search matching
 * e.g., "queryRange" -> "query Range", "queryRangeStream" -> "query Range Stream"
 */
export function splitCamelCase(identifier: string): string {
  return identifier.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Check if a node has a specific modifier
 */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

/**
 * Check if a method is async (has async modifier or returns Promise)
 */
export function isAsyncMethod(
  node: ts.MethodDeclaration | ts.MethodSignature | ts.FunctionDeclaration,
  sourceFile: ts.SourceFile
): boolean {
  // Check for async modifier
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
    return true;
  }

  // Check if return type is Promise
  const returnType = node.type?.getText(sourceFile);
  return returnType?.startsWith('Promise<') ?? false;
}

/**
 * Check if a method is static
 */
export function isStaticMethod(node: ts.MethodDeclaration | ts.MethodSignature): boolean {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

/**
 * Check if a member is private (has private modifier or starts with underscore)
 */
export function isPrivateMember(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  name?: string
): boolean {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
    return true;
  }

  if (name && name.startsWith('_')) {
    return true;
  }

  return false;
}

/**
 * Get the text of a node, safely handling undefined
 */
export function getNodeText(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile
): string {
  if (!node) return '';
  return node.getText(sourceFile);
}
