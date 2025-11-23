/**
 * Extract TypeScript type definitions and JSDoc from @kubernetes/client-node
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export interface FieldInfo {
  name: string;
  type: string;
  optional: boolean;
  jsDoc?: string;
}

export interface InterfaceInfo {
  name: string;
  jsDoc?: string;
  fields: FieldInfo[];
}

/**
 * Parse a TypeScript source file and extract interface information
 */
export function extractInterfaceFromFile(filePath: string, interfaceName: string): InterfaceInfo | null {
  const sourceText = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );

  let result: InterfaceInfo | null = null;

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name?.text === interfaceName) {
      const jsDoc = extractJsDocFromSource(sourceText, node);
      const fields: FieldInfo[] = [];

      node.members.forEach(member => {
        if (ts.isPropertyDeclaration(member)) {
          const fieldName = member.name?.getText(sourceFile);
          if (!fieldName) return;

          // Skip static/readonly/internal fields
          if (fieldName === 'discriminator' || fieldName === 'mapping' || fieldName === 'attributeTypeMap') {
            return;
          }

          const fieldType = member.type ? getTypeString(member.type, sourceFile) : 'unknown';
          const fieldJsDoc = extractJsDocFromSource(sourceText, member);
          const optional = member.questionToken !== undefined;

          fields.push({
            name: fieldName.replace(/'/g, ''), // Remove quotes if present
            type: fieldType,
            optional,
            jsDoc: fieldJsDoc
          });
        }
      });

      result = {
        name: interfaceName,
        jsDoc,
        fields
      };
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Extract JSDoc comment from a node using the source text
 */
function extractJsDocFromSource(sourceText: string, node: ts.Node): string | undefined {
  const nodeStart = node.getStart();
  const nodeFullStart = node.getFullStart();
  
  // Get the text between full start and start (includes comments)
  const leadingText = sourceText.substring(nodeFullStart, nodeStart);
  
  // Find JSDoc comments (/** ... */)
  const jsDocMatch = leadingText.match(/\/\*\*([\s\S]*?)\*\//);
  
  if (!jsDocMatch) {
    return undefined;
  }

  // Clean up the comment
  const commentText = jsDocMatch[1];
  
  if (!commentText) {
    return undefined;
  }
  
  // Remove leading * from each line and trim
  const lines = commentText.split('\n')
    .map(line => line.replace(/^\s*\*\s?/, '').trim())
    .filter(line => line.length > 0);

  return lines.join(' ');
}

/**
 * Convert TypeScript type node to string representation
 */
function getTypeString(typeNode: ts.TypeNode, sourceFile?: ts.SourceFile): string {
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = sourceFile ? typeNode.typeName.getText(sourceFile) : typeNode.typeName.getText();
    
    // Handle generic types
    if (typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      const genericArgs = typeNode.typeArguments.map(arg => getTypeString(arg, sourceFile)).join(', ');
      return `${typeName}<${genericArgs}>`;
    }
    
    return typeName;
  }
  
  if (ts.isArrayTypeNode(typeNode)) {
    return `Array<${getTypeString(typeNode.elementType, sourceFile)}>`;
  }
  
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.map(t => getTypeString(t, sourceFile)).join(' | ');
  }
  
  if (ts.isTypeLiteralNode(typeNode)) {
    // For type literals, try to extract the structure
    if (typeNode.members.length === 0) {
      return 'object';
    }
    return 'object';
  }
  
  return sourceFile ? typeNode.getText(sourceFile) : typeNode.getText();
}

/**
 * Find the source file for a Kubernetes type
 */
export function findKubernetesTypeFile(typeName: string): string | null {
  const nodeModulesPath = path.resolve(process.cwd(), 'node_modules/@kubernetes/client-node/dist/gen/models');
  const expectedFile = path.join(nodeModulesPath, `${typeName}.d.ts`);
  
  if (fs.existsSync(expectedFile)) {
    return expectedFile;
  }
  
  return null;
}

