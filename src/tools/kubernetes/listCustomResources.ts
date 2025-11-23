import { z } from 'zod';

import { listCustomResources as listCustomResourcesApi } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListCustomResourcesInputSchema = z.object({
  group: z.string().min(1).describe('API group of the custom resources'),
  version: z.string().min(1).describe('API version of the custom resources'),
  plural: z.string().min(1).describe('Plural name of the custom resource type'),
  namespace: z.string().optional().describe('Namespace to list from (cluster-scoped if omitted)'),
  labelSelector: z.string().optional().describe('Label selector to filter custom resources'),
  fieldSelector: z.string().optional().describe('Field selector to filter custom resources'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of custom resources to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListCustomResourcesInput = z.infer<typeof ListCustomResourcesInputSchema>;

export interface ListCustomResourcesResult {
  apiVersion?: string;
  kind?: string;
  metadata?: { resourceVersion?: string; continue?: string; _continue?: string };
  items: Array<{
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string; [key: string]: unknown };
    spec?: unknown;
    status?: unknown;
    [key: string]: unknown;
  }>;
}

export const listCustomResourcesTool: ToolDefinition<ListCustomResourcesResult, typeof ListCustomResourcesInputSchema> = {
  name: 'kubernetes.listCustomResources',
  description: 'List custom resources (CRDs) by specifying group/version/plural. Returns a KubernetesListObject.',
  schema: ListCustomResourcesInputSchema,
  async execute(input) {
    return (await listCustomResourcesApi(
      {
        group: input.group,
        version: input.version,
        plural: input.plural,
        namespace: input.namespace,
      },
      {
        labelSelector: input.labelSelector,
        fieldSelector: input.fieldSelector,
        limit: input.limit,
        continueToken: input.continueToken,
      },
    )) as ListCustomResourcesResult;
  },
};

