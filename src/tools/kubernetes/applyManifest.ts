import { z } from 'zod';

import { applyManifest as applyKubeManifest } from '../../kube/client.js';
import { parseManifests } from '../../util/manifest.js';
import type { ToolDefinition } from '../types.js';

const ManifestSchema = z.union([
  z.string().min(1, 'Manifest string cannot be empty'),
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);

export const ApplyManifestInputSchema = z.object({
  manifest: ManifestSchema.describe('YAML or JSON manifest(s) to apply'),
  dryRun: z.boolean().optional().describe('Perform a dry run without actually applying'),
  fieldManager: z.string().optional().describe('Field manager name for server-side apply'),
  forceConflicts: z.boolean().optional().describe('Force apply even if there are conflicts'),
});

export type ApplyManifestInput = z.infer<typeof ApplyManifestInputSchema>;

export type ApplyManifestResult = Array<{
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; [key: string]: unknown };
  spec?: unknown;
  status?: unknown;
  [key: string]: unknown;
}>;

export const applyManifestTool: ToolDefinition<ApplyManifestResult, typeof ApplyManifestInputSchema> = {
  name: 'kubernetes.applyManifest',
  description:
    'Create or update resources using server-side apply. Accepts YAML or JSON, single or multi-doc. Returns array of applied KubernetesObject resources.',
  schema: ApplyManifestInputSchema,
  async execute(input) {
    const manifests = parseManifests(input.manifest);
    const applied: ApplyManifestResult = [];

    for (const manifest of manifests) {
      const result = await applyKubeManifest({
        manifest,
        dryRun: input.dryRun,
        fieldManager: input.fieldManager,
        forceConflicts: input.forceConflicts,
      });

      applied.push(result as ApplyManifestResult[number]);
    }

    return applied;
  },
};

