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
}

export const kubernetesToolMetadata: KubernetesToolMetadata[] = [
  { tool: listNodesTool, sourceModulePath: './listNodes.ts', exportName: 'listNodesTool' },
  { tool: listPodsTool, sourceModulePath: './listPods.ts', exportName: 'listPodsTool' },
  { tool: getPodTool, sourceModulePath: './getPod.ts', exportName: 'getPodTool' },
  { tool: getPodLogsTool, sourceModulePath: './getPodLogs.ts', exportName: 'getPodLogsTool' },
  { tool: listDeploymentsTool, sourceModulePath: './listDeployments.ts', exportName: 'listDeploymentsTool' },
  { tool: getDeploymentTool, sourceModulePath: './getDeployment.ts', exportName: 'getDeploymentTool' },
  { tool: listServicesTool, sourceModulePath: './listServices.ts', exportName: 'listServicesTool' },
  { tool: getServiceTool, sourceModulePath: './getService.ts', exportName: 'getServiceTool' },
  { tool: applyManifestTool, sourceModulePath: './applyManifest.ts', exportName: 'applyManifestTool' },
  { tool: deleteResourceTool, sourceModulePath: './deleteResource.ts', exportName: 'deleteResourceTool' },
  { tool: listCustomResourcesTool, sourceModulePath: './listCustomResources.ts', exportName: 'listCustomResourcesTool' },
  { tool: getCustomResourceTool, sourceModulePath: './getCustomResource.ts', exportName: 'getCustomResourceTool' },
];


