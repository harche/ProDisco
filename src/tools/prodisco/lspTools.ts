/**
 * LSP Tools - Language Server Protocol operations for code intelligence
 *
 * Provides MCP tool interface for LSP operations (workspaceSymbol, hover,
 * goToDefinition, findReferences, documentSymbol) via the sandbox server.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { logger } from '../../util/logger.js';
import { type LibrarySpec } from '../../config/libraries.js';
import {
  SandboxClient,
  type LspWorkspaceSymbolResult,
  type LspHoverResult,
  type LspLocation,
  type LspDocumentSymbol,
  LspSymbolKind,
} from '@prodisco/sandbox-server';

// ============================================================================
// Types
// ============================================================================

export type LspToolsRuntimeConfig = {
  libraries: LibrarySpec[];
};

// ============================================================================
// Symbol Kind Helpers
// ============================================================================

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [LspSymbolKind.LSP_SYMBOL_KIND_FILE]: 'file',
  [LspSymbolKind.LSP_SYMBOL_KIND_MODULE]: 'module',
  [LspSymbolKind.LSP_SYMBOL_KIND_NAMESPACE]: 'namespace',
  [LspSymbolKind.LSP_SYMBOL_KIND_PACKAGE]: 'package',
  [LspSymbolKind.LSP_SYMBOL_KIND_CLASS]: 'class',
  [LspSymbolKind.LSP_SYMBOL_KIND_METHOD]: 'method',
  [LspSymbolKind.LSP_SYMBOL_KIND_PROPERTY]: 'property',
  [LspSymbolKind.LSP_SYMBOL_KIND_FIELD]: 'field',
  [LspSymbolKind.LSP_SYMBOL_KIND_CONSTRUCTOR]: 'constructor',
  [LspSymbolKind.LSP_SYMBOL_KIND_ENUM]: 'enum',
  [LspSymbolKind.LSP_SYMBOL_KIND_INTERFACE]: 'interface',
  [LspSymbolKind.LSP_SYMBOL_KIND_FUNCTION]: 'function',
  [LspSymbolKind.LSP_SYMBOL_KIND_VARIABLE]: 'variable',
  [LspSymbolKind.LSP_SYMBOL_KIND_CONSTANT]: 'constant',
  [LspSymbolKind.LSP_SYMBOL_KIND_STRING]: 'string',
  [LspSymbolKind.LSP_SYMBOL_KIND_NUMBER]: 'number',
  [LspSymbolKind.LSP_SYMBOL_KIND_BOOLEAN]: 'boolean',
  [LspSymbolKind.LSP_SYMBOL_KIND_ARRAY]: 'array',
  [LspSymbolKind.LSP_SYMBOL_KIND_OBJECT]: 'object',
  [LspSymbolKind.LSP_SYMBOL_KIND_KEY]: 'key',
  [LspSymbolKind.LSP_SYMBOL_KIND_NULL]: 'null',
  [LspSymbolKind.LSP_SYMBOL_KIND_ENUM_MEMBER]: 'enumMember',
  [LspSymbolKind.LSP_SYMBOL_KIND_STRUCT]: 'struct',
  [LspSymbolKind.LSP_SYMBOL_KIND_EVENT]: 'event',
  [LspSymbolKind.LSP_SYMBOL_KIND_OPERATOR]: 'operator',
  [LspSymbolKind.LSP_SYMBOL_KIND_TYPE_PARAMETER]: 'typeParameter',
};

function getSymbolKindName(kind: LspSymbolKind): string {
  return SYMBOL_KIND_NAMES[kind] ?? 'unknown';
}

// ============================================================================
// Input Schema
// ============================================================================

function createLspToolsInputSchema(_libraries: LibrarySpec[]) {
  return z.object({
    mode: z
      .enum(['workspaceSymbol', 'hover', 'goToDefinition', 'findReferences', 'documentSymbol'])
      .describe('LSP operation to perform'),

    // For workspaceSymbol mode
    query: z
      .string()
      .optional()
      .describe('(workspaceSymbol mode) Symbol name to search for. Partial match supported.'),

    // For position-based operations (hover, goToDefinition, findReferences)
    filePath: z
      .string()
      .optional()
      .describe('(hover/goToDefinition/findReferences/documentSymbol mode) Absolute path to the file'),

    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('(hover/goToDefinition/findReferences mode) Line number (1-based)'),

    character: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('(hover/goToDefinition/findReferences mode) Character offset (0-based)'),

    // Options
    includeDeclaration: z
      .boolean()
      .default(true)
      .optional()
      .describe('(findReferences mode) Include the declaration in results'),

    // Pagination for workspaceSymbol
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .default(20)
      .optional()
      .describe('(workspaceSymbol mode) Maximum number of results to return'),
  });
}

// ============================================================================
// Result Formatting
// ============================================================================

function formatWorkspaceSymbolResult(result: LspWorkspaceSymbolResult): string {
  if (result.symbols.length === 0) {
    return `No symbols found matching the query.

TIP: workspaceSymbol only finds top-level exports (classes, interfaces, functions).
- If searching for a METHOD, first find the CLASS that contains it
- Then use documentSymbol on the class file to see all its methods`;
  }

  const lines: string[] = [
    `Found ${result.totalMatches} symbol(s):`,
    '',
  ];

  let hasClasses = false;
  for (const sym of result.symbols) {
    const kindName = getSymbolKindName(sym.kind);
    const container = sym.containerName ? ` (in ${sym.containerName})` : '';
    const location = `${sym.location.uri}:${sym.location.range.startLine}`;

    lines.push(`- **${sym.name}** [${kindName}]${container}`);
    lines.push(`  Library: ${sym.library}`);
    lines.push(`  Location: ${location}`);
    lines.push('');

    // Track if we found any classes
    if (sym.kind === LspSymbolKind.LSP_SYMBOL_KIND_CLASS) {
      hasClasses = true;
    }
  }

  // Add hint for classes about using documentSymbol to find methods
  if (hasClasses) {
    lines.push('---');
    lines.push('TIP: To see methods of a class, use documentSymbol with the file path from Location above.');
  }

  return lines.join('\n');
}

function formatHoverResult(result: LspHoverResult): string {
  if (!result.contents) {
    return 'No hover information available at this position.';
  }

  return result.contents;
}

function formatLocationsResult(locations: LspLocation[], operation: string): string {
  if (locations.length === 0) {
    return `No ${operation} found.`;
  }

  const lines: string[] = [
    `Found ${locations.length} location(s):`,
    '',
  ];

  for (const loc of locations) {
    const uri = loc.uri.startsWith('file://') ? loc.uri.slice(7) : loc.uri;
    lines.push(`- ${uri}:${loc.range.startLine}:${loc.range.startCharacter}`);
  }

  return lines.join('\n');
}

function formatDocumentSymbolResult(symbols: LspDocumentSymbol[]): string {
  if (symbols.length === 0) {
    return 'No symbols found in the document.';
  }

  const lines: string[] = [
    `Found ${symbols.length} top-level symbol(s):`,
    '',
  ];

  function formatSymbol(sym: LspDocumentSymbol, indent: number): void {
    const prefix = '  '.repeat(indent);
    const kindName = getSymbolKindName(sym.kind);
    const detail = sym.detail ? `: ${sym.detail}` : '';

    lines.push(`${prefix}- **${sym.name}** [${kindName}]${detail}`);
    lines.push(`${prefix}  Line ${sym.range.startLine}-${sym.range.endLine}`);

    for (const child of sym.children) {
      formatSymbol(child, indent + 1);
    }
  }

  for (const sym of symbols) {
    formatSymbol(sym, 0);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Creation
// ============================================================================

/**
 * Format libraries for display in tool description.
 */
