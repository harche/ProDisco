import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListServicesInputSchema = z.object({
  namespace: z.string().min(1).optional().describe('Namespace to list services from (all namespaces if omitted)'),
  labelSelector: z.string().optional().describe('Label selector to filter services'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of services to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListServicesInput = z.infer<typeof ListServicesInputSchema>;

export interface ListServicesResult {
  apiVersion?: string;
  kind?: string;
  metadata?: { resourceVersion?: string; continue?: string; _continue?: string };
  items: Array<{
    metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
    spec?: {
      type?: string;
      selector?: Record<string, string>;
      clusterIP?: string;
      ports?: Array<{ name?: string; protocol?: string; port: number; targetPort?: number | string }>;
    };
  }>;
}

export const listServicesTool: ToolDefinition<ListServicesResult, typeof ListServicesInputSchema> = {
  name: 'kubernetes.listServices',
  description: 'List services in a namespace. Returns a ServiceList with items array containing Service objects.',
  schema: ListServicesInputSchema,
  async execute(input) {
    return await listResources('v1', 'Service', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    }) as ListServicesResult;
  },
};

