import type { V1Pod } from '@kubernetes/client-node';
import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import { PodSummarySchema, summarizePod } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const GetPodInputSchema = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  includeRaw: z.boolean().default(false).optional(),
});

export type GetPodInput = z.infer<typeof GetPodInputSchema>;

const ContainerSummarySchema = z.object({
  name: z.string(),
  image: z.string().optional(),
  resources: z.record(z.string(), z.unknown()).optional(),
  ports: z.array(z.record(z.string(), z.unknown())).optional(),
  env: z.array(z.record(z.string(), z.unknown())).optional(),
});

const PodSpecSummarySchema = z.object({
  containers: z.array(ContainerSummarySchema).optional(),
  nodeName: z.string().optional(),
  tolerations: z.array(z.record(z.string(), z.unknown())).optional(),
  serviceAccountName: z.string().optional(),
});

const PodStatusSummarySchema = z.object({
  phase: z.string().optional(),
  podIP: z.string().optional(),
  hostIP: z.string().optional(),
  conditions: z.array(z.record(z.string(), z.unknown())).optional(),
  containerStatuses: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const GetPodResultSchema = z.object({
  summary: PodSummarySchema,
  spec: PodSpecSummarySchema,
  status: PodStatusSummarySchema,
  raw: z.unknown().optional(),
});

export type GetPodResult = {
  summary: ReturnType<typeof summarizePod>;
  spec: Partial<V1Pod['spec']>;
  status: Partial<V1Pod['status']>;
  raw?: V1Pod;
};

export const getPodTool: ToolDefinition<GetPodResult, typeof GetPodInputSchema> = {
  name: 'kubernetes.getPod',
  description: 'Get details for a specific pod.',
  schema: GetPodInputSchema,
  resultSchema: GetPodResultSchema,
  async execute(input) {
    const pod = (await getResource({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: input.name, namespace: input.namespace },
    })) as V1Pod;

    return {
      summary: summarizePod(pod),
      spec: {
        containers: pod.spec?.containers?.map((container) => ({
          name: container.name,
          image: container.image,
          resources: container.resources,
          ports: container.ports,
          env: container.env,
        })),
        nodeName: pod.spec?.nodeName,
        tolerations: pod.spec?.tolerations,
        serviceAccountName: pod.spec?.serviceAccountName,
      },
      status: {
        phase: pod.status?.phase,
        podIP: pod.status?.podIP,
        hostIP: pod.status?.hostIP,
        conditions: pod.status?.conditions,
        containerStatuses: pod.status?.containerStatuses,
      },
      raw: input.includeRaw ? pod : undefined,
    };
  },
};

