import type { V1Service } from '@kubernetes/client-node';
import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import { ServiceSummarySchema, summarizeService } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const GetServiceInputSchema = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  includeRaw: z.boolean().default(false).optional(),
});

export type GetServiceInput = z.infer<typeof GetServiceInputSchema>;

const ServiceSpecSummarySchema = z.object({
  type: z.string().optional(),
  selector: z.record(z.string()).optional(),
  clusterIP: z.string().optional(),
  ports: z.array(z.record(z.string(), z.unknown())).optional(),
  externalIPs: z.array(z.string()).optional(),
});

const ServiceStatusSummarySchema = z.record(z.string(), z.unknown()).optional();

export const GetServiceResultSchema = z.object({
  summary: ServiceSummarySchema,
  spec: ServiceSpecSummarySchema,
  status: ServiceStatusSummarySchema,
  raw: z.unknown().optional(),
});

export type GetServiceResult = {
  summary: ReturnType<typeof summarizeService>;
  spec: Partial<V1Service['spec']>;
  status: Partial<V1Service['status']>;
  raw?: V1Service;
};

export const getServiceTool: ToolDefinition<GetServiceResult, typeof GetServiceInputSchema> = {
  name: 'kubernetes.getService',
  description: 'Get details for a Service including ports and selectors.',
  schema: GetServiceInputSchema,
  resultSchema: GetServiceResultSchema,
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

