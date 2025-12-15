/**
 * Extract types (classes, interfaces, enums, type-aliases) from TypeScript files
 */

import * as ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import type { ExtractedType, PropertyInfo } from './types.js';
import { createSourceFile, getJSDocDescription, extractNestedTypeRefs } from './ast-parser.js';

/**
 * Extract all types from a TypeScript file
 */
export function extractTypesFromFile(
  filePath: string,
  libraryName: string
): ExtractedType[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = createSourceFile(filePath, sourceCode);

  const types: ExtractedType[] = [];

  function visit(node: ts.Node) {
    // Extract classes
    if (ts.isClassDeclaration(node) && node.name) {
      const extracted = extractClassOrInterface(node, sourceFile, libraryName, filePath, 'class');
      if (extracted) types.push(extracted);
    }
    // Extract interfaces
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const extracted = extractClassOrInterface(node, sourceFile, libraryName, filePath, 'interface');
      if (extracted) types.push(extracted);
    }
    // Extract enums
    if (ts.isEnumDeclaration(node) && node.name) {
      const extracted = extractEnum(node, sourceFile, libraryName, filePath);
      if (extracted) types.push(extracted);
    }
    // Extract type aliases (skip complex utility types)
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const extracted = extractTypeAlias(node, sourceFile, libraryName, filePath);
      if (extracted) types.push(extracted);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return types;
}

/**
 * Extract a class or interface declaration
 */
function extractClassOrInterface(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string,
  kind: 'class' | 'interface'
): ExtractedType | null {
  if (!node.name) return null;

  const name = node.name.text;
  const description = getJSDocDescription(node) || `${kind} ${name}`;
  const properties: PropertyInfo[] = [];
  const nestedTypes = new Set<string>();

  node.members?.forEach((member) => {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      if (member.name) {
        const propName = member.name.getText(sourceFile).replace(/['"]/g, '');
        const propType = member.type?.getText(sourceFile) || 'any';
        const isOptional = !!member.questionToken;
        const propDescription = getJSDocDescription(member);

        // Skip internal/static fields common in generated types
        if (
          propName === 'discriminator' ||
          propName === 'mapping' ||
          propName === 'attributeTypeMap'
        ) {
          return;
        }

        properties.push({
          name: propName,
          type: propType,
          optional: isOptional,
          description: propDescription,
        });

        // Extract nested type references
        const typeRefs = extractNestedTypeRefs(member.type, sourceFile);
        for (const ref of typeRefs) {
          if (ref !== name) {
            nestedTypes.add(ref);
          }
        }
      }
    }
  });

  return {
    name,
    kind,
    description,
    properties,
    nestedTypes: Array.from(nestedTypes),
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Extract an enum declaration
 */
function extractEnum(
  node: ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedType | null {
  if (!node.name) return null;

  const name = node.name.text;
  const description = getJSDocDescription(node) || `enum ${name}`;
  const properties: PropertyInfo[] = [];

  node.members.forEach((member) => {
    const memberName = member.name.getText(sourceFile);
    const memberValue = member.initializer?.getText(sourceFile) || memberName;

    properties.push({
      name: memberName,
      type: memberValue,
      optional: false,
    });
  });

  return {
    name,
    kind: 'enum',
    description,
    properties,
    nestedTypes: [],
    sourceFile: filePath,
    library: libraryName,
  };
}

/**
 * Extract a type alias declaration
 */
function extractTypeAlias(
  node: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
  libraryName: string,
  filePath: string
): ExtractedType | null {
  if (!node.name) return null;

  const name = node.name.text;

  // Skip complex utility types and generics
  if (node.typeParameters && node.typeParameters.length > 0) {
    return null;
  }

  const description = getJSDocDescription(node) || `type ${name}`;
  const typeText = node.type.getText(sourceFile);

  // For union types, extract each option as a "property"
  const properties: PropertyInfo[] = [];
  if (ts.isUnionTypeNode(node.type)) {
    node.type.types.forEach((t) => {
      const typeStr = t.getText(sourceFile);
      properties.push({
        name: typeStr.replace(/['"]/g, ''),
        type: typeStr,
        optional: false,
      });
    });
  } else {
    properties.push({
      name: 'value',
      type: typeText,
      optional: false,
    });
  }

  return {
    name,
    kind: 'type-alias',
    description,
    properties,
    nestedTypes: [],
    sourceFile: filePath,
    library: libraryName,
  };
}
