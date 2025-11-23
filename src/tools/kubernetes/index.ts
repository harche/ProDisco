import type { AnyToolDefinition } from '../types.js';
import { kubernetesToolMetadata } from './metadata.js';

export const kubernetesTools: AnyToolDefinition[] = [
  ...kubernetesToolMetadata.map((entry) => entry.tool),
];

export { kubernetesToolMetadata };


