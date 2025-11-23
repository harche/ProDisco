import { z } from 'zod';

import { deleteResource as deleteKubeResource } from '../../kube/client.js';
import { parseManifests } from '../../util/manifest.js';
import type { ToolDefinition } from '../types.js';

const ManifestSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
]);

export const DeleteResourceInputSchema = z
  .object({
    manifest: ManifestSchema.optional().describe('YAML or JSON manifest of resource to delete'),
    apiVersion: z.string().optional().describe('API version (e.g., v1, apps/v1)'),
    kind: z.string().optional().describe('Resource kind (e.g., Pod, Deployment)'),
    name: z.string().optional().describe('Resource name'),
    namespace: z.string().optional().describe('Resource namespace'),
    dryRun: z.boolean().optional().describe('Perform a dry run without actually deleting'),
    gracePeriodSeconds: z.number().int().nonnegative().optional().describe('Grace period in seconds before forcing deletion'),
    propagationPolicy: z.enum(['Foreground', 'Background', 'Orphan']).optional().describe('Deletion propagation policy'),
  })
  .refine(
    (data) => !!data.manifest || (data.apiVersion && data.kind && data.name),
    'Provide either a manifest or apiVersion/kind/name.',
  );

export type DeleteResourceInput = z.infer<typeof DeleteResourceInputSchema>;

export interface DeleteResourceResult {
  success: true;
  deletedResource: {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
}

export const deleteResourceTool: ToolDefinition<DeleteResourceResult, typeof DeleteResourceInputSchema> = {
  name: 'kubernetes.deleteResource',
  description: 'Delete a Kubernetes resource by manifest or apiVersion/kind/name reference. Returns the deleted resource object.',
  schema: DeleteResourceInputSchema,
  async execute(input) {
    const manifest =
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
      success: true,
      deletedResource: manifest as DeleteResourceResult['deletedResource'],
    };
  },
};

