import type { V1Pod } from '@kubernetes/client-node';
import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import { summarizePod } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ListPodsInputSchema = z.object({
  namespace: z.string().min(1).optional(),
  labelSelector: z.string().optional(),
  fieldSelector: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  continueToken: z.string().optional(),
});

type ListPodsResult = {
  namespace?: string;
  items: ReturnType<typeof summarizePod>[];
  continueToken?: string;
  totalItems: number;
};

export const listPodsTool: ToolDefinition<ListPodsResult, typeof ListPodsInputSchema> = {
  name: 'kubernetes.listPods',
  description: 'List pods in a namespace with summarized status information.',
  schema: ListPodsInputSchema,
  async execute(input) {
    const result = await listResources('v1', 'Pod', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      fieldSelector: input.fieldSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    });

    const items = (result.items as V1Pod[]).map((pod) => summarizePod(pod));

    const continueToken = result.metadata?._continue ?? (result.metadata as { continue?: string })?.continue;

    return {
      namespace: input.namespace,
      items,
      continueToken,
      totalItems: items.length,
    };
  },
};

