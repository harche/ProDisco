import { z } from 'zod';

import { listCustomResources as listCustomResourcesApi } from '../../kube/client.js';
import { summarizeMetadata } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ListCustomResourcesInputSchema = z.object({
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

type ListCustomResourcesResult = {
  items: Array<{
    apiVersion?: string;
    kind?: string;
    metadata: ReturnType<typeof summarizeMetadata>;
  }>;
  continueToken?: string;
  totalItems: number;
  raw?: unknown;
};

export const listCustomResourcesTool: ToolDefinition<ListCustomResourcesResult, typeof ListCustomResourcesInputSchema> = {
  name: 'kubernetes.listCustomResources',
  description: 'List custom resources (CRDs) by specifying group/version/plural.',
  schema: ListCustomResourcesInputSchema,
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

