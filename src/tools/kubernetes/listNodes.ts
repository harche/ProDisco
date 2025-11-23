import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListNodesInputSchema = z.object({
  labelSelector: z.string().optional().describe('Label selector to filter nodes'),
  fieldSelector: z.string().optional().describe('Field selector to filter nodes'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of nodes to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListNodesInput = z.infer<typeof ListNodesInputSchema>;

export interface ListNodesResult {
  apiVersion?: string;
  kind?: string;
  metadata?: { resourceVersion?: string; continue?: string; _continue?: string };
  items: Array<{
    metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    spec?: { podCIDR?: string; taints?: Array<{ key?: string; value?: string; effect?: string }> };
    status?: {
      capacity?: Record<string, string>;
      allocatable?: Record<string, string>;
      conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
      addresses?: Array<{ type?: string; address?: string }>;
      nodeInfo?: {
        kubeletVersion?: string;
        osImage?: string;
        containerRuntimeVersion?: string;
        architecture?: string;
        operatingSystem?: string;
      };
    };
  }>;
}

export const listNodesTool: ToolDefinition<ListNodesResult, typeof ListNodesInputSchema> = {
  name: 'kubernetes.listNodes',
  description: 'List cluster nodes. Returns a NodeList with items array containing Node objects with metadata, spec, and status (capacity, allocatable, conditions, addresses, nodeInfo).',
  schema: ListNodesInputSchema,
  async execute(input) {
    return await listResources('v1', 'Node', {
      labelSelector: input.labelSelector,
      fieldSelector: input.fieldSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    }) as ListNodesResult;
  },
};

