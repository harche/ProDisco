import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetPodInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the pod'),
  name: z.string().min(1).describe('Name of the pod'),
});

export type GetPodInput = z.infer<typeof GetPodInputSchema>;

export interface GetPodResult {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    containers: Array<{
      name: string;
      image?: string;
      command?: string[];
      args?: string[];
      ports?: Array<{ containerPort?: number; protocol?: string; name?: string }>;
      env?: Array<{ name?: string; value?: string; valueFrom?: unknown }>;
      resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
      volumeMounts?: Array<{ name?: string; mountPath?: string }>;
    }>;
    initContainers?: Array<unknown>;
    nodeName?: string;
    serviceAccountName?: string;
    volumes?: Array<unknown>;
    tolerations?: Array<{ key?: string; operator?: string; value?: string; effect?: string }>;
  };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string }>;
    podIP?: string;
    hostIP?: string;
    containerStatuses?: Array<{ name?: string; ready?: boolean; restartCount?: number; image?: string; state?: unknown }>;
    qosClass?: string;
    startTime?: string;
  };
}

export const getPodTool: ToolDefinition<GetPodResult, typeof GetPodInputSchema> = {
  name: 'kubernetes.getPod',
  description: 'Get details for a specific pod. Returns a Pod object with metadata, spec, and status.',
  schema: GetPodInputSchema,
  async execute(input) {
    return (await getResource({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: input.name, namespace: input.namespace },
    })) as GetPodResult;
  },
};

