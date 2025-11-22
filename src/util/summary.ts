import type {
  V1Deployment,
  V1Node,
  V1ObjectMeta,
  V1Pod,
  V1Service,
} from '@kubernetes/client-node';
import { z } from 'zod';

export const MetadataSummarySchema = z.object({
  name: z.string().optional(),
  namespace: z.string().optional(),
  uid: z.string().optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  creationTimestamp: z.string().optional(),
  ageSeconds: z.number().nullable().optional(),
});
export type MetadataSummary = z.infer<typeof MetadataSummarySchema>;

export function summarizeMetadata(meta?: V1ObjectMeta | null): MetadataSummary {
  if (!meta) {
    return {};
  }

  const creationTimestamp = toIsoString(meta.creationTimestamp);

  return {
    name: meta.name ?? undefined,
    namespace: meta.namespace ?? undefined,
    uid: meta.uid ?? undefined,
    labels: meta.labels ?? undefined,
    annotations: meta.annotations ?? undefined,
    creationTimestamp,
    ageSeconds: creationTimestamp ? calculateAgeSeconds(creationTimestamp) : null,
  };
}

export function calculateAgeSeconds(timestamp: string | Date): number | null {
  const value = typeof timestamp === 'string' ? timestamp : timestamp.toISOString();
  const createdAtMs = Date.parse(value);
  if (Number.isNaN(createdAtMs)) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
}

const ConditionSummarySchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
});

export const PodSummarySchema = MetadataSummarySchema.extend({
  phase: z.string().optional(),
  podIP: z.string().optional(),
  nodeName: z.string().optional(),
  qosClass: z.string().optional(),
  readyContainers: z.number(),
  totalContainers: z.number(),
  restarts: z.number(),
  failingConditions: z.array(ConditionSummarySchema),
});
export type PodSummary = z.infer<typeof PodSummarySchema>;

export function summarizePod(pod: V1Pod): PodSummary {
  const metadata = summarizeMetadata(pod.metadata);
  const containerStatuses = pod.status?.containerStatuses ?? [];
  const readyContainers = containerStatuses.filter((status) => status.ready).length;
  const totalContainers = containerStatuses.length;
  const restarts = containerStatuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0);
  const failingConditions =
    pod.status?.conditions?.filter((condition) => condition.status !== 'True') ?? [];

  return {
    ...metadata,
    phase: pod.status?.phase,
    podIP: pod.status?.podIP,
    nodeName: pod.spec?.nodeName,
    qosClass: pod.status?.qosClass,
    readyContainers,
    totalContainers,
    restarts,
    failingConditions: failingConditions.map((condition) => ({
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      message: condition.message,
      lastTransitionTime: toIsoString(condition.lastTransitionTime),
    })),
  };
}

export const DeploymentSummarySchema = MetadataSummarySchema.extend({
  strategy: z.string().optional(),
  replicas: z.object({
    desired: z.number(),
    ready: z.number(),
    available: z.number(),
    updated: z.number(),
  }),
  selector: z.record(z.string()).optional(),
  failingConditions: z.array(ConditionSummarySchema),
});
export type DeploymentSummary = z.infer<typeof DeploymentSummarySchema>;

export function summarizeDeployment(deployment: V1Deployment): DeploymentSummary {
  const metadata = summarizeMetadata(deployment.metadata);
  const conditions =
    deployment.status?.conditions?.filter((condition) => condition.status !== 'True') ?? [];

  return {
    ...metadata,
    strategy: deployment.spec?.strategy?.type,
    replicas: {
      desired: deployment.spec?.replicas ?? 1,
      ready: deployment.status?.readyReplicas ?? 0,
      available: deployment.status?.availableReplicas ?? 0,
      updated: deployment.status?.updatedReplicas ?? 0,
    },
    selector: deployment.spec?.selector?.matchLabels ?? {},
    failingConditions: conditions.map((condition) => ({
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      message: condition.message,
      lastTransitionTime: toIsoString(condition.lastTransitionTime),
    })),
  };
}

const ServicePortSummarySchema = z.object({
  name: z.string().optional(),
  protocol: z.string().optional(),
  port: z.number(),
  targetPort: z.union([z.string(), z.number()]).optional(),
  nodePort: z.number().optional(),
});

export const ServiceSummarySchema = MetadataSummarySchema.extend({
  type: z.string().optional(),
  clusterIP: z.string().optional(),
  externalIPs: z.array(z.string()),
  selector: z.record(z.string()).optional(),
  ports: z.array(ServicePortSummarySchema),
});
export type ServiceSummary = z.infer<typeof ServiceSummarySchema>;

export function summarizeService(service: V1Service): ServiceSummary {
  const metadata = summarizeMetadata(service.metadata);

  return {
    ...metadata,
    type: service.spec?.type,
    clusterIP: service.spec?.clusterIP,
    externalIPs: service.spec?.externalIPs ?? [],
    selector: service.spec?.selector ?? undefined,
    ports:
      service.spec?.ports?.map((port) => ({
        name: port.name ?? undefined,
        protocol: port.protocol ?? 'TCP',
        port: port.port,
        targetPort: typeof port.targetPort === 'string' ? port.targetPort : port.targetPort ?? undefined,
        nodePort: port.nodePort ?? undefined,
      })) ?? [],
  };
}

const NodeAddressSchema = z.object({
  type: z.string().optional(),
  address: z.string().optional(),
});

const NodeConditionSchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
});

const QuantityRecordSchema = z.record(z.union([z.string(), z.number()])).optional();

export const NodeSummarySchema = MetadataSummarySchema.extend({
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  kubeletVersion: z.string().optional(),
  osImage: z.string().optional(),
  containerRuntimeVersion: z.string().optional(),
  capacity: QuantityRecordSchema,
  allocatable: QuantityRecordSchema,
  addresses: z.array(NodeAddressSchema).optional(),
  conditions: z.array(NodeConditionSchema),
  taints: z
    .array(
      z.object({
        key: z.string().optional(),
        value: z.string().optional(),
        effect: z.string().optional(),
        timeAdded: z.string().optional(),
      }),
    )
    .optional(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

export function summarizeNode(node: V1Node): NodeSummary {
  const metadata = summarizeMetadata(node.metadata);
  const conditions =
    node.status?.conditions?.map((condition) => ({
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      message: condition.message,
      lastTransitionTime: toIsoString(condition.lastTransitionTime),
    })) ?? [];

  return {
    ...metadata,
    labels: node.metadata?.labels ?? undefined,
    annotations: node.metadata?.annotations ?? undefined,
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
    osImage: node.status?.nodeInfo?.osImage,
    containerRuntimeVersion: node.status?.nodeInfo?.containerRuntimeVersion,
    capacity: node.status?.capacity,
    allocatable: node.status?.allocatable,
    addresses:
      node.status?.addresses?.map((address) => ({
        type: address.type,
        address: address.address,
      })) ?? undefined,
    conditions,
    taints:
      node.spec?.taints?.map((taint) => ({
        key: taint.key,
        value: taint.value,
        effect: taint.effect,
        timeAdded: toIsoString(taint.timeAdded),
      })) ?? undefined,
  };
}

function toIsoString(value?: string | Date | null): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  return value.toISOString();
}

