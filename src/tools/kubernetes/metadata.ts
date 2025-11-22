import type { ZodTypeAny } from 'zod';

import type { AnyToolDefinition } from '../types.js';
import { ApplyManifestResultSchema, applyManifestTool } from './applyManifest.js';
import { DeleteResourceResultSchema, deleteResourceTool } from './deleteResource.js';
import { GetCustomResourceResultSchema, getCustomResourceTool } from './getCustomResource.js';
import { GetDeploymentResultSchema, getDeploymentTool } from './getDeployment.js';
import { GetPodResultSchema, getPodTool } from './getPod.js';
import { GetPodLogsResultSchema, getPodLogsTool } from './getPodLogs.js';
import { GetServiceResultSchema, getServiceTool } from './getService.js';
import {
  ListCustomResourcesResultSchema,
  listCustomResourcesTool,
} from './listCustomResources.js';
import { ListDeploymentsResultSchema, listDeploymentsTool } from './listDeployments.js';
import { ListNodesResultSchema, listNodesTool } from './listNodes.js';
import { ListPodsResultSchema, listPodsTool } from './listPods.js';
import { ListServicesResultSchema, listServicesTool } from './listServices.js';

export interface KubernetesToolMetadata {
  tool: AnyToolDefinition;
  sourceModulePath: string;
  exportName: string;
  resultSchema: ZodTypeAny;
}

export const kubernetesToolMetadata: KubernetesToolMetadata[] = [
  {
    tool: listNodesTool,
    sourceModulePath: './listNodes.ts',
    exportName: 'listNodesTool',
    resultSchema: ListNodesResultSchema,
  },
  {
    tool: listPodsTool,
    sourceModulePath: './listPods.ts',
    exportName: 'listPodsTool',
    resultSchema: ListPodsResultSchema,
  },
  {
    tool: getPodTool,
    sourceModulePath: './getPod.ts',
    exportName: 'getPodTool',
    resultSchema: GetPodResultSchema,
  },
  {
    tool: getPodLogsTool,
    sourceModulePath: './getPodLogs.ts',
    exportName: 'getPodLogsTool',
    resultSchema: GetPodLogsResultSchema,
  },
  {
    tool: listDeploymentsTool,
    sourceModulePath: './listDeployments.ts',
    exportName: 'listDeploymentsTool',
    resultSchema: ListDeploymentsResultSchema,
  },
  {
    tool: getDeploymentTool,
    sourceModulePath: './getDeployment.ts',
    exportName: 'getDeploymentTool',
    resultSchema: GetDeploymentResultSchema,
  },
  {
    tool: listServicesTool,
    sourceModulePath: './listServices.ts',
    exportName: 'listServicesTool',
    resultSchema: ListServicesResultSchema,
  },
  {
    tool: getServiceTool,
    sourceModulePath: './getService.ts',
    exportName: 'getServiceTool',
    resultSchema: GetServiceResultSchema,
  },
  {
    tool: applyManifestTool,
    sourceModulePath: './applyManifest.ts',
    exportName: 'applyManifestTool',
    resultSchema: ApplyManifestResultSchema,
  },
  {
    tool: deleteResourceTool,
    sourceModulePath: './deleteResource.ts',
    exportName: 'deleteResourceTool',
    resultSchema: DeleteResourceResultSchema,
  },
  {
    tool: listCustomResourcesTool,
    sourceModulePath: './listCustomResources.ts',
    exportName: 'listCustomResourcesTool',
    resultSchema: ListCustomResourcesResultSchema,
  },
  {
    tool: getCustomResourceTool,
    sourceModulePath: './getCustomResource.ts',
    exportName: 'getCustomResourceTool',
    resultSchema: GetCustomResourceResultSchema,
  },
];


