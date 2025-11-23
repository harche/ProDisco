import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetPodInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the pod'),
  name: z.string().min(1).describe('Name of the pod'),
});

export type GetPodInput = z.infer<typeof GetPodInputSchema>;

/**
 * Pod is a collection of containers that can run on a host. This resource is created by clients and scheduled onto hosts.
 */
export interface GetPodResult {
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
    /** List of containers belonging to the pod. Containers cannot currently be added or removed. */
    containers: Array<{
      /** Name of the container specified as a DNS_LABEL. */
      name: string;
      /** Container image name. */
      image?: string;
      /** Entrypoint array. Not executed within a shell. */
      command?: string[];
      /** Arguments to the entrypoint. */
      args?: string[];
      /** List of ports to expose from the container. */
      ports?: Array<{
        /** Number of port to expose on the pod's IP address. */
        containerPort?: number;
        /** Protocol for port. Must be UDP, TCP, or SCTP. */
        protocol?: string;
        /** If specified, this must be an IANA_SVC_NAME and unique within the pod. */
        name?: string;
      }>;
      /** List of environment variables to set in the container. */
      env?: Array<{ name?: string; value?: string; valueFrom?: unknown }>;
      /** Compute Resources required by this container. */
      resources?: {
        /** Limits describes the maximum amount of compute resources allowed. */
        limits?: Record<string, string>;
        /** Requests describes the minimum amount of compute resources required. */
        requests?: Record<string, string>;
      };
      /** Pod volumes to mount into the container's filesystem. */
      volumeMounts?: Array<{ name?: string; mountPath?: string }>;
    }>;
    /** List of initialization containers belonging to the pod. */
    initContainers?: Array<unknown>;
    /** NodeName indicates on which node this pod is scheduled. Empty if not yet scheduled. */
    nodeName?: string;
    /** ServiceAccountName is the name of the ServiceAccount to use to run this pod. */
    serviceAccountName?: string;
    /** List of volumes that can be mounted by containers belonging to the pod. */
    volumes?: Array<unknown>;
    /** If specified, the pod's tolerations. */
    tolerations?: Array<{
      /** Key is the taint key that the toleration applies to. */
      key?: string;
      /** Operator represents a key's relationship to the value. */
      operator?: string;
      /** Value is the taint value the toleration matches to. */
      value?: string;
      /** Effect indicates the taint effect to match. */
      effect?: string;
    }>;
  };
  /** Most recently observed status of the pod. */
  status?: {
    /** The phase of a Pod is a simple, high-level summary of where the Pod is in its lifecycle. */
    phase?: string;
    /** Current service state of pod. */
    conditions?: Array<{
      /** Type is the type of the condition. */
      type?: string;
      /** Status is the status of the condition. Can be True, False, Unknown. */
      status?: string;
      /** Unique, one-word, CamelCase reason for the condition's last transition. */
      reason?: string;
      /** Human-readable message indicating details about last transition. */
      message?: string;
      /** Last time the condition transitioned from one status to another. */
      lastTransitionTime?: string;
    }>;
    /** Pod's IP address allocated to the pod. */
    podIP?: string;
    /** IP address of the host to which the pod is assigned. */
    hostIP?: string;
    /** The list has one entry per container in the manifest. */
    containerStatuses?: Array<{
      /** Name of the container specified as a DNS_LABEL. */
      name?: string;
      /** Specifies whether the container has passed its readiness probe. */
      ready?: boolean;
      /** The number of times the container has been restarted. */
      restartCount?: number;
      /** Image is the name of the container image. */
      image?: string;
      /** Details about the container's current condition. */
      state?: unknown;
    }>;
    /** The Quality of Service (QOS) classification assigned to the pod based on resource requirements. */
    qosClass?: string;
    /** RFC 3339 date and time at which the object was acknowledged by the Kubelet. */
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

