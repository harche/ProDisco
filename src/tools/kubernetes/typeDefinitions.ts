import { z } from 'zod';
import * as ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ToolDefinition } from '../types.js';

const GetTypeDefinitionInputSchema = z.object({
  types: z
    .array(z.string())
    .describe('Array of Kubernetes type names or paths to get definitions for (e.g., ["V1Pod", "V1Deployment.spec", "V1Deployment.spec.template.spec"])'),
  depth: z
    .number()
    .int()
    .positive()
    .max(2)
    .default(1)
    .optional()
    .describe('Depth of nested type definitions to include (default: 1, max: 2)'),
});

type TypeDefinitionResult = {
  summary: string;
  types: Record<string, {
    name: string;
    definition: string;
    file: string;
    nestedTypes: string[];
  }>;
};

interface PropertyInfo {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

interface TypeInfo {
  name: string;
  properties: PropertyInfo[];
  description?: string;
}

/**
 * Extract JSDoc comment from a node
 */
function getJSDocDescription(node: ts.Node, _sourceFile: ts.SourceFile): string | undefined {
  const jsDocComments = ts.getJSDocCommentsAndTags(node);
  for (const comment of jsDocComments) {
    if (ts.isJSDoc(comment) && comment.comment) {
      if (typeof comment.comment === 'string') {
        return comment.comment;
      }
    }
  }
  return undefined;
}

/**
 * Extract type definition from TypeScript declaration file using TypeScript compiler API
 */
function extractTypeDefinitionWithTS(typeName: string, filePath: string): { typeInfo: TypeInfo; nestedTypes: string[] } | null {
  const sourceCode = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );
  
  let typeInfo: TypeInfo | null = null;
  const nestedTypes = new Set<string>();
  
