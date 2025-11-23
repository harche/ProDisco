import { z } from 'zod';

import { getCustomResource as getCustomResourceApi } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetCustomResourceInputSchema = z.object({
  group: z.string().min(1).describe('API group of the custom resource'),
  version: z.string().min(1).describe('API version of the custom resource'),
  plural: z.string().min(1).describe('Plural name of the custom resource'),
  name: z.string().min(1).describe('Name of the custom resource'),
  namespace: z.string().optional().describe('Namespace of the custom resource (cluster-scoped if omitted)'),
});

export type GetCustomResourceInput = z.infer<typeof GetCustomResourceInputSchema>;

export interface GetCustomResourceResult {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; uid?: string; labels?: Record<string, string>; [key: string]: unknown };
  spec?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

export const getCustomResourceTool: ToolDefinition<GetCustomResourceResult, typeof GetCustomResourceInputSchema> = {
  name: 'kubernetes.getCustomResource',
  description: 'Get a custom resource (CRD instance) by group/version/plural/name. Returns a KubernetesObject.',
  schema: GetCustomResourceInputSchema,
  async execute(input) {
    return (await getCustomResourceApi({
      group: input.group,
      version: input.version,
      plural: input.plural,
      namespace: input.namespace,
      name: input.name,
    })) as GetCustomResourceResult;
  },
};

