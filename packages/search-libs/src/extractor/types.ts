/**
 * Core type definitions for the extractor module
 */

/**
 * Information about a property in a type (class, interface, enum)
 */
export interface PropertyInfo {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

/**
 * Information about a function/method parameter
 */
export interface ParameterInfo {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
  /** Expanded type definition for complex types (e.g., "{ start: Date, end: Date, step: string }") */
  typeDefinition?: string;
}

/**
 * An extracted TypeScript type (class, interface, enum, or type-alias)
 */
export interface ExtractedType {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'type-alias';
  description: string;
  properties: PropertyInfo[];
  nestedTypes: string[];
  sourceFile: string;
  library: string;
}

/**
 * An extracted method from a class
 */
export interface ExtractedMethod {
  name: string;
  className: string;
  description: string;
  parameters: ParameterInfo[];
  returnType: string;
  /** Expanded return type definition for complex types */
  returnTypeDefinition?: string;
  isStatic: boolean;
  isAsync: boolean;
  sourceFile: string;
  library: string;
}

/**
 * An extracted standalone function
 */
export interface ExtractedFunction {
  name: string;
  description: string;
  signature: string;
  parameters: ParameterInfo[];
  returnType: string;
  isAsync?: boolean;
  sourceFile: string;
  library: string;
}

/**
 * Options for extracting from a package
 */
export interface ExtractionOptions {
  /** Package name to extract from (e.g., "@kubernetes/client-node") */
  packageName: string;

  /** Specific .d.ts files to parse (auto-discovered if not provided) */
  dtsFiles?: string[];

  /** Filter for type names (regex or function) */
  typeFilter?: RegExp | ((name: string) => boolean);

  /** Filter for method/function names */
  methodFilter?: RegExp | ((name: string) => boolean);

  /** Filter for class names (only extract methods from matching classes) */
  classFilter?: RegExp | ((name: string) => boolean);

  /** Base path(s) for node_modules (defaults to process.cwd()). Can be an array to search multiple locations. */
  basePath?: string | string[];

  /** Whether to extract nested type references */
  extractNestedTypes?: boolean;
}

/**
 * Result of extraction from a package
 */
export interface ExtractionResult {
  packageName: string;
  types: ExtractedType[];
  methods: ExtractedMethod[];
  functions: ExtractedFunction[];
  errors: ExtractionError[];
}

/**
 * Error that occurred during extraction
 */
export interface ExtractionError {
  file: string;
  message: string;
  node?: string;
}

/**
 * Information about a resolved package
 */
export interface PackageInfo {
  packageName: string;
  packagePath: string;
  mainDts?: string;
  typesDir?: string;
  allDtsFiles: string[];
  /** Map of internal class names to their exported aliases (e.g., ObjectCoreV1Api -> CoreV1Api) */
  exportAliases?: Map<string, string>;
  /** Set of all publicly exported class/type names (the names users see and use) */
  publicExports?: Set<string>;
}
