import { z } from 'zod';

import { getPodLogs } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetPodLogsInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the pod'),
  podName: z.string().min(1).describe('Name of the pod'),
  container: z.string().optional().describe('Container name (defaults to first container if not specified)'),
  tailLines: z.number().int().positive().max(2000).default(200).optional().describe('Number of lines to tail from the end of logs'),
  timestamps: z.boolean().default(true).optional().describe('Include timestamps in log output'),
  previous: z.boolean().default(false).optional().describe('Get logs from previous terminated container'),
});

export type GetPodLogsInput = z.infer<typeof GetPodLogsInputSchema>;

export type GetPodLogsResult = string;

export const getPodLogsTool: ToolDefinition<GetPodLogsResult, typeof GetPodLogsInputSchema> = {
  name: 'kubernetes.getPodLogs',
  description: 'Get recent pod logs for troubleshooting. Returns log output as a string.',
  schema: GetPodLogsInputSchema,
  async execute(input) {
    return await getPodLogs({
      namespace: input.namespace,
      podName: input.podName,
      container: input.container,
      tailLines: input.tailLines,
      timestamps: input.timestamps,
      previous: input.previous,
    });
  },
};

