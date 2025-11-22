import type { V1Service } from '@kubernetes/client-node';
import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import { ServiceSummarySchema, summarizeService } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const ListServicesInputSchema = z.object({
  namespace: z.string().min(1).optional(),
  labelSelector: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  continueToken: z.string().optional(),
});

export type ListServicesInput = z.infer<typeof ListServicesInputSchema>;

export const ListServicesResultSchema = z.object({
  namespace: z.string().optional(),
  items: z.array(ServiceSummarySchema),
  continueToken: z.string().optional(),
  totalItems: z.number(),
});

export type ListServicesResult = z.infer<typeof ListServicesResultSchema>;

export const listServicesTool: ToolDefinition<ListServicesResult, typeof ListServicesInputSchema> = {
  name: 'kubernetes.listServices',
  description: 'List services with their ports and selectors.',
  schema: ListServicesInputSchema,
  resultSchema: ListServicesResultSchema,
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

