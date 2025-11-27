import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import {
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  KubernetesListObject,
  KubernetesObject,
  KubernetesObjectApi,
  V1DeleteOptions,
} from '@kubernetes/client-node';
import { PatchStrategy } from '@kubernetes/client-node/dist/patch.js';

import type { ListOptions, ManifestWithMeta, ResourceIdentifier } from './types.js';

const DEFAULT_FIELD_MANAGER = 'kubernetes-mcp';
const DEFAULT_FORCE_CONFLICTS = true;

interface KubernetesClientBundle {
  kubeConfig: KubeConfig;
  core: CoreV1Api;
  apps: AppsV1Api;
  customObjects: CustomObjectsApi;
  objectApi: KubernetesObjectApi;
}

let cachedClients: KubernetesClientBundle | null = null;

function loadKubeConfig(): KubeConfig {
  const kubeConfig = new KubeConfig();
  const kubeconfigEnv = process.env.KUBECONFIG?.split(path.delimiter).filter(Boolean) ?? [];
  const defaultKubeconfigPath = path.join(homedir(), '.kube', 'config');

  try {
    if (kubeconfigEnv.length > 0 || fs.existsSync(defaultKubeconfigPath)) {
      kubeConfig.loadFromDefault();
    } else {
      kubeConfig.loadFromCluster();
    }
  } catch (error) {
    throw new Error(`Failed to load kubeconfig: ${(error as Error).message}`);
  }

  return kubeConfig;
}

function createClients(): KubernetesClientBundle {
  const kubeConfig = loadKubeConfig();

  return {
    kubeConfig,
    core: kubeConfig.makeApiClient(CoreV1Api),
    apps: kubeConfig.makeApiClient(AppsV1Api),
    customObjects: kubeConfig.makeApiClient(CustomObjectsApi),
    objectApi: KubernetesObjectApi.makeApiClient(kubeConfig),
  };
}

export function getKubeClients(): KubernetesClientBundle {
  if (!cachedClients) {
    cachedClients = createClients();
  }

  return cachedClients;
}

export function resetKubeClients(): void {
  cachedClients = null;
}

/**
 * Probes the Kubernetes cluster to verify connectivity.
 * Makes a lightweight API call to check if the cluster is reachable.
 * @throws Error if the cluster is not accessible
 */
export async function probeClusterConnectivity(): Promise<void> {
  const { core } = getKubeClients();

  // Use a lightweight API call - getting API versions or listing namespaces with limit=1
  // This verifies both network connectivity and authentication
  await core.listNamespace({ limit: 1 });
}

export function splitApiVersion(apiVersion: string): { group?: string; version: string } {
  if (!apiVersion.includes('/')) {
    return { version: apiVersion };
  }

  const [group, version] = apiVersion.split('/');
  if (!version) {
    throw new Error(`Invalid apiVersion: ${apiVersion}`);
  }

  return { group, version };
}

export async function listResources(
  apiVersion: string,
  kind: string,
  options: ListOptions = {},
): Promise<KubernetesListObject<KubernetesObject>> {
  const { objectApi } = getKubeClients();

  return objectApi.list(
    apiVersion,
    kind,
    options.namespace,
    undefined,
    undefined,
    undefined,
    options.fieldSelector,
    options.labelSelector,
    options.limit,
    options.continueToken,
  );
}

export async function getResource(manifest: KubernetesObject): Promise<KubernetesObject> {
  const { objectApi } = getKubeClients();

  if (!manifest.metadata?.name) {
    throw new Error('Manifest metadata.name is required to read a resource');
  }

  return objectApi.read({
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: {
      name: manifest.metadata.name,
      namespace: manifest.metadata.namespace,
    },
  });
}

export interface DeleteResourceOptions {
  dryRun?: boolean;
  gracePeriodSeconds?: number;
  propagationPolicy?: 'Foreground' | 'Background' | 'Orphan';
  body?: V1DeleteOptions;
}

export async function deleteResource(
  manifest: KubernetesObject,
  options: DeleteResourceOptions = {},
): Promise<void> {
  const { objectApi } = getKubeClients();
  await objectApi.delete(
    manifest,
    undefined,
    options.dryRun ? 'All' : undefined,
    options.gracePeriodSeconds,
    undefined,
    options.propagationPolicy,
    options.body,
  );
}

export async function applyManifest(
  input: ManifestWithMeta<KubernetesObject>,
): Promise<KubernetesObject> {
  const { objectApi } = getKubeClients();
  const { manifest, dryRun, fieldManager, forceConflicts } = input;

  if (!manifest.metadata?.name) {
    throw new Error('Manifest metadata.name is required to apply a resource');
  }

  return objectApi.patch(
    manifest,
    dryRun ? 'All' : undefined,
    undefined,
    fieldManager ?? DEFAULT_FIELD_MANAGER,
    forceConflicts ?? DEFAULT_FORCE_CONFLICTS,
    PatchStrategy.ServerSideApply,
  );
}

export async function getPodLogs(params: {
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
  timestamps?: boolean;
  previous?: boolean;
}): Promise<string> {
  const { core } = getKubeClients();
  const { namespace, podName, container, tailLines, timestamps, previous } = params;

  return core.readNamespacedPodLog({
    namespace,
    name: podName,
    container,
    tailLines,
    timestamps,
    previous,
  });
}

function ensureCustomResourceIdentifier(id: ResourceIdentifier): asserts id is Required<ResourceIdentifier> {
  if (!id.group) throw new Error('Custom resource group is required');
  if (!id.version) throw new Error('Custom resource version is required');
  if (!id.plural) throw new Error('Custom resource plural is required');
}

function ensureCustomResourceName(id: ResourceIdentifier): asserts id is Required<ResourceIdentifier> {
  ensureCustomResourceIdentifier(id);
  if (!id.name) throw new Error('Custom resource name is required for get/delete operations');
}

export async function listCustomResources(
  identifier: ResourceIdentifier,
  options: ListOptions = {},
): Promise<unknown> {
  ensureCustomResourceIdentifier(identifier);
  const { customObjects } = getKubeClients();
  const namespace = identifier.namespace ?? options.namespace;

  if (namespace) {
    const result = await customObjects.listNamespacedCustomObject({
      group: identifier.group,
      version: identifier.version,
      namespace,
      plural: identifier.plural,
      allowWatchBookmarks: false,
      _continue: options.continueToken,
      fieldSelector: options.fieldSelector,
      labelSelector: options.labelSelector,
      limit: options.limit,
    });

    return result.body;
  }

  const result = await customObjects.listClusterCustomObject({
    group: identifier.group,
    version: identifier.version,
    plural: identifier.plural,
    allowWatchBookmarks: false,
    _continue: options.continueToken,
    fieldSelector: options.fieldSelector,
    labelSelector: options.labelSelector,
    limit: options.limit,
  });

  return result.body;
}

export async function getCustomResource(identifier: ResourceIdentifier): Promise<unknown> {
  ensureCustomResourceName(identifier);
  const { customObjects } = getKubeClients();

  if (identifier.namespace) {
    const result = await customObjects.getNamespacedCustomObject({
      group: identifier.group,
      version: identifier.version,
      namespace: identifier.namespace,
      plural: identifier.plural,
      name: identifier.name,
    });

    return result.body;
  }

  const result = await customObjects.getClusterCustomObject({
    group: identifier.group,
    version: identifier.version,
    plural: identifier.plural,
    name: identifier.name,
  });

  return result.body;
}

