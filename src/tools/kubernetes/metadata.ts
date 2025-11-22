import type { AnyToolDefinition } from '../types.js';
import { applyManifestTool } from './applyManifest.js';
import { deleteResourceTool } from './deleteResource.js';
import { getCustomResourceTool } from './getCustomResource.js';
import { getDeploymentTool } from './getDeployment.js';
import { getPodTool } from './getPod.js';
import { getPodLogsTool } from './getPodLogs.js';
import { getServiceTool } from './getService.js';
import { listCustomResourcesTool } from './listCustomResources.js';
import { listDeploymentsTool } from './listDeployments.js';
import { listNodesTool } from './listNodes.js';
import { listPodsTool } from './listPods.js';
import { listServicesTool } from './listServices.js';

export interface KubernetesToolMetadata {
  tool: AnyToolDefinition;
  sourceModulePath: string;
  exportName: string;
  resultType: string;
}

export const kubernetesToolMetadata: KubernetesToolMetadata[] = [
  {
    tool: listNodesTool,
    sourceModulePath: './listNodes.ts',
    exportName: 'listNodesTool',
    resultType: `type ListNodesResult = {
  items: ReturnType<typeof summarizeNode>[];
  continueToken?: string;
  totalItems: number;
};`,
  },
  {
    tool: listPodsTool,
    sourceModulePath: './listPods.ts',
    exportName: 'listPodsTool',
    resultType: `type ListPodsResult = {
  namespace?: string;
  items: ReturnType<typeof summarizePod>[];
  continueToken?: string;
  totalItems: number;
};`,
  },
  {
    tool: getPodTool,
    sourceModulePath: './getPod.ts',
    exportName: 'getPodTool',
    resultType: `type GetPodResult = {
  summary: ReturnType<typeof summarizePod>;
  spec: Partial<V1Pod['spec']>;
  status: Partial<V1Pod['status']>;
  raw?: V1Pod;
};`,
  },
  {
    tool: getPodLogsTool,
    sourceModulePath: './getPodLogs.ts',
    exportName: 'getPodLogsTool',
    resultType: `type GetPodLogsResult = {
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
  logs: string;
};`,
  },
  {
    tool: listDeploymentsTool,
    sourceModulePath: './listDeployments.ts',
    exportName: 'listDeploymentsTool',
    resultType: `type ListDeploymentsResult = {
  namespace?: string;
  items: ReturnType<typeof summarizeDeployment>[];
  continueToken?: string;
  totalItems: number;
};`,
  },
  {
    tool: getDeploymentTool,
    sourceModulePath: './getDeployment.ts',
    exportName: 'getDeploymentTool',
    resultType: `type GetDeploymentResult = {
  summary: ReturnType<typeof summarizeDeployment>;
  spec: Partial<V1Deployment['spec']>;
  status: Partial<V1Deployment['status']>;
  raw?: V1Deployment;
};`,
  },
  {
    tool: listServicesTool,
    sourceModulePath: './listServices.ts',
    exportName: 'listServicesTool',
    resultType: `type ListServicesResult = {
  namespace?: string;
  items: ReturnType<typeof summarizeService>[];
  continueToken?: string;
  totalItems: number;
};`,
  },
  {
    tool: getServiceTool,
    sourceModulePath: './getService.ts',
    exportName: 'getServiceTool',
    resultType: `type GetServiceResult = {
  summary: ReturnType<typeof summarizeService>;
  spec: Partial<V1Service['spec']>;
  status: Partial<V1Service['status']>;
  raw?: V1Service;
};`,
  },
  {
    tool: applyManifestTool,
    sourceModulePath: './applyManifest.ts',
    exportName: 'applyManifestTool',
    resultType: `type ApplyManifestResult = {
  applied: Array<{
    apiVersion?: string;
    kind?: string;
    metadata: ReturnType<typeof summarizeMetadata>;
  }>;
};`,
  },
  {
    tool: deleteResourceTool,
    sourceModulePath: './deleteResource.ts',
    exportName: 'deleteResourceTool',
    resultType: `type DeleteResourceResult = {
  manifest: {
    apiVersion?: string;
    kind?: string;
    metadata: ReturnType<typeof summarizeMetadata>;
  };
  dryRun?: boolean;
};`,
  },
  {
    tool: listCustomResourcesTool,
    sourceModulePath: './listCustomResources.ts',
    exportName: 'listCustomResourcesTool',
    resultType: `type ListCustomResourcesResult = {
  items: Array<{
    apiVersion?: string;
    kind?: string;
    metadata: ReturnType<typeof summarizeMetadata>;
  }>;
  continueToken?: string;
  totalItems: number;
  raw?: unknown;
};`,
  },
  {
    tool: getCustomResourceTool,
    sourceModulePath: './getCustomResource.ts',
    exportName: 'getCustomResourceTool',
    resultType: `type GetCustomResourceResult = {
  apiVersion?: string;
  kind?: string;
  metadata: ReturnType<typeof summarizeMetadata>;
  spec?: unknown;
  status?: unknown;
  raw?: unknown;
};`,
  },
];


