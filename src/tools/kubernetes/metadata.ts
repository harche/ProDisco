/**
 * Kubernetes tool metadata
 * 
 * Exports searchTools for discovering API methods and getTypeDefinition
 * for getting TypeScript type definitions.
 */

import { searchToolsTool } from './searchTools.js';
import { getTypeDefinitionTool } from './typeDefinitions.js';

export const kubernetesToolMetadata = [
  {
    tool: searchToolsTool,
    sourceModulePath: './searchTools.ts',
  },
  {
    tool: getTypeDefinitionTool,
    sourceModulePath: './typeDefinitions.ts',
  },
];
