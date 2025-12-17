import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { PACKAGE_ROOT } from '../util/paths.js';

export type LibrarySpec = {
  /** npm package name (e.g., "@kubernetes/client-node") */
  name: string;
  /** Optional human-readable description for the agent/tooling */
  description?: string;
};

export type LibrariesConfig = {
  libraries: LibrarySpec[];
};

export const DEFAULT_LIBRARIES_CONFIG: LibrariesConfig = {
  libraries: [
    { name: '@kubernetes/client-node', description: 'Kubernetes API client' },
    { name: '@prodisco/prometheus-client', description: 'Prometheus queries & metric discovery' },
    { name: '@prodisco/loki-client', description: 'Loki LogQL querying' },
    { name: 'simple-statistics', description: 'Statistics helpers' },
    { name: 'uvu', description: 'Lightweight test runner for sandbox testing' },
  ],
};

const LibrarySpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
});

const LibrariesConfigSchema: z.ZodType<LibrariesConfig> = z.object({
  libraries: z.array(LibrarySpecSchema).min(1),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const lib of value.libraries) {
    const key = lib.name.trim();
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate library name: ${key}`,
        path: ['libraries'],
      });
      return;
    }
    seen.add(key);
  }
});

export function parseLibrariesConfig(input: unknown): LibrariesConfig {
  const parsed = LibrariesConfigSchema.parse(input);
  return {
    libraries: parsed.libraries.map((l) => ({
      name: l.name.trim(),
      description: l.description?.trim(),
    })),
  };
}

/**
 * Load libraries config from a YAML or JSON file.
 * - YAML: supports single-document configs. If multiple documents exist, this throws.
 */
export async function loadLibrariesConfigFile(configPath: string): Promise<LibrariesConfig> {
  if (!configPath || configPath.trim().length === 0) {
    throw new Error('Config path is required');
  }

  const resolvedPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);

  const ext = path.extname(resolvedPath).toLowerCase();
  const contents = await fs.readFile(resolvedPath, 'utf-8');

  if (ext === '.json') {
    return parseLibrariesConfig(JSON.parse(contents) as unknown);
  }

  if (ext === '.yaml' || ext === '.yml') {
    // Prefer parseAllDocuments so we can explicitly reject multi-doc YAML (common footgun).
    const docs = parseAllDocuments(contents);
    const nonEmptyDocs = docs.filter((d) => d.contents !== null);
    if (nonEmptyDocs.length === 0) {
      throw new Error('YAML config is empty');
    }
    if (nonEmptyDocs.length > 1) {
      throw new Error('YAML config must contain exactly one document');
    }
    const obj = nonEmptyDocs[0]!.toJSON();
    return parseLibrariesConfig(obj);
  }

  // Fallback: try YAML parse for unknown extensions (for ergonomics)
  try {
    return parseLibrariesConfig(parseYaml(contents) as unknown);
  } catch {
    throw new Error(`Unsupported config extension "${ext}". Use .yaml, .yml, or .json`);
  }
}

/**
 * Find a directory such that `${dir}/node_modules` exists.
 * Walks upwards from `startDir` until filesystem root.
 */
export function findNodeModulesBasePath(startDir: string = PACKAGE_ROOT): string | null {
  let dir = startDir;
  // Normalize and guard against infinite loops
  while (true) {
    const candidate = path.join(dir, 'node_modules');
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function resolveNodeModulesBasePath(options?: {
  /** Starting point for walking upwards (default: PACKAGE_ROOT) */
  startDir?: string;
  /** Fallback directory to try (default: process.cwd()) */
  fallbackDir?: string;
}): string {
  const startDir = options?.startDir ?? PACKAGE_ROOT;
  const fallbackDir = options?.fallbackDir ?? process.cwd();

  const foundFromStart = findNodeModulesBasePath(startDir);
  if (foundFromStart) {
    return foundFromStart;
  }

  const foundFromFallback = findNodeModulesBasePath(fallbackDir);
  if (foundFromFallback) {
    return foundFromFallback;
  }

  throw new Error(
    `Could not locate a node_modules directory starting from "${startDir}" or "${fallbackDir}". ` +
    'Set an explicit base path or run from a project directory with dependencies installed.'
  );
}


