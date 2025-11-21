import type { KubernetesObject } from '@kubernetes/client-node';
import { parseAllDocuments } from 'yaml';

type ManifestInput =
  | string
  | KubernetesObject
  | Record<string, unknown>
  | Array<KubernetesObject | Record<string, unknown>>;

export function parseManifests(input: ManifestInput): KubernetesObject[] {
  if (typeof input === 'string') {
    const docs = parseAllDocuments(input).map((doc) => doc.toJSON());
    return docs.filter(isKubernetesObject).map(normalizeManifest);
  }

  if (Array.isArray(input)) {
    return input.filter(isKubernetesObject).map(normalizeManifest);
  }

  return [normalizeManifest(input)];
}

function normalizeManifest<T extends KubernetesObject | Record<string, unknown>>(manifest: T): KubernetesObject {
  if (!isKubernetesObject(manifest)) {
    throw new Error('Manifest is missing apiVersion or kind fields');
  }

  if (!manifest.metadata) {
    throw new Error('Manifest metadata is required');
  }

  if (!manifest.metadata.name) {
    throw new Error('Manifest metadata.name is required');
  }

  return manifest;
}

function isKubernetesObject(value: unknown): value is KubernetesObject {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.apiVersion === 'string' && typeof candidate.kind === 'string';
}

