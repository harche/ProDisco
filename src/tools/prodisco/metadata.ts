/**
 * ProDisco tool metadata
 *
 * Exports:
 * - lspTools: API discovery via Language Server Protocol (workspaceSymbol, hover, goToDefinition, findReferences, documentSymbol)
 * - runSandbox: Execute TypeScript scripts in a sandboxed environment
 *
 * Note: Tools are created dynamically in server.ts with runtime configuration.
 * This module provides static metadata for documentation/tooling purposes.
 */

import { runSandboxTool } from './runSandbox.js';

export const prodiscoToolMetadata = [
  {
    name: 'prodisco.lsp',
    description: 'API discovery via Language Server Protocol',
    sourceModulePath: './lspTools.ts',
  },
  {
    tool: runSandboxTool,
    sourceModulePath: './runSandbox.ts',
  },
];
