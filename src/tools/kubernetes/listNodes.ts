import type { V1Node } from '@kubernetes/client-node';
import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import { summarizeNode } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ListNodesInputSchema = z.object({
  labelSelector: z.string().optional(),
  fieldSelector: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  continueToken: z.string().optional(),
});

type ListNodesResult = {
  items: ReturnType<typeof summarizeNode>[];
  continueToken?: string;
  totalItems: number;
};

export const listNodesTool: ToolDefinition<ListNodesResult, typeof ListNodesInputSchema> = {
  name: 'kubernetes.listNodes',
  description: 'List cluster nodes with status summaries.',
  schema: ListNodesInputSchema,
  async execute(input) {
    const nodes = await listResources('v1', 'Node', {
      labelSelector: input.labelSelector,
      fieldSelector: input.fieldSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    });

    const items = (nodes.items as V1Node[]).map((node) => summarizeNode(node));
    const continueToken = nodes.metadata?._continue ?? (nodes.metadata as { continue?: string })?.continue;

    return {
      items,
      totalItems: items.length,
      continueToken,
    };
  },
};

