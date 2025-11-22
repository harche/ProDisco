import { z } from 'zod';

import { listCustomResources as listCustomResourcesApi } from '../../kube/client.js';
import { MetadataSummarySchema, summarizeMetadata } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

export const ListCustomResourcesInputSchema = z.object({
  group: z.string().min(1),
  version: z.string().min(1),
  plural: z.string().min(1),
  namespace: z.string().optional(),
  labelSelector: z.string().optional(),
  fieldSelector: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  continueToken: z.string().optional(),
  includeRaw: z.boolean().default(false).optional(),
});

export type ListCustomResourcesInput = z.infer<typeof ListCustomResourcesInputSchema>;

const CustomResourceSummarySchema = z.object({
  apiVersion: z.string().optional(),
  kind: z.string().optional(),
  metadata: MetadataSummarySchema,
});

export const ListCustomResourcesResultSchema = z.object({
  items: z.array(CustomResourceSummarySchema),
  continueToken: z.string().optional(),
  totalItems: z.number(),
  raw: z.unknown().optional(),
});

export type ListCustomResourcesResult = z.infer<typeof ListCustomResourcesResultSchema>;

export const listCustomResourcesTool: ToolDefinition<ListCustomResourcesResult, typeof ListCustomResourcesInputSchema> = {
  name: 'kubernetes.listCustomResources',
  description: 'List custom resources (CRDs) by specifying group/version/plural.',
  schema: ListCustomResourcesInputSchema,
  resultSchema: ListCustomResourcesResultSchema,
  async execute(input) {
    const raw = (await listCustomResourcesApi(
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
    )) as { items?: unknown[]; metadata?: { _continue?: string; continue?: string } };

    const items = Array.isArray(raw.items)
      ? raw.items.map((item) => ({
          apiVersion: (item as { apiVersion?: string }).apiVersion,
          kind: (item as { kind?: string }).kind,
          metadata: summarizeMetadata((item as { metadata?: unknown }).metadata as never),
        }))
      : [];

    const continueToken = raw.metadata?._continue ?? raw.metadata?.continue;

    return {
      items,
      totalItems: items.length,
      continueToken,
      raw: input.includeRaw ? raw : undefined,
    };
  },
};

