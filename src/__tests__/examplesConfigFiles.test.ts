import { describe, expect, it } from 'vitest';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrariesConfigFile } from '../config/libraries.js';

function getRepoRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '..', '..');
}

describe('examples/*.yaml libraries configs', () => {
  it('all shipped example configs are valid and parseable', async () => {
    const repoRoot = getRepoRoot();
    const examplesDir = path.join(repoRoot, 'examples');

    const entries = await fs.readdir(examplesDir);
    const configFiles = entries.filter((name) =>
      name.endsWith('.yaml') || name.endsWith('.yml') || name.endsWith('.json')
    );

    // We expect at least the two docs-backed configs to be present.
    expect(configFiles).toContain('prodisco.postgres.yaml');
    expect(configFiles).toContain('prodisco.kubernetes.yaml');

    for (const filename of configFiles) {
      const fullPath = path.join(examplesDir, filename);
      const cfg = await loadLibrariesConfigFile(fullPath);

      expect(cfg.libraries.length).toBeGreaterThan(0);
      for (const lib of cfg.libraries) {
        expect(typeof lib.name).toBe('string');
        expect(lib.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('postgres example config includes pg-mem', async () => {
    const repoRoot = getRepoRoot();
    const cfg = await loadLibrariesConfigFile(path.join(repoRoot, 'examples', 'prodisco.postgres.yaml'));
    expect(cfg.libraries.map((l) => l.name)).toContain('pg-mem');
  });

  it('kubernetes example config includes @kubernetes/client-node', async () => {
    const repoRoot = getRepoRoot();
    const cfg = await loadLibrariesConfigFile(path.join(repoRoot, 'examples', 'prodisco.kubernetes.yaml'));
    expect(cfg.libraries.map((l) => l.name)).toContain('@kubernetes/client-node');
  });
});


