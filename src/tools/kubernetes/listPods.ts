import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListPodsInputSchema = z.object({
  namespace: z.string().min(1).optional().describe('Namespace to list pods from (all namespaces if omitted)'),
  labelSelector: z.string().optional().describe('Label selector to filter pods'),
  fieldSelector: z.string().optional().describe('Field selector to filter pods'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of pods to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListPodsInput = z.infer<typeof ListPodsInputSchema>;

export interface ListPodsResult {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    resourceVersion?: string;
    continue?: string;
    _continue?: string;
  };
  items: Array<{
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
      containers: Array<{ name: string; image?: string; [key: string]: unknown }>;
      nodeName?: string;
      [key: string]: unknown;
    };
    status?: {
      phase?: string;
      podIP?: string;
      hostIP?: string;
      containerStatuses?: Array<{ name?: string; ready?: boolean; restartCount?: number; [key: string]: unknown }>;
      conditions?: Array<{ type?: string; status?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
  }>;
}

export const listPodsTool: ToolDefinition<ListPodsResult, typeof ListPodsInputSchema> = {
  name: 'kubernetes.listPods',
  description: 'List pods in a namespace. Returns a PodList with items array containing Pod objects.',
  schema: ListPodsInputSchema,
  async execute(input) {
    return await listResources('v1', 'Pod', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      fieldSelector: input.fieldSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    }) as ListPodsResult;
  },
};

