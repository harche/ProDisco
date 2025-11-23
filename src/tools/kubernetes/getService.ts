import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetServiceInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the service'),
  name: z.string().min(1).describe('Name of the service'),
});

export type GetServiceInput = z.infer<typeof GetServiceInputSchema>;

/**
 * Service is a named abstraction of software service consisting of a local port that the proxy listens on, and the selector that determines which pods will answer requests sent through the proxy.
 */
export interface GetServiceResult {
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
  };
  /** Spec defines the behavior of a service. */
  spec?: {
    /** Type determines how the Service is exposed. Valid options are ClusterIP, NodePort, LoadBalancer, and ExternalName. */
    type?: string;
    /** Route service traffic to pods with label keys and values matching this selector. */
    selector?: Record<string, string>;
    /** ClusterIP is the IP address of the service, usually assigned by the master. */
    clusterIP?: string;
    /** The list of ports that are exposed by this service. */
    ports?: Array<{
      /** The name of this port within the service. */
      name?: string;
      /** The IP protocol for this port. Supports "TCP", "UDP", and "SCTP". */
      protocol?: string;
      /** The port that will be exposed by this service. */
      port: number;
      /** Number or name of the port to access on the pods targeted by the service. */
      targetPort?: number | string;
      /** The port on each node on which this service is exposed when type is NodePort or LoadBalancer. */
      nodePort?: number;
    }>;
    /** ExternalIPs is a list of IP addresses for which nodes in the cluster will also accept traffic for this service. */
    externalIPs?: string[];
  };
  /** Most recently observed status of the service. */
  status?: unknown;
}

export const getServiceTool: ToolDefinition<GetServiceResult, typeof GetServiceInputSchema> = {
  name: 'kubernetes.getService',
  description: 'Get details for a Service. Returns a Service object with metadata, spec (type, selector, clusterIP, ports), and status.',
  schema: GetServiceInputSchema,
  async execute(input) {
    return (await getResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { namespace: input.namespace, name: input.name },
    })) as GetServiceResult;
  },
};

