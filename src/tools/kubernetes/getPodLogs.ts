import { z } from 'zod';

import { getPodLogs } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetPodLogsInputSchema = z.object({
  namespace: z.string().min(1),
  podName: z.string().min(1),
  container: z.string().optional(),
  tailLines: z.number().int().positive().max(2000).default(200).optional(),
  timestamps: z.boolean().default(true).optional(),
  previous: z.boolean().default(false).optional(),
});

export type GetPodLogsInput = z.infer<typeof GetPodLogsInputSchema>;

export const GetPodLogsResultSchema = z.object({
  namespace: z.string(),
  podName: z.string(),
  container: z.string().optional(),
  tailLines: z.number().optional(),
  logs: z.string(),
});

export type GetPodLogsResult = z.infer<typeof GetPodLogsResultSchema>;

export const getPodLogsTool: ToolDefinition<GetPodLogsResult, typeof GetPodLogsInputSchema> = {
  name: 'kubernetes.getPodLogs',
  description: 'Stream recent pod logs (tail by default) for troubleshooting.',
  schema: GetPodLogsInputSchema,
  resultSchema: GetPodLogsResultSchema,
  async execute(input) {
    const logs = await getPodLogs({
      namespace: input.namespace,
      podName: input.podName,
      container: input.container,
      tailLines: input.tailLines,
      timestamps: input.timestamps,
      previous: input.previous,
    });

    return {
      namespace: input.namespace,
      podName: input.podName,
      container: input.container,
      tailLines: input.tailLines,
      logs,
    };
  },
};

