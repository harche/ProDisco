import { z } from 'zod';

import { applyManifest as applyKubeManifest } from '../../kube/client.js';
import { parseManifests } from '../../util/manifest.js';
import { MetadataSummarySchema, summarizeMetadata } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ManifestSchema = z.union([
  z.string().min(1, 'Manifest string cannot be empty'),
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);

export const ApplyManifestInputSchema = z.object({
  manifest: ManifestSchema,
  dryRun: z.boolean().optional(),
  fieldManager: z.string().optional(),
  forceConflicts: z.boolean().optional(),
});

export type ApplyManifestInput = z.infer<typeof ApplyManifestInputSchema>;

const AppliedResourceSchema = z.object({
  apiVersion: z.string().optional(),
  kind: z.string().optional(),
  metadata: MetadataSummarySchema,
});

export const ApplyManifestResultSchema = z.object({
  applied: z.array(AppliedResourceSchema),
});

export type ApplyManifestResult = z.infer<typeof ApplyManifestResultSchema>;

export const applyManifestTool: ToolDefinition<ApplyManifestResult, typeof ApplyManifestInputSchema> = {
  name: 'kubernetes.applyManifest',
  description:
    'Create or update resources using server-side apply. Accepts YAML or JSON, single or multi-doc.',
  schema: ApplyManifestInputSchema,
  resultSchema: ApplyManifestResultSchema,
  async execute(input) {
    const manifests = parseManifests(input.manifest);
    const applied = [];

    for (const manifest of manifests) {
      const result = await applyKubeManifest({
        manifest,
        dryRun: input.dryRun,
        fieldManager: input.fieldManager,
        forceConflicts: input.forceConflicts,
      });

      applied.push({
        apiVersion: result.apiVersion,
        kind: result.kind,
        metadata: summarizeMetadata(result.metadata),
      });
    }

    return { applied };
  },
};

