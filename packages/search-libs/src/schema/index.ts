/**
 * Schema module - Orama schema definitions and builders
 */

export { baseSchema, type BaseDocument, createEmptyDocument } from './base-schema.js';
export {
  buildSchema,
  buildDocument,
  buildTypeDocument,
  buildMethodDocument,
  buildFunctionDocument,
  buildScriptDocument,
  type SchemaBuilderOptions,
  type ExtensionSchema,
} from './schema-builder.js';
