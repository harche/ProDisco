import { searchToolsTool } from './searchTools.js';
import type { AnyToolDefinition } from '../types.js';
import { kubernetesToolMetadata } from './metadata.js';

export const kubernetesTools: AnyToolDefinition[] = [
  searchToolsTool,
  ...kubernetesToolMetadata.map((entry) => entry.tool),
];

export { kubernetesToolMetadata };


