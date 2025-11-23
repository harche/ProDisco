import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetDeploymentInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the deployment'),
  name: z.string().min(1).describe('Name of the deployment'),
});

export type GetDeploymentInput = z.infer<typeof GetDeploymentInputSchema>;

export interface GetDeploymentResult {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
      spec?: { containers: Array<{ name: string; image?: string; [key: string]: unknown }>; [key: string]: unknown };
    };
    strategy?: {
      type?: string;
      rollingUpdate?: { maxSurge?: number | string; maxUnavailable?: number | string };
    };
  };
  status?: {
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

export const getDeploymentTool: ToolDefinition<GetDeploymentResult, typeof GetDeploymentInputSchema> = {
  name: 'kubernetes.getDeployment',
  description: 'Retrieve a deployment. Returns a Deployment object with metadata, spec (replicas, selector, template, strategy), and status.',
  schema: GetDeploymentInputSchema,
  async execute(input) {
    return (await getResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { namespace: input.namespace, name: input.name },
    })) as GetDeploymentResult;
  },
};

