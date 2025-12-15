/**
 * Format search results for AI consumption
 */

import type { BaseDocument } from '../schema/base-schema.js';
import type { SearchResult } from './search-engine.js';
import type { PropertyInfo, ParameterInfo } from '../extractor/types.js';

/**
 * Formatted result item for display/AI consumption
 */
export interface FormattedItem {
  id: string;
  type: 'type' | 'method' | 'function' | 'script';
  name: string;
  library: string;
  category: string;
  description: string;

  // For types
  typeKind?: string;
  properties?: PropertyInfo[];
  nestedTypes?: string[];
  typeDefinition?: string;

  // For methods/functions
  parameters?: ParameterInfo[];
  returnType?: string;
  returnTypeDefinition?: string;
  signature?: string;
  className?: string;

  // For scripts
  filePath?: string;
  keywords?: string[];
}

/**
 * Formatted search result
 */
export interface FormattedResult {
  summary: string;
  items: FormattedItem[];
  totalMatches: number;
  facets: Record<string, Record<string, number>>;
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  searchTime: number;
}

/**
 * Options for formatting results
 */
export interface FormatOptions {
  /** Maximum properties to include for types */
  maxProperties?: number;

  /** Include file paths for scripts */
  includeFilePaths?: boolean;
}

/**
 * Format search results for structured output
 */
export function formatResults(
  searchResult: SearchResult<BaseDocument>,
  options: FormatOptions = {}
): FormattedResult {
  const { maxProperties = 10, includeFilePaths = false } = options;

  const items = searchResult.results.map((doc) =>
    formatDocument(doc, { maxProperties, includeFilePaths })
  );

  const resultCount = searchResult.results.length;
  const total = searchResult.totalMatches;

  let summary: string;
  if (resultCount === 0) {
    summary = 'No results found.';
  } else if (resultCount === total) {
    summary = `Found ${total} result${total === 1 ? '' : 's'}.`;
  } else {
    summary = `Showing ${resultCount} of ${total} results.`;
  }

  return {
    summary,
    items,
    totalMatches: searchResult.totalMatches,
    facets: searchResult.facets,
    pagination: {
      offset: 0, // Would need to track this from search options
      limit: resultCount,
      hasMore: resultCount < total,
    },
    searchTime: searchResult.searchTime,
  };
}

/**
 * Format a single document
 */
function formatDocument(
  doc: BaseDocument,
  options: FormatOptions
): FormattedItem {
  const base: FormattedItem = {
    id: doc.id,
    type: doc.documentType as FormattedItem['type'],
    name: doc.name,
    library: doc.library,
    category: doc.category,
    description: doc.description,
  };

  switch (doc.documentType) {
    case 'type':
      return formatTypeDocument(doc, base, options);
    case 'method':
      return formatMethodDocument(doc, base);
    case 'function':
      return formatFunctionDocument(doc, base);
    case 'script':
      return formatScriptDocument(doc, base, options);
    default:
      return base;
  }
}

/**
 * Format a type document
 */
function formatTypeDocument(
  doc: BaseDocument,
  base: FormattedItem,
  options: FormatOptions
): FormattedItem {
  let properties: PropertyInfo[] = [];
  try {
    properties = doc.properties ? JSON.parse(doc.properties) : [];
  } catch {
    // Ignore parse errors
  }

  const nestedTypes = doc.nestedTypes
    ? doc.nestedTypes.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    ...base,
    typeKind: doc.typeKind,
    properties: properties.slice(0, options.maxProperties || 10),
    nestedTypes,
    typeDefinition: doc.typeDefinition || undefined,
  };
}

/**
 * Format a method document
 */
function formatMethodDocument(
  doc: BaseDocument,
  base: FormattedItem
): FormattedItem {
  let parameters: ParameterInfo[] = [];
  try {
    parameters = doc.parameters ? JSON.parse(doc.parameters) : [];
  } catch {
    // Ignore parse errors
  }

  return {
    ...base,
    parameters,
    returnType: doc.returnType || undefined,
    returnTypeDefinition: doc.returnTypeDefinition || undefined,
    signature: doc.signature || undefined,
    className: doc.className || undefined,
  };
}

/**
 * Format a function document
 */
function formatFunctionDocument(
  doc: BaseDocument,
  base: FormattedItem
): FormattedItem {
  let parameters: ParameterInfo[] = [];
  try {
    parameters = doc.parameters ? JSON.parse(doc.parameters) : [];
  } catch {
    // Ignore parse errors
  }

  return {
    ...base,
    parameters,
    returnType: doc.returnType || undefined,
    signature: doc.signature || undefined,
  };
}

/**
 * Format a script document
 */
function formatScriptDocument(
  doc: BaseDocument,
  base: FormattedItem,
  options: FormatOptions
): FormattedItem {
  const keywords = doc.keywords
    ? doc.keywords.split(' ').filter(Boolean)
    : [];

  return {
    ...base,
    filePath: options.includeFilePaths ? doc.filePath : undefined,
    keywords: keywords.length > 0 ? keywords : undefined,
  };
}

/**
 * Format results as a string for AI consumption
 */
export function formatForAI(
  searchResult: SearchResult<BaseDocument>,
  options: FormatOptions = {}
): string {
  const formatted = formatResults(searchResult, options);

  const lines: string[] = [formatted.summary, ''];

  for (const item of formatted.items) {
    lines.push(`## ${item.name} (${item.type})`);
    lines.push(`Library: ${item.library}`);
    lines.push(`Category: ${item.category}`);
    lines.push(`Description: ${item.description}`);

    if (item.signature) {
      lines.push(`Signature: ${item.signature}`);
    }

    if (item.parameters && item.parameters.length > 0) {
      lines.push('Parameters:');
      for (const param of item.parameters) {
        const opt = param.optional ? '?' : '';
        const typeDef = param.typeDefinition ? ` = ${param.typeDefinition}` : '';
        lines.push(`  - ${param.name}${opt}: ${param.type}${typeDef}`);
      }
    }

    if (item.returnType) {
      const returnDef = item.returnTypeDefinition ? ` = ${item.returnTypeDefinition}` : '';
      lines.push(`Returns: ${item.returnType}${returnDef}`);
    }

    if (item.properties && item.properties.length > 0) {
      lines.push('Properties:');
      for (const prop of item.properties) {
        const opt = prop.optional ? '?' : '';
        lines.push(`  - ${prop.name}${opt}: ${prop.type}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
