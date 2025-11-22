import type { V1Deployment } from '@kubernetes/client-node';
import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import { DeploymentSummarySchema, summarizeDeployment } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const GetDeploymentInputSchema = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  includeRaw: z.boolean().default(false).optional(),
});

export type GetDeploymentInput = z.infer<typeof GetDeploymentInputSchema>;

const DeploymentSpecSummarySchema = z.object({
  replicas: z.number().optional(),
  strategy: z.record(z.string(), z.unknown()).optional(),
  selector: z.record(z.string(), z.unknown()).optional(),
  template: z
    .object({
      metadata: z.record(z.string(), z.unknown()).optional(),
      spec: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const DeploymentStatusSummarySchema = z.object({
  readyReplicas: z.number().optional(),
  availableReplicas: z.number().optional(),
  updatedReplicas: z.number().optional(),
  conditions: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const GetDeploymentResultSchema = z.object({
  summary: DeploymentSummarySchema,
  spec: DeploymentSpecSummarySchema,
  status: DeploymentStatusSummarySchema,
  raw: z.unknown().optional(),
});

export type GetDeploymentResult = {
  summary: ReturnType<typeof summarizeDeployment>;
  spec: Partial<V1Deployment['spec']>;
  status: Partial<V1Deployment['status']>;
  raw?: V1Deployment;
};

export const getDeploymentTool: ToolDefinition<GetDeploymentResult, typeof GetDeploymentInputSchema> = {
  name: 'kubernetes.getDeployment',
  description: 'Retrieve a deployment and summarize its status and spec.',
  schema: GetDeploymentInputSchema,
  resultSchema: GetDeploymentResultSchema,
  async execute(input) {
    const deployment = (await getResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { namespace: input.namespace, name: input.name },
    })) as V1Deployment;

    return {
      summary: summarizeDeployment(deployment),
      spec: {
        replicas: deployment.spec?.replicas,
        strategy: deployment.spec?.strategy,
        selector: deployment.spec?.selector,
        template: {
          metadata: deployment.spec?.template?.metadata,
          spec: deployment.spec?.template?.spec,
        },
      },
      status: {
        readyReplicas: deployment.status?.readyReplicas,
        availableReplicas: deployment.status?.availableReplicas,
        updatedReplicas: deployment.status?.updatedReplicas,
        conditions: deployment.status?.conditions,
      },
      raw: input.includeRaw ? deployment : undefined,
    };
  },
};

