/**
 * Script-related type definitions
 */

/**
 * Cached script metadata for indexing
 */
export interface CachedScript {
  /** Script filename (e.g., "get-pod-logs.ts") */
  filename: string;

  /** Full file path */
  filePath: string;

  /** Description extracted from first comment block */
  description: string;

  /** Resource types mentioned in the script */
  resourceTypes: string[];

  /** API classes used in the script */
  apiClasses: string[];

  /** Keywords extracted from description */
  keywords: string[];
}

/**
 * Options for parsing scripts from a directory
 */
export interface ParseScriptsOptions {
  /** File extension filter (default: .ts) */
  extension?: string;

  /** Whether to recursively search subdirectories */
  recursive?: boolean;

  /** Maximum number of scripts to parse */
  maxScripts?: number;
}
