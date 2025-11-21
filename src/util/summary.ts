import type {
  V1Deployment,
  V1Node,
  V1ObjectMeta,
  V1Pod,
  V1Service,
} from '@kubernetes/client-node';

export interface MetadataSummary {
  name?: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  ageSeconds?: number | null;
}

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

export function summarizePod(pod: V1Pod) {
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

export function summarizeDeployment(deployment: V1Deployment) {
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

export function summarizeService(service: V1Service) {
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

export function summarizeNode(node: V1Node) {
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
    addresses: node.status?.addresses,
    conditions,
    taints: node.spec?.taints,
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

