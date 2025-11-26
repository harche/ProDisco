/**
 * Kubernetes tool metadata
 *
 * Exports searchTools which provides both API method discovery (mode: 'methods')
 * and TypeScript type definitions (mode: 'types').
 */

import { searchToolsTool } from './searchTools.js';

export const kubernetesToolMetadata = [
  {
    tool: searchToolsTool,
    sourceModulePath: './searchTools.ts',
  },
];
