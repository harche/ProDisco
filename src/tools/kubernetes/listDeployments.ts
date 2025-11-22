import type { V1Deployment } from '@kubernetes/client-node';
import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import { DeploymentSummarySchema, summarizeDeployment } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const ListDeploymentsInputSchema = z.object({
  namespace: z.string().min(1).optional(),
  labelSelector: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  continueToken: z.string().optional(),
});

export type ListDeploymentsInput = z.infer<typeof ListDeploymentsInputSchema>;

export const ListDeploymentsResultSchema = z.object({
  namespace: z.string().optional(),
  items: z.array(DeploymentSummarySchema),
  continueToken: z.string().optional(),
  totalItems: z.number(),
});

export type ListDeploymentsResult = z.infer<typeof ListDeploymentsResultSchema>;

export const listDeploymentsTool: ToolDefinition<ListDeploymentsResult, typeof ListDeploymentsInputSchema> = {
  name: 'kubernetes.listDeployments',
  description: 'List deployments with replica and condition summaries.',
  schema: ListDeploymentsInputSchema,
  resultSchema: ListDeploymentsResultSchema,
  async execute(input) {
    const deployments = await listResources('apps/v1', 'Deployment', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    });

    const items = (deployments.items as V1Deployment[]).map((deployment) =>
      summarizeDeployment(deployment),
    );

    const continueToken =
      deployments.metadata?._continue ?? (deployments.metadata as { continue?: string })?.continue;

    return {
      namespace: input.namespace,
      items,
      totalItems: items.length,
      continueToken,
    };
  },
};

