import type { V1Pod } from '@kubernetes/client-node';
import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import { summarizePod } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const GetPodInputSchema = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  includeRaw: z.boolean().default(false).optional(),
});

type GetPodResult = {
  summary: ReturnType<typeof summarizePod>;
  spec: Partial<V1Pod['spec']>;
  status: Partial<V1Pod['status']>;
  raw?: V1Pod;
};

export const getPodTool: ToolDefinition<GetPodResult, typeof GetPodInputSchema> = {
  name: 'kubernetes.getPod',
  description: 'Get details for a specific pod.',
  schema: GetPodInputSchema,
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

