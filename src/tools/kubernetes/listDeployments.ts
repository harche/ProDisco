import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListDeploymentsInputSchema = z.object({
  namespace: z.string().min(1).optional().describe('Namespace to list deployments from (all namespaces if omitted)'),
  labelSelector: z.string().optional().describe('Label selector to filter deployments'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of deployments to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListDeploymentsInput = z.infer<typeof ListDeploymentsInputSchema>;

export interface ListDeploymentsResult {
  apiVersion?: string;
  kind?: string;
  metadata?: { resourceVersion?: string; continue?: string; _continue?: string };
  items: Array<{
    metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
    spec?: { replicas?: number; selector?: { matchLabels?: Record<string, string> }; [key: string]: unknown };
    status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number; [key: string]: unknown };
  }>;
}

export const listDeploymentsTool: ToolDefinition<ListDeploymentsResult, typeof ListDeploymentsInputSchema> = {
  name: 'kubernetes.listDeployments',
  description: 'List deployments in a namespace. Returns a DeploymentList with items array containing Deployment objects.',
  schema: ListDeploymentsInputSchema,
  async execute(input) {
    return await listResources('apps/v1', 'Deployment', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    }) as ListDeploymentsResult;
  },
};