  function visit(node: ts.Node) {
    // Check if this is the class or interface we're looking for
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && node.name.text === typeName) {
      const properties: PropertyInfo[] = [];
      const description = getJSDocDescription(node, sourceFile);
      
      // Extract properties/members
      node.members?.forEach((member) => {
        if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
          if (member.name) {
            const propName = member.name.getText(sourceFile);
            const propType = member.type?.getText(sourceFile) || 'any';
            const isOptional = !!member.questionToken;
            const propDescription = getJSDocDescription(member, sourceFile);
            
            properties.push({
              name: propName.replace(/['"]/g, ''),
              type: propType,
              optional: isOptional,
              description: propDescription,
            });
            
            // Extract nested type references
            const typeRefs = extractNestedTypeRefs(propType);
            typeRefs.forEach(ref => {
              if (ref !== typeName) {
                nestedTypes.add(ref);
              }
            });
          }
        }
      });
      
      typeInfo = {
        name: typeName,
        properties,
        description,
      };
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  if (!typeInfo) {
    return null;
  }
  
  return {
    typeInfo,
    nestedTypes: Array.from(nestedTypes),
  };
}

/**
 * Extract nested type references from a type string
 */
function extractNestedTypeRefs(typeStr: string): string[] {
  const refs: string[] = [];
  const typeRefRegex = /\b([VK]\d+[A-Z][a-zA-Z0-9]*|Core[A-Z][a-zA-Z0-9]*)\b/g;
  let match;
  
  while ((match = typeRefRegex.exec(typeStr)) !== null) {
    const ref = match[1];
    if (ref && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  
  return refs;
}

/**
 * Extract the main type identifier from a TypeScript type node using native TS compiler API
 * Handles: Array<V1Pod>, V1PodSpec | undefined, V1Container[], etc.
 */
function extractTypeIdentifier(typeNode: ts.TypeNode): string | null {
  // Handle union types (e.g., V1PodSpec | undefined)
  if (ts.isUnionTypeNode(typeNode)) {
    for (const type of typeNode.types) {
      // Skip undefined/null types
      if (type.kind === ts.SyntaxKind.UndefinedKeyword || type.kind === ts.SyntaxKind.NullKeyword) {
        continue;
      }
      return extractTypeIdentifier(type);
    }
    return null;
  }
  
  // Handle array types (e.g., V1Container[])
  if (ts.isArrayTypeNode(typeNode)) {
    return extractTypeIdentifier(typeNode.elementType);
  }
  
  // Handle type references (e.g., Array<V1Pod>, V1PodSpec)
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    
    // Handle Array<T> or other generic types
    if (typeName === 'Array' && typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      const firstArg = typeNode.typeArguments[0];
      if (firstArg) {
        return extractTypeIdentifier(firstArg);
      }
    }
    
    // Return the type name directly
    return typeName;
  }
  
  // Handle indexed access types (e.g., { [key: string]: V1Pod })
  if (ts.isTypeLiteralNode(typeNode)) {
    // For now, return null for complex literal types
    return null;
  }
  
  return null;
}

/**
 * Resolve a property path like "V1Deployment.spec.template.spec" to get the final type
 * Returns the type name of the property at the end of the path
 */
function _resolvePropertyPath(rootTypeName: string, propertyPath: string[], basePath: string): { typeName: string; fullPath: string } | null {
  let currentType = rootTypeName;
  const resolvedPath: string[] = [rootTypeName];
  
  for (const propName of propertyPath) {
    const filePath = findTypeDefinitionFile(currentType, basePath);
    if (!filePath) {
      return null;
    }
    
    const sourceCode = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );
    
    let foundType: string | null = null;
    
    function visit(node: ts.Node) {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && 
          node.name && node.name.text === currentType) {
        
        node.members?.forEach((member) => {
          if ((ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) && member.name) {
            const memberName = member.name.getText(sourceFile).replace(/['"]/g, '');
            if (memberName === propName && member.type) {
              // Use native TypeScript API to extract type
              const typeIdentifier = extractTypeIdentifier(member.type);
              if (typeIdentifier) {
                foundType = typeIdentifier;
              }
            }
          }
        });
      }
      
      if (!foundType) {
        ts.forEachChild(node, visit);
      }
    }
    
    visit(sourceFile);
    
    if (!foundType) {
      return null;
    }
    
    currentType = foundType;
    resolvedPath.push(propName);
  }
  
  return {
    typeName: currentType,
    fullPath: resolvedPath.join('.'),
  };
}

/**
 * Format type info as a readable string (concise version)
 */
function formatTypeInfo(typeInfo: TypeInfo, maxProperties: number = 20): string {
  let result = `${typeInfo.name} {\n`;
  
  // Limit properties to avoid huge outputs
  const propsToShow = typeInfo.properties.slice(0, maxProperties);
  const hasMore = typeInfo.properties.length > maxProperties;
  
  for (const prop of propsToShow) {
    const optionalMarker = prop.optional ? '?' : '';
    result += `  ${prop.name}${optionalMarker}: ${prop.type}\n`;
  }
  
  if (hasMore) {
    result += `  ... ${typeInfo.properties.length - maxProperties} more properties\n`;
  }
  
  result += `}`;
  return result;
}

/**
 * Find type definition file in Kubernetes client-node package
 */
function findTypeDefinitionFile(typeName: string, basePath: string): string | null {
  const k8sPath = join(basePath, 'node_modules', '@kubernetes', 'client-node', 'dist', 'gen', 'models');
  const filePath = join(k8sPath, `${typeName}.d.ts`);
  
  if (existsSync(filePath)) {
    return filePath;
  }
  
  return null;
}

/**
 * Parse a type path into base type and property path
 * e.g., "V1Deployment.spec.template" -> { baseType: "V1Deployment", path: ["spec", "template"] }
 */
function parseTypePath(typePath: string): { baseType: string; path: string[] } | null {
  const parts = typePath.split('.');
  const baseType = parts[0];
  if (!baseType) {
    return null;
  }
  const path = parts.slice(1);
  return { baseType, path };
}

/**
 * Navigate through type properties to find a subtype
 * Returns the property info and the type name for the subproperty
 */
function navigateToSubtype(
  typeInfo: TypeInfo,
  propertyPath: string[],
  basePath: string,
  cache: Map<string, TypeInfo>
): { typeInfo: TypeInfo; propertyPath: string; typeName: string } | null {
  if (propertyPath.length === 0) {
    return null;
  }

  let currentTypeInfo = typeInfo;
  let currentTypeName = typeInfo.name;
  const pathSegments: string[] = [currentTypeName];

  for (let i = 0; i < propertyPath.length; i++) {
    const propertyName = propertyPath[i];
    if (!propertyName) {
      return null;
    }
    
    const property = currentTypeInfo.properties.find(p => p.name === propertyName);

    if (!property) {
      return null; // Property not found
    }

    pathSegments.push(propertyName);

    // Now we need to get the actual TypeScript type node for this property
    // We'll need to re-parse to get the type node
    const filePath = findTypeDefinitionFile(currentTypeName, basePath);
    if (!filePath) {
      return null;
    }
    
    const sourceCode = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);
    
    let propertyTypeNode: ts.TypeNode | null = null;
    
    function findPropertyType(node: ts.Node) {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && 
          node.name && node.name.text === currentTypeName) {
        node.members?.forEach((member) => {
          if ((ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) && 
              member.name && member.type) {
            const memberName = member.name.getText(sourceFile).replace(/['"]/g, '');
            if (memberName === propertyName) {
              propertyTypeNode = member.type;
            }
          }
        });
      }
      if (!propertyTypeNode) {
        ts.forEachChild(node, findPropertyType);
      }
    }
    
    findPropertyType(sourceFile);
    
    if (!propertyTypeNode) {
      return null;
    }
    
    // Use native TypeScript API to extract the type
    const nextTypeName = extractTypeIdentifier(propertyTypeNode);
    if (!nextTypeName) {
      return null;
    }
    
    // If this is the last segment, we found what we're looking for
    if (i === propertyPath.length - 1) {
      return {
        typeInfo: currentTypeInfo,
        propertyPath: pathSegments.join('.'),
        typeName: nextTypeName,
      };
    }
    
    // Check cache first
    let nextTypeInfo = cache.get(nextTypeName);
    
    if (!nextTypeInfo) {
      // Load the type definition
      const filePath = findTypeDefinitionFile(nextTypeName, basePath);
      if (!filePath) {
        return null;
      }

      const extracted = extractTypeDefinitionWithTS(nextTypeName, filePath);
      if (!extracted) {
        return null;
      }

      nextTypeInfo = extracted.typeInfo;
      cache.set(nextTypeName, nextTypeInfo);
    }

    currentTypeInfo = nextTypeInfo;
    currentTypeName = nextTypeName;
  }

  return null;
}

/**
 * Get type information for a subtype at a specific path
 */
function getSubtypeInfo(
  baseTypeName: string,
  propertyPath: string[],
  basePath: string,
  cache: Map<string, TypeInfo>
): { typeInfo: TypeInfo; fullPath: string; originalType: string } | null {
  // First, get the base type
  let baseTypeInfo = cache.get(baseTypeName);
  
  if (!baseTypeInfo) {
    const filePath = findTypeDefinitionFile(baseTypeName, basePath);
    if (!filePath) {
      return null;
    }

    const extracted = extractTypeDefinitionWithTS(baseTypeName, filePath);
    if (!extracted) {
      return null;
    }

    baseTypeInfo = extracted.typeInfo;
    cache.set(baseTypeName, baseTypeInfo);
  }

  // If no path, return the base type
  if (propertyPath.length === 0) {
    return {
      typeInfo: baseTypeInfo,
      fullPath: baseTypeName,
      originalType: baseTypeName,
    };
  }

  // Navigate to the subtype
  const result = navigateToSubtype(baseTypeInfo, propertyPath, basePath, cache);
  if (!result) {
    return null;
  }

  // Now load the actual type definition for the target property
  const targetTypeName = result.typeName;
  let targetTypeInfo = cache.get(targetTypeName);

  if (!targetTypeInfo) {
    const filePath = findTypeDefinitionFile(targetTypeName, basePath);
    if (filePath) {
      const extracted = extractTypeDefinitionWithTS(targetTypeName, filePath);
      if (extracted) {
        targetTypeInfo = extracted.typeInfo;
        cache.set(targetTypeName, targetTypeInfo);
      }
    }
  }

  // If we couldn't load the type, create a synthetic one showing just the property
  if (!targetTypeInfo) {
    const lastProp = propertyPath[propertyPath.length - 1];
    if (!lastProp) {
      return null;
    }
    
    const property = result.typeInfo.properties.find(p => p.name === lastProp);
    if (property) {
      targetTypeInfo = {
        name: `${result.propertyPath}`,
        properties: [{
          name: lastProp,
          type: property.type,
          optional: property.optional,
          description: property.description || undefined,
        }],
        description: `Property type: ${property.type}`,
      };
    } else {
      return null;
    }
  }

  return {
    typeInfo: targetTypeInfo,
    fullPath: result.propertyPath,
    originalType: targetTypeName,
  };
}

export const getTypeDefinitionTool: ToolDefinition<TypeDefinitionResult, typeof GetTypeDefinitionInputSchema> = {
  name: 'kubernetes.getTypeDefinition',
  description: 
    'Get TypeScript type definitions for Kubernetes types. ' +
    'Use this to understand the structure of request/response objects like V1Pod, V1PodList, V1Event, etc. ' +
    'Returns the interface definition with nested types up to specified depth.',
  schema: GetTypeDefinitionInputSchema,
  async execute(input) {
    const { types, depth = 2 } = input;
    const basePath = process.cwd();
    
    const results: Record<string, {
      name: string;
      definition: string;
      file: string;
      nestedTypes: string[];
    }> = {};
    
    const typesToProcess = new Set(types);
    const processedTypes = new Set<string>();
    let currentDepth = 0;
    
    while (typesToProcess.size > 0 && currentDepth < depth) {
      const currentBatch = Array.from(typesToProcess);
      typesToProcess.clear();
      
      for (const typePath of currentBatch) {
        if (processedTypes.has(typePath)) {
          continue;
        }
        
        processedTypes.add(typePath);
        
        // Check if this is a dot-notation path (e.g., "V1Deployment.spec")
        const parsedPath = parseTypePath(typePath);
        if (!parsedPath) {
          results[typePath] = {
            name: typePath,
            definition: `// Invalid type path: ${typePath}`,
            file: 'error',
            nestedTypes: [],
          };
          continue;
        }
        
        const { baseType, path: propertyPath } = parsedPath;
        
        // If this is a property path (has dots), use getSubtypeInfo
        if (propertyPath.length > 0) {
          const cache = new Map<string, TypeInfo>();
          const subtypeInfo = getSubtypeInfo(baseType, propertyPath, basePath, cache);
          
          if (subtypeInfo) {
            const definition = formatTypeInfo(subtypeInfo.typeInfo);
            results[typePath] = {
              name: subtypeInfo.typeInfo.name,
              definition,
              file: findTypeDefinitionFile(subtypeInfo.originalType, basePath)?.replace(basePath, '.') || 'resolved',
              nestedTypes: [],
            };
          } else {
            results[typePath] = {
              name: typePath,
              definition: `// Could not resolve property path: ${typePath}`,
              file: 'not found',
              nestedTypes: [],
            };
          }
        } else {
          // Regular type name (no dots)
          const filePath = findTypeDefinitionFile(baseType, basePath);
          
          if (filePath) {
            try {
              const extracted = extractTypeDefinitionWithTS(baseType, filePath);
              
              if (extracted) {
                const definition = formatTypeInfo(extracted.typeInfo);
                results[typePath] = {
                  name: baseType,
                  definition,
                  file: filePath.replace(basePath, '.'),
                  nestedTypes: extracted.nestedTypes,
                };
                
                // Add nested types to process if within depth limit
                if (currentDepth < depth - 1) {
                  for (const nestedType of extracted.nestedTypes) {
                    if (!processedTypes.has(nestedType)) {
                      typesToProcess.add(nestedType);
                    }
                  }
                }
              } else {
                results[typePath] = {
                  name: baseType,
                  definition: `// Type ${baseType} not found in file ${filePath}`,
                  file: filePath.replace(basePath, '.'),
                  nestedTypes: [],
                };
              }
            } catch (error) {
              results[typePath] = {
                name: baseType,
                definition: `// Error extracting type ${baseType}: ${error instanceof Error ? error.message : String(error)}`,
                file: filePath.replace(basePath, '.'),
                nestedTypes: [],
              };
            }
          } else {
            results[typePath] = {
              name: baseType,
              definition: `// Type ${baseType} not found in @kubernetes/client-node type definitions`,
              file: 'not found',
              nestedTypes: [],
            };
          }
        }
      }
      
      currentDepth++;
    }
    
    // Create summary
    const foundCount = Object.values(results).filter(r => r.file !== 'not found').length;
    const totalTypes = Object.keys(results).length;
    
    let summary = `Fetched ${foundCount} type definition(s)`;
    if (totalTypes > types.length) {
      summary += ` (${types.length} requested, ${totalTypes - types.length} nested)\n\n`;
    } else {
      summary += `\n\n`;
    }
    
    // Only show requested types in summary, not all nested ones
    for (const typeName of types) {
      const typeInfo = results[typeName];
      if (typeInfo && typeInfo.file !== 'not found') {
        summary += `${typeName}: ${typeInfo.nestedTypes.length} nested type(s)\n`;
      }
    }
    
    return {
      summary,
      types: results,
    };
  },
};
