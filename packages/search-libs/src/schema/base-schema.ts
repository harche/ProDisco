/**
 * Base Orama schema for indexing TypeScript libraries and scripts
 */

/**
 * Orama schema type definition
 */
export type OramaSchemaType = Record<string, 'string' | 'number' | 'boolean' | 'enum' | 'string[]' | 'number[]' | 'boolean[]'>;

/**
 * Base schema fields that all indexed documents share.
 * Consumers can extend this with domain-specific fields.
 *
 * Design decisions based on Orama best practices:
 * - `string` types for full-text searchable fields
 * - `enum` types for exact-match filterable fields
 */
export const baseSchema = {
  // === Identity ===
  id: 'string',
  documentType: 'enum', // 'type' | 'method' | 'function' | 'script'
  name: 'string',

  // === Search Content ===
  description: 'string',
  searchTokens: 'string', // CamelCase split tokens for better matching

  // === Organization ===
  library: 'enum', // Package name
  category: 'enum', // Kind or action category

  // === Type-specific fields ===
  properties: 'string', // JSON array of PropertyInfo
  typeDefinition: 'string', // Formatted type definition
  nestedTypes: 'string', // Comma-separated referenced type names
  typeKind: 'enum', // 'class' | 'interface' | 'enum' | 'type-alias'

  // === Method/function-specific fields ===
  parameters: 'string', // JSON array of ParameterInfo (includes typeDefinition for complex types)
  returnType: 'string',
  returnTypeDefinition: 'string', // Expanded return type definition for complex types
  signature: 'string',
  className: 'string', // For methods, the owning class

  // === Script-specific fields ===
  filePath: 'string',
  keywords: 'string',
} as const satisfies OramaSchemaType;

/**
 * Type for documents indexed with the base schema
 */
export type BaseDocument = {
  id: string;
  documentType: 'type' | 'method' | 'function' | 'script' | 'metric';
  name: string;
  description: string;
  searchTokens: string;
  library: string;
  category: string;

  // Type-specific
  properties: string;
  typeDefinition: string;
  nestedTypes: string;
  typeKind: string;

  // Method/function-specific
  parameters: string;
  returnType: string;
  returnTypeDefinition: string;
  signature: string;
  className: string;

  // Script-specific
  filePath: string;
  keywords: string;
};

/**
 * Create an empty base document with default values
 */
export function createEmptyDocument(): BaseDocument {
  return {
    id: '',
    documentType: 'type',
    name: '',
    description: '',
    searchTokens: '',
    library: '',
    category: '',
    properties: '',
    typeDefinition: '',
    nestedTypes: '',
    typeKind: '',
    parameters: '',
    returnType: '',
    returnTypeDefinition: '',
    signature: '',
    className: '',
    filePath: '',
    keywords: '',
  };
}
