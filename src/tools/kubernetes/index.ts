import type { AnyToolDefinition } from '../types.js';
import { applyManifestTool } from './applyManifest.js';
import { deleteResourceTool } from './deleteResource.js';
import { getCustomResourceTool } from './getCustomResource.js';
import { getDeploymentTool } from './getDeployment.js';
import { getPodTool } from './getPod.js';
import { getPodLogsTool } from './getPodLogs.js';
import { getServiceTool } from './getService.js';
import { listCustomResourcesTool } from './listCustomResources.js';
import { listNodesTool } from './listNodes.js';
import { listDeploymentsTool } from './listDeployments.js';
import { listPodsTool } from './listPods.js';
import { listServicesTool } from './listServices.js';
import { searchToolsTool } from './searchTools.js';

export const kubernetesTools: AnyToolDefinition[] = [
  searchToolsTool,
  listNodesTool,
  listPodsTool,
  getPodTool,
  getPodLogsTool,
  listDeploymentsTool,
  getDeploymentTool,
  listServicesTool,
  getServiceTool,
  applyManifestTool,
  deleteResourceTool,
  listCustomResourcesTool,
  getCustomResourceTool,
];


