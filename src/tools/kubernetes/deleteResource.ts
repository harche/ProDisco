import type { KubernetesObject } from '@kubernetes/client-node';
import { z } from 'zod';

import { deleteResource as deleteKubeResource } from '../../kube/client.js';
import { parseManifests } from '../../util/manifest.js';
import { summarizeMetadata } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ManifestSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
]);

const DeleteResourceInputSchema = z
  .object({
    manifest: ManifestSchema.optional(),
    apiVersion: z.string().optional(),
    kind: z.string().optional(),
    name: z.string().optional(),
    namespace: z.string().optional(),
    dryRun: z.boolean().optional(),
    gracePeriodSeconds: z.number().int().nonnegative().optional(),
    propagationPolicy: z.enum(['Foreground', 'Background', 'Orphan']).optional(),
  })
  .refine(
    (data) => !!data.manifest || (data.apiVersion && data.kind && data.name),
    'Provide either a manifest or apiVersion/kind/name.',
  );

type DeleteResourceResult = {
  manifest: {
    apiVersion?: string;
    kind?: string;
    metadata: ReturnType<typeof summarizeMetadata>;
  };
  dryRun?: boolean;
};

export const deleteResourceTool: ToolDefinition<DeleteResourceResult, typeof DeleteResourceInputSchema> = {
  name: 'kubernetes.deleteResource',
  description: 'Delete a Kubernetes resource by manifest or apiVersion/kind/name reference.',
  schema: DeleteResourceInputSchema,
  async execute(input) {
    const manifest: KubernetesObject | undefined =
      input.manifest !== undefined
        ? parseManifests(input.manifest)[0]
        : {
            apiVersion: input.apiVersion!,
            kind: input.kind!,
            metadata: { name: input.name!, namespace: input.namespace },
          };

    if (!manifest) {
      throw new Error('Unable to resolve manifest from input');
    }

    await deleteKubeResource(manifest, {
      dryRun: input.dryRun,
      gracePeriodSeconds: input.gracePeriodSeconds,
      propagationPolicy: input.propagationPolicy,
    });

    return {
      manifest: {
        apiVersion: manifest.apiVersion,
        kind: manifest.kind,
        metadata: summarizeMetadata(manifest.metadata as never),
      },
      dryRun: input.dryRun,
    };
  },
};

