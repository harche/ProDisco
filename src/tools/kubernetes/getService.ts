import type { V1Service } from '@kubernetes/client-node';
import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import { summarizeService } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const GetServiceInputSchema = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  includeRaw: z.boolean().default(false).optional(),
});

type GetServiceResult = {
  summary: ReturnType<typeof summarizeService>;
  spec: Partial<V1Service['spec']>;
  status: Partial<V1Service['status']>;
  raw?: V1Service;
};

export const getServiceTool: ToolDefinition<GetServiceResult, typeof GetServiceInputSchema> = {
  name: 'kubernetes.getService',
  description: 'Get details for a Service including ports and selectors.',
  schema: GetServiceInputSchema,
  async execute(input) {
    const service = (await getResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { namespace: input.namespace, name: input.name },
    })) as V1Service;

    return {
      summary: summarizeService(service),
      spec: {
        type: service.spec?.type,
        selector: service.spec?.selector,
        clusterIP: service.spec?.clusterIP,
        ports: service.spec?.ports,
        externalIPs: service.spec?.externalIPs,
      },
      status: service.status ?? {},
      raw: input.includeRaw ? service : undefined,
    };
  },
};

