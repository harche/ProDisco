import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListPodsInputSchema = z.object({
  namespace: z.string().min(1).optional().describe('Namespace to list pods from (all namespaces if omitted)'),
  labelSelector: z.string().optional().describe('Label selector to filter pods'),
  fieldSelector: z.string().optional().describe('Field selector to filter pods'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of pods to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListPodsInput = z.infer<typeof ListPodsInputSchema>;

/**
 * PodList is a list of Pods.
 */
export interface ListPodsResult {
  /** APIVersion defines the versioned schema of this representation of an object. */
  apiVersion?: string;
  /** Kind is a string value representing the REST resource this object represents. */
  kind?: string;
  /** Standard list metadata. */
  metadata?: {
    /** String that identifies the server's internal version of this object. */
    resourceVersion?: string;
    /** Continue token for pagination. */
    continue?: string;
    /** Continue token for pagination (alternative field name). */
    _continue?: string;
  };
  /** List of pods. */
  items: Array<{
    /** APIVersion defines the versioned schema of this representation of an object. */
    apiVersion?: string;
    /** Kind is a string value representing the REST resource this object represents. */
    kind?: string;
    /** Standard object metadata. */
    metadata?: {
      /** Name must be unique within a namespace. */
      name?: string;
      /** Namespace defines the space within which each name must be unique. */
      namespace?: string;
      /** UID is the unique identifier for this object. */
      uid?: string;
      /** Map of string keys and values that can be used to organize and categorize objects. */
      labels?: Record<string, string>;
      /** Annotations is an unstructured key value map stored with a resource. */
      annotations?: Record<string, string>;
      /** CreationTimestamp is a timestamp representing when this object was created. */
      creationTimestamp?: string;
    };
    /** Specification of the desired behavior of the pod. */
    spec?: {
      /** List of containers belonging to the pod. */
      containers: Array<{
        /** Name of the container. */
        name: string;
        /** Container image name. */
        image?: string;
        [key: string]: unknown;
      }>;
      /** NodeName indicates on which node this pod is scheduled. */
      nodeName?: string;
      [key: string]: unknown;
    };
    /** Most recently observed status of the pod. */
    status?: {
      /** The phase of a Pod is a simple, high-level summary of where the Pod is in its lifecycle. */
      phase?: string;
      /** Pod's IP address. */
      podIP?: string;
      /** IP address of the host to which the pod is assigned. */
      hostIP?: string;
      /** The list has one entry per container in the manifest. */
      containerStatuses?: Array<{
        /** Name of the container. */
        name?: string;
        /** Specifies whether the container has passed its readiness probe. */
        ready?: boolean;
        /** The number of times the container has been restarted. */
        restartCount?: number;
        [key: string]: unknown;
      }>;
      /** Current service state of pod. */
      conditions?: Array<{
        /** Type of condition. */
        type?: string;
        /** Status of the condition (True, False, Unknown). */
        status?: string;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
  }>;
}

export const listPodsTool: ToolDefinition<ListPodsResult, typeof ListPodsInputSchema> = {
  name: 'kubernetes.listPods',
  description: 'List pods in a namespace. Returns a PodList with items array containing Pod objects.',
  schema: ListPodsInputSchema,
  async execute(input) {
    return await listResources('v1', 'Pod', {
      namespace: input.namespace,
      labelSelector: input.labelSelector,
      fieldSelector: input.fieldSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    }) as ListPodsResult;
  },
};

