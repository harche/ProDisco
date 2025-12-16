#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);

type LibraryEntry = {
  name: string;
  description?: string;
  /**
   * Optional npm install spec (pin versions, etc).
   * Examples:
   * - "@aws-sdk/client-s3@3.540.0"
   * - "@google-cloud/storage@7"
   */
  install?: string;
};

type LibrariesConfigFile = {
  libraries: LibraryEntry[];
};

function usageAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.error(`
Build ProDisco images from a libraries config.

Usage:
  tsx scripts/docker/build-images.ts --config <path> [options]

Options:
  --config <path>         Path to YAML/JSON config (same schema used at runtime)
  --tag <tag>             Image tag to use (default: <configSha8>)
  --mcp-image <name>      MCP image name (default: prodisco/mcp-server)
  --sandbox-image <name>  Sandbox image name (default: prodisco/sandbox-server)
  --skip-mcp              Do not build the MCP image
  --skip-sandbox          Do not build the sandbox image
  --push                  Push images after build (docker push)

Examples:
  tsx scripts/docker/build-images.ts --config prodisco.config.yaml
  tsx scripts/docker/build-images.ts --config prodisco.config.yaml --tag dev --push
`);
  process.exit(code);
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function parseConfigFile(configPath: string): LibrariesConfigFile {
  const ext = path.extname(configPath).toLowerCase();
  const raw = readText(configPath);

  let obj: unknown;
  if (ext === '.json') {
    obj = JSON.parse(raw) as unknown;
  } else if (ext === '.yaml' || ext === '.yml') {
    // YAML is optional here; we depend on the root workspace having it installed.
    // This script is for repo users/build pipelines, not the published package.
    const { parseAllDocuments } = localRequire('yaml') as { parseAllDocuments: (s: string) => Array<{ contents: unknown; toJSON: () => unknown }> };
    const docs = parseAllDocuments(raw);
    const nonEmptyDocs = docs.filter((d) => d.contents !== null);
    if (nonEmptyDocs.length === 0) {
      throw new Error('YAML config is empty');
    }
    if (nonEmptyDocs.length > 1) {
      throw new Error('YAML config must contain exactly one document');
    }
    obj = nonEmptyDocs[0]!.toJSON();
  } else {
    // Try JSON first, then YAML
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      const { parse } = localRequire('yaml') as { parse: (s: string) => unknown };
      obj = parse(raw);
    }
  }

  if (!obj || typeof obj !== 'object') {
    throw new Error('Config must be an object');
  }
  const libraries = (obj as { libraries?: unknown }).libraries;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    throw new Error('Config must include a non-empty "libraries" array');
  }

  const parsed: LibraryEntry[] = [];
  for (const entry of libraries) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    const description = (entry as { description?: unknown }).description;
    const install = (entry as { install?: unknown }).install;
    parsed.push({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : undefined,
      install: typeof install === 'string' ? install.trim() : undefined,
    });
  }

  if (parsed.length === 0) {
    throw new Error('Config libraries entries must include a non-empty "name"');
  }

  return { libraries: parsed };
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function run(cmd: string, cmdArgs: string[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usageAndExit(0);
  }

  const configPathArg = getArgValue(args, '--config');
  if (!configPathArg) {
    usageAndExit(2);
  }

  const configPath = path.isAbsolute(configPathArg)
    ? configPathArg
    : path.resolve(process.cwd(), configPathArg);

  const cfgRaw = readText(configPath);
  const cfgSha = sha256Hex(cfgRaw);
  const defaultTag = cfgSha.slice(0, 8);

  const tag = getArgValue(args, '--tag') || defaultTag;
  const mcpImage = getArgValue(args, '--mcp-image') || 'prodisco/mcp-server';
  const sandboxImage = getArgValue(args, '--sandbox-image') || 'prodisco/sandbox-server';
  const skipMcp = hasFlag(args, '--skip-mcp');
  const skipSandbox = hasFlag(args, '--skip-sandbox');
  const push = hasFlag(args, '--push');

  const cfg = parseConfigFile(configPath);
  const installSpecs = cfg.libraries.map((l) => l.install || l.name);
  const extraPackagesArg = installSpecs.join(' ');

  // eslint-disable-next-line no-console
  console.log(`Config: ${configPath}`);
  // eslint-disable-next-line no-console
  console.log(`Config SHA256: ${cfgSha}`);
  // eslint-disable-next-line no-console
  console.log(`Tag: ${tag}`);
  // eslint-disable-next-line no-console
  console.log(`Installing into images: ${extraPackagesArg}`);

  if (!skipMcp) {
    run('docker', [
      'build',
      '-f',
      'Dockerfile',
      '-t',
      `${mcpImage}:${tag}`,
      '--build-arg',
      `EXTRA_NPM_PACKAGES=${extraPackagesArg}`,
      '.',
    ]);
    if (push) {
      run('docker', ['push', `${mcpImage}:${tag}`]);
    }
  }

  if (!skipSandbox) {
    run('docker', [
      'build',
      '-f',
      'packages/sandbox-server/Dockerfile',
      '-t',
      `${sandboxImage}:${tag}`,
      '--build-arg',
      `EXTRA_NPM_PACKAGES=${extraPackagesArg}`,
      '.',
    ]);
    if (push) {
      run('docker', ['push', `${sandboxImage}:${tag}`]);
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


