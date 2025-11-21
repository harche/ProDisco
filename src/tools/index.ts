import type { AnyToolDefinition } from './types.js';
import { kubernetesTools } from './kubernetes/index.js';

export const tools: AnyToolDefinition[] = [...kubernetesTools];

