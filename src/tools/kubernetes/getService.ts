import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetServiceInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the service'),
  name: z.string().min(1).describe('Name of the service'),
});

export type GetServiceInput = z.infer<typeof GetServiceInputSchema>;

export interface GetServiceResult {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    type?: string;
    selector?: Record<string, string>;
    clusterIP?: string;
    ports?: Array<{ name?: string; protocol?: string; port: number; targetPort?: number | string; nodePort?: number }>;
    externalIPs?: string[];
  };
  status?: unknown;
}

export const getServiceTool: ToolDefinition<GetServiceResult, typeof GetServiceInputSchema> = {
  name: 'kubernetes.getService',
  description: 'Get details for a Service. Returns a Service object with metadata, spec (type, selector, clusterIP, ports), and status.',
  schema: GetServiceInputSchema,
  async execute(input) {
    return (await getResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { namespace: input.namespace, name: input.name },
    })) as GetServiceResult;
  },
};

