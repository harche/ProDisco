import type { V1Service } from '@kubernetes/client-node';
import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import { summarizeService } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ListServicesInputSchema = z.object({
  namespace: z.string().min(1).optional(),
  labelSelector: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  continueToken: z.string().optional(),
});

type ListServicesResult = {
  namespace?: string;
  items: ReturnType<typeof summarizeService>[];
  continueToken?: string;
  totalItems: number;
};

export const listServicesTool: ToolDefinition<ListServicesResult, typeof ListServicesInputSchema> = {
  name: 'kubernetes.listServices',
  description: 'List services with their ports and selectors.',
  schema: ListServicesInputSchema,
  async execute(input) {
    const services = await listResources('v1', 'Service', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    });

    const items = (services.items as V1Service[]).map((service) => summarizeService(service));

    const continueToken =
      services.metadata?._continue ?? (services.metadata as { continue?: string })?.continue;

    return {
      namespace: input.namespace,
      items,
      totalItems: items.length,
      continueToken,
    };
  },
};

