/**
 * Mapping of tool files to their Kubernetes types
 */

export interface ToolTypeMapping {
  toolFile: string;
  resultTypeName: string;
  kubernetesType: string;
  description?: string;
}

export const TOOL_TYPE_MAPPINGS: ToolTypeMapping[] = [
  {
    toolFile: 'src/tools/kubernetes/getPod.ts',
    resultTypeName: 'GetPodResult',
    kubernetesType: 'V1Pod',
    description: 'Pod is a collection of containers that can run on a host. This resource is created by clients and scheduled onto hosts.'
  },
  {
    toolFile: 'src/tools/kubernetes/listPods.ts',
    resultTypeName: 'ListPodsResult',
    kubernetesType: 'V1PodList',
    description: 'PodList is a list of Pods.'
  },
  {
    toolFile: 'src/tools/kubernetes/getDeployment.ts',
    resultTypeName: 'GetDeploymentResult',
    kubernetesType: 'V1Deployment',
    description: 'Deployment enables declarative updates for Pods and ReplicaSets.'
  },
  {
    toolFile: 'src/tools/kubernetes/listDeployments.ts',
    resultTypeName: 'ListDeploymentsResult',
    kubernetesType: 'V1DeploymentList',
    description: 'DeploymentList is a list of Deployments.'
  },
  {
    toolFile: 'src/tools/kubernetes/getService.ts',
    resultTypeName: 'GetServiceResult',
    kubernetesType: 'V1Service',
    description: 'Service is a named abstraction of software service consisting of a local port that the proxy listens on, and the selector that determines which pods will answer requests sent through the proxy.'
  },
  {
    toolFile: 'src/tools/kubernetes/listServices.ts',
    resultTypeName: 'ListServicesResult',
    kubernetesType: 'V1ServiceList',
    description: 'ServiceList is a list of Services.'
  },
  {
    toolFile: 'src/tools/kubernetes/listNodes.ts',
    resultTypeName: 'ListNodesResult',
    kubernetesType: 'V1NodeList',
    description: 'NodeList is a list of nodes in the cluster.'
  },
  {
    toolFile: 'src/tools/kubernetes/getPodLogs.ts',
    resultTypeName: 'GetPodLogsResult',
    kubernetesType: 'string',
    description: 'Pod logs as a string.'
  },
  {
    toolFile: 'src/tools/kubernetes/applyManifest.ts',
    resultTypeName: 'ApplyManifestResult',
    kubernetesType: 'Array<KubernetesObject>',
    description: 'Array of applied Kubernetes objects.'
  },
  {
    toolFile: 'src/tools/kubernetes/deleteResource.ts',
    resultTypeName: 'DeleteResourceResult',
    kubernetesType: 'object',
    description: 'Result of resource deletion.'
  },
  {
    toolFile: 'src/tools/kubernetes/getCustomResource.ts',
    resultTypeName: 'GetCustomResourceResult',
    kubernetesType: 'KubernetesObject',
    description: 'Custom resource object.'
  },
  {
    toolFile: 'src/tools/kubernetes/listCustomResources.ts',
    resultTypeName: 'ListCustomResourcesResult',
    kubernetesType: 'KubernetesListObject',
    description: 'List of custom resource objects.'
  },
];