function formatLibrariesForDescription(libraries: LibrarySpec[]): string {
  return libraries
    .map((l) => (l.description ? `${l.name} (${l.description})` : l.name))
    .join(', ');
}

/**
 * Create the LSP tools MCP tool definition.
 */
export function createLspToolsTool(
  config: LspToolsRuntimeConfig,
  sandboxClient: SandboxClient
): ToolDefinition {
  const inputSchema = createLspToolsInputSchema(config.libraries);
  const indexedLibraries = formatLibrariesForDescription(config.libraries);

  return {
    name: 'prodisco.lsp',
    description: `Language Server Protocol operations for code intelligence.

INDEXED: ${indexedLibraries}

MODES:
- workspaceSymbol: Search for symbols by name across the workspace
- hover: Get type information and documentation at a position
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- documentSymbol: List all symbols in a document

WORKFLOW:
1. Use workspaceSymbol to find APIs by name
2. Use hover to get detailed type info and docs
3. Use goToDefinition to navigate to source
4. Use findReferences to see usage patterns
5. Use documentSymbol to explore file structure

IMPORTANT - Finding class methods:
- workspaceSymbol only finds TOP-LEVEL exports (classes, interfaces, functions, constants)
- Class METHODS are NOT findable via workspaceSymbol
- To find methods: first find the class via workspaceSymbol, then use documentSymbol on the class file
- Example: search for "Client" or "Manager" class, then documentSymbol on that file to see all methods`,

    schema: inputSchema,

    async execute(input: z.infer<typeof inputSchema>) {
      const { mode, query, filePath, line, character, includeDeclaration, limit } = input;

      logger.debug(`LSP ${mode} operation: query=${query}, filePath=${filePath}, line=${line}, character=${character}`);

      try {
        switch (mode) {
          case 'workspaceSymbol': {
            if (!query) {
              return {
                content: [{ type: 'text', text: 'Error: query is required for workspaceSymbol mode' }],
              };
            }

            const result = await sandboxClient.lspWorkspaceSymbol(query, limit);
            const formatted = formatWorkspaceSymbolResult(result);

            return {
              content: [
                { type: 'text', text: formatted },
                { type: 'text', text: '\n---\n' },
                { type: 'text', text: JSON.stringify(result, null, 2) },
              ],
            };
          }

          case 'hover': {
            if (!filePath || line === undefined || character === undefined) {
              return {
                content: [{ type: 'text', text: 'Error: filePath, line, and character are required for hover mode' }],
              };
            }

            const result = await sandboxClient.lspHover(filePath, line, character);
            const formatted = formatHoverResult(result);

            return {
              content: [{ type: 'text', text: formatted }],
            };
          }

          case 'goToDefinition': {
            if (!filePath || line === undefined || character === undefined) {
              return {
                content: [{ type: 'text', text: 'Error: filePath, line, and character are required for goToDefinition mode' }],
              };
            }

            const locations = await sandboxClient.lspGoToDefinition(filePath, line, character);
            const formatted = formatLocationsResult(locations, 'definitions');

            return {
              content: [
                { type: 'text', text: formatted },
                { type: 'text', text: '\n---\n' },
                { type: 'text', text: JSON.stringify(locations, null, 2) },
              ],
            };
          }

          case 'findReferences': {
            if (!filePath || line === undefined || character === undefined) {
              return {
                content: [{ type: 'text', text: 'Error: filePath, line, and character are required for findReferences mode' }],
              };
            }

            const locations = await sandboxClient.lspFindReferences(
              filePath,
              line,
              character,
              includeDeclaration ?? true
            );
            const formatted = formatLocationsResult(locations, 'references');

            return {
              content: [
                { type: 'text', text: formatted },
                { type: 'text', text: '\n---\n' },
                { type: 'text', text: JSON.stringify(locations, null, 2) },
              ],
            };
          }

          case 'documentSymbol': {
            if (!filePath) {
              return {
                content: [{ type: 'text', text: 'Error: filePath is required for documentSymbol mode' }],
              };
            }

            const symbols = await sandboxClient.lspDocumentSymbol(filePath);
            const formatted = formatDocumentSymbolResult(symbols);

            return {
              content: [
                { type: 'text', text: formatted },
                { type: 'text', text: '\n---\n' },
                { type: 'text', text: JSON.stringify(symbols, null, 2) },
              ],
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown mode: ${mode}` }],
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`LSP ${mode} error: ${message}`);

        return {
          content: [{ type: 'text', text: `LSP error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
