import type { AnyToolDefinition } from '../types.js';
import { prodiscoToolMetadata } from './metadata.js';

export const prodiscoTools: AnyToolDefinition[] = [
  ...prodiscoToolMetadata.map((entry) => entry.tool),
];

export { prodiscoToolMetadata };


