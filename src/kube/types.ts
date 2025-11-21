import type { KubernetesListObject, KubernetesObject } from '@kubernetes/client-node';

export interface ResourceIdentifier {
  group?: string;
  version: string;
  namespace?: string;
  plural: string;
  name?: string;
}

export type AnyManifest<T = Record<string, unknown>> = KubernetesObject & T;

export type AnyManifestList<T extends KubernetesObject = KubernetesObject> = KubernetesListObject<T>;

export interface ManifestWithMeta<T extends KubernetesObject = KubernetesObject> {
  manifest: T;
  dryRun?: boolean;
  fieldManager?: string;
  forceConflicts?: boolean;
}

export interface ListOptions {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  continueToken?: string;
}

export interface GetOptions {
  namespace?: string;
}


