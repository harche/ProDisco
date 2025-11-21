import { z } from 'zod';

import { getPodLogs } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

const GetPodLogsInputSchema = z.object({
  namespace: z.string().min(1),
  podName: z.string().min(1),
  container: z.string().optional(),
  tailLines: z.number().int().positive().max(2000).default(200).optional(),
  timestamps: z.boolean().default(true).optional(),
  previous: z.boolean().default(false).optional(),
});

type GetPodLogsResult = {
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
  logs: string;
};

export const getPodLogsTool: ToolDefinition<GetPodLogsResult, typeof GetPodLogsInputSchema> = {
  name: 'kubernetes.getPodLogs',
  description: 'Stream recent pod logs (tail by default) for troubleshooting.',
  schema: GetPodLogsInputSchema,
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

