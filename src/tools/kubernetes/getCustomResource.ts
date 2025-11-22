import { z } from 'zod';

import { getCustomResource as getCustomResourceApi } from '../../kube/client.js';
import { MetadataSummarySchema, summarizeMetadata } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const GetCustomResourceInputSchema = z.object({
  group: z.string().min(1),
  version: z.string().min(1),
  plural: z.string().min(1),
  name: z.string().min(1),
  namespace: z.string().optional(),
  includeRaw: z.boolean().default(false).optional(),
});

export type GetCustomResourceInput = z.infer<typeof GetCustomResourceInputSchema>;

export const GetCustomResourceResultSchema = z.object({
  apiVersion: z.string().optional(),
  kind: z.string().optional(),
  metadata: MetadataSummarySchema,
  spec: z.unknown().optional(),
  status: z.unknown().optional(),
  raw: z.unknown().optional(),
});

export type GetCustomResourceResult = z.infer<typeof GetCustomResourceResultSchema>;

export const getCustomResourceTool: ToolDefinition<GetCustomResourceResult, typeof GetCustomResourceInputSchema> = {
  name: 'kubernetes.getCustomResource',
  description: 'Get a custom resource (CRD instance) by group/version/plural/name.',
  schema: GetCustomResourceInputSchema,
  resultSchema: GetCustomResourceResultSchema,
  async execute(input) {
    const raw = (await getCustomResourceApi({
      group: input.group,
      version: input.version,
      plural: input.plural,
      namespace: input.namespace,
      name: input.name,
    })) as {
      apiVersion?: string;
      kind?: string;
      metadata?: Record<string, unknown>;
      spec?: unknown;
      status?: unknown;
    };

    return {
      apiVersion: raw.apiVersion,
      kind: raw.kind,
      metadata: summarizeMetadata(raw.metadata as never),
      spec: raw.spec,
      status: raw.status,
      raw: input.includeRaw ? raw : undefined,
    };
  },
};

