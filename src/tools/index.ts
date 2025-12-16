import type { AnyToolDefinition } from './types.js';
import { prodiscoTools } from './prodisco/index.js';

export const tools: AnyToolDefinition[] = [...prodiscoTools];

