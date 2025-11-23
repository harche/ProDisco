import { z } from 'zod';

import { listResources } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const ListNodesInputSchema = z.object({
  labelSelector: z.string().optional().describe('Label selector to filter nodes'),
  fieldSelector: z.string().optional().describe('Field selector to filter nodes'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum number of nodes to return'),
  continueToken: z.string().optional().describe('Continue token for pagination'),
});

export type ListNodesInput = z.infer<typeof ListNodesInputSchema>;

/**
 * NodeList is a list of nodes in the cluster.
 */
export interface ListNodesResult {
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
  /** List of nodes. */
  items: Array<{
    /** Standard object metadata. */
    metadata?: {
      /** Name must be unique within a namespace. */
      name?: string;
      /** Map of string keys and values that can be used to organize and categorize objects. */
      labels?: Record<string, string>;
      /** Annotations is an unstructured key value map stored with a resource. */
      annotations?: Record<string, string>;
    };
    /** Spec describes the attributes that a node is created with. */
    spec?: {
      /** PodCIDR represents the pod IP range assigned to the node. */
      podCIDR?: string;
      /** If specified, the node's taints. */
      taints?: Array<{
        /** The taint key to be applied to a node. */
        key?: string;
        /** The taint value corresponding to the taint key. */
        value?: string;
        /** The effect of the taint on pods that do not tolerate the taint (NoSchedule, PreferNoSchedule, NoExecute). */
        effect?: string;
      }>;
    };
    /** Most recently observed status of the node. */
    status?: {
      /** Capacity represents the total resources of a node. */
      capacity?: Record<string, string>;
      /** Allocatable represents the resources of a node that are available for scheduling. */
      allocatable?: Record<string, string>;
      /** Conditions is an array of current observed node conditions. */
      conditions?: Array<{
        /** Type of node condition. */
        type?: string;
        /** Status of the condition (True, False, Unknown). */
        status?: string;
        /** (brief) reason for the condition's last transition. */
        reason?: string;
        /** Human readable message indicating details about last transition. */
        message?: string;
      }>;
      /** List of addresses reachable to the node. */
      addresses?: Array<{
        /** Node address type (Hostname, ExternalIP, InternalIP). */
        type?: string;
        /** The node address. */
        address?: string;
      }>;
      /** Set of ids/uuids to uniquely identify the node. */
      nodeInfo?: {
        /** Kubelet Version reported by the node. */
        kubeletVersion?: string;
        /** OS Image reported by the node. */
        osImage?: string;
        /** ContainerRuntime Version reported by the node. */
        containerRuntimeVersion?: string;
        /** The Architecture reported by the node. */
        architecture?: string;
        /** The Operating System reported by the node. */
        operatingSystem?: string;
      };
    };
  }>;
}

export const listNodesTool: ToolDefinition<ListNodesResult, typeof ListNodesInputSchema> = {
  name: 'kubernetes.listNodes',
  description: 'List cluster nodes. Returns a NodeList with items array containing Node objects with metadata, spec, and status (capacity, allocatable, conditions, addresses, nodeInfo).',
  schema: ListNodesInputSchema,
  async execute(input) {
    return await listResources('v1', 'Node', {
      labelSelector: input.labelSelector,
      fieldSelector: input.fieldSelector,
      limit: input.limit,
      continueToken: input.continueToken,
    }) as ListNodesResult;
  },
};

