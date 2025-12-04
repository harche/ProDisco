/**
 * Kubernetes tool metadata
 *
 * Exports:
 * - searchTools: API method discovery (mode: 'methods'), type definitions (mode: 'types'),
 *   script search (mode: 'scripts'), and Prometheus methods (mode: 'prometheus')
 * - runSandbox: Execute TypeScript scripts in a sandboxed environment
 */

import { searchToolsTool } from './searchTools.js';
import { runSandboxTool } from './runSandbox.js';

export const kubernetesToolMetadata = [
  {
    tool: searchToolsTool,
    sourceModulePath: './searchTools.ts',
  },
  {
    tool: runSandboxTool,
    sourceModulePath: './runSandbox.ts',
  },
];
