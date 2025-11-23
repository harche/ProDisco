import { z } from 'zod';

import { getResource } from '../../kube/client.js';
import type { ToolDefinition } from '../types.js';

export const GetDeploymentInputSchema = z.object({
  namespace: z.string().min(1).describe('Namespace of the deployment'),
  name: z.string().min(1).describe('Name of the deployment'),
});

export type GetDeploymentInput = z.infer<typeof GetDeploymentInputSchema>;

/**
 * Deployment enables declarative updates for Pods and ReplicaSets.
 */
export interface GetDeploymentResult {
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
  /** Specification of the desired behavior of the Deployment. */
  spec?: {
    /** Number of desired pods. Defaults to 1. */
    replicas?: number;
    /** Label selector for pods. Existing ReplicaSets whose pods are selected by this will be affected by this deployment. */
    selector?: {
      /** matchLabels is a map of {key,value} pairs. */
      matchLabels?: Record<string, string>;
    };
    /** Template describes the pods that will be created. */
    template?: {
      /** Standard object's metadata. */
      metadata?: {
        /** Map of string keys and values that can be used to organize and categorize objects. */
        labels?: Record<string, string>;
        /** Annotations is an unstructured key value map. */
        annotations?: Record<string, string>;
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
        [key: string]: unknown;
      };
    };
    /** The deployment strategy to use to replace existing pods with new ones. */
    strategy?: {
      /** Type of deployment. Can be "Recreate" or "RollingUpdate". Default is RollingUpdate. */
      type?: string;
      /** Rolling update config params. Present only if DeploymentStrategyType = RollingUpdate. */
      rollingUpdate?: {
        /** The maximum number of pods that can be scheduled above the desired number of pods. */
        maxSurge?: number | string;
        /** The maximum number of pods that can be unavailable during the update. */
        maxUnavailable?: number | string;
      };
    };
  };
  /** Most recently observed status of the Deployment. */
  status?: {
    /** Total number of non-terminated pods targeted by this deployment. */
    replicas?: number;
    /** Total number of non-terminated pods that have the desired template spec. */
    updatedReplicas?: number;
    /** Number of pods targeted by this Deployment with a Ready Condition. */
    readyReplicas?: number;
    /** Total number of available pods (ready for at least minReadySeconds). */
    availableReplicas?: number;
    /** Represents the latest available observations of a deployment's current state. */
    conditions?: Array<{
      /** Type of deployment condition. */
      type?: string;
      /** Status of the condition (True, False, Unknown). */
      status?: string;
      /** The reason for the condition's last transition. */
      reason?: string;
      /** Human-readable message indicating details about last transition. */
      message?: string;
    }>;
  };
}

export const getDeploymentTool: ToolDefinition<GetDeploymentResult, typeof GetDeploymentInputSchema> = {
  name: 'kubernetes.getDeployment',
  description: 'Retrieve a deployment. Returns a Deployment object with metadata, spec (replicas, selector, template, strategy), and status.',
  schema: GetDeploymentInputSchema,
  async execute(input) {
    return (await getResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { namespace: input.namespace, name: input.name },
    })) as GetDeploymentResult;
  },
};

