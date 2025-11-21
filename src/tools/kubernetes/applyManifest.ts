import { z } from 'zod';

import { applyManifest as applyKubeManifest } from '../../kube/client.js';
import { parseManifests } from '../../util/manifest.js';
import { summarizeMetadata } from '../../util/summary.js';
import type { ToolDefinition } from '../types.js';

const ManifestSchema = z.union([
  z.string().min(1, 'Manifest string cannot be empty'),
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);

const ApplyManifestInputSchema = z.object({
  manifest: ManifestSchema,
  dryRun: z.boolean().optional(),
  fieldManager: z.string().optional(),
  forceConflicts: z.boolean().optional(),
});

type ApplyManifestResult = {
  applied: Array<{
    apiVersion?: string;
    kind?: string;
    metadata: ReturnType<typeof summarizeMetadata>;
  }>;
};

export const applyManifestTool: ToolDefinition<ApplyManifestResult, typeof ApplyManifestInputSchema> = {
  name: 'kubernetes.applyManifest',
  description:
    'Create or update resources using server-side apply. Accepts YAML or JSON, single or multi-doc.',
  schema: ApplyManifestInputSchema,
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

