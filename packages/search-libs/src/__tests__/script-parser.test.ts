/**
 * Tests for the script parser module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { parseScript, parseScriptsFromDirectory } from '../script/index.js';

describe('Script Parser', () => {
  const testDir = `/tmp/search-libs-script-test-${Date.now()}`;
  const testScriptPath = join(testDir, 'test-script.ts');

  beforeEach(() => {
    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('parseScript', () => {
    it('parses a script with JSDoc comment', () => {
      const code = `/**
 * List all pods in the default namespace.
 * Uses CoreV1Api to fetch pod information.
 */
import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const api = kc.makeApiClient(k8s.CoreV1Api);

async function main() {
  const response = await api.listNamespacedPod({ namespace: 'default' });
  console.log(response.items);
}

main();
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      expect(script?.filename).toBe('test-script.ts');
      expect(script?.description).toContain('List all pods');
      expect(script?.filePath).toBe(testScriptPath);
    });

    it('extracts API class references from script content', () => {
      const code = `/**
 * Test script.
 */
import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      expect(script?.apiClasses).toContain('CoreV1Api');
      expect(script?.apiClasses).toContain('AppsV1Api');
    });

    it('extracts keywords from description', () => {
      const code = `/**
 * Get deployment replicas and scale information.
 * This script monitors deployment health.
 */
const x = 1;
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      expect(script?.keywords.length).toBeGreaterThan(0);
      expect(script?.keywords.some((k) => k.toLowerCase().includes('deployment'))).toBe(true);
    });

    it('returns null for non-existent file', () => {
      const script = parseScript('/non/existent/path/script.ts');

      expect(script).toBeNull();
    });

    it('handles script without JSDoc comment', () => {
      const code = `
const x = 1;
console.log(x);
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      // When no JSDoc, description is generated from filename
      expect(script?.description).toContain('Script:');
    });

    it('handles multi-line JSDoc comments', () => {
      const code = `/**
 * First line of description.
 * Second line of description.
 * Third line with more details.
 */
const x = 1;
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      expect(script?.description).toContain('First line');
      expect(script?.description).toContain('Second line');
    });

    it('detects Prometheus API usage', () => {
      const code = `/**
 * Query Prometheus metrics.
 */
const { PrometheusDriver } = require('prometheus-query');
const prom = new PrometheusDriver({ endpoint: 'http://localhost:9090' });
await prom.instantQuery('up');
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      expect(script?.apiClasses).toContain('PrometheusDriver');
    });

    it('detects Loki client usage', () => {
      const code = `/**
 * Query Loki logs.
 */
const { LokiClient } = require('@prodisco/loki-client');
const client = new LokiClient({ baseUrl: 'http://localhost:3100' });
await client.queryRange('{app="test"}');
`;
      writeFileSync(testScriptPath, code);

      const script = parseScript(testScriptPath);

      expect(script).toBeDefined();
      expect(script?.apiClasses).toContain('LokiClient');
    });
  });

  describe('parseScriptsFromDirectory', () => {
    it('parses all TypeScript scripts in a directory', () => {
      // Create multiple test scripts
      writeFileSync(
        join(testDir, 'script1.ts'),
        '/** Script 1 description */\nconst x = 1;'
      );
      writeFileSync(
        join(testDir, 'script2.ts'),
        '/** Script 2 description */\nconst y = 2;'
      );
      writeFileSync(join(testDir, 'not-a-script.txt'), 'This is not a script');

      const scripts = parseScriptsFromDirectory(testDir);

      expect(scripts.length).toBe(2);
      expect(scripts.some((s) => s.filename === 'script1.ts')).toBe(true);
      expect(scripts.some((s) => s.filename === 'script2.ts')).toBe(true);
    });

    it('recursively parses scripts when option is set', () => {
      // Create subdirectory with scripts
      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir, { recursive: true });

      writeFileSync(join(testDir, 'root-script.ts'), '/** Root */\nconst x = 1;');
      writeFileSync(join(subDir, 'sub-script.ts'), '/** Sub */\nconst y = 2;');

      const scripts = parseScriptsFromDirectory(testDir, { recursive: true });

      expect(scripts.length).toBe(2);
      expect(scripts.some((s) => s.filename === 'root-script.ts')).toBe(true);
      expect(scripts.some((s) => s.filename === 'sub-script.ts')).toBe(true);
    });

    it('only parses root level by default', () => {
      // Create subdirectory with scripts
      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir, { recursive: true });

      writeFileSync(join(testDir, 'root-script.ts'), '/** Root */\nconst x = 1;');
      writeFileSync(join(subDir, 'sub-script.ts'), '/** Sub */\nconst y = 2;');

      const scripts = parseScriptsFromDirectory(testDir);

      expect(scripts.length).toBe(1);
      expect(scripts[0].filename).toBe('root-script.ts');
    });

    it('returns empty array for non-existent directory', () => {
      const scripts = parseScriptsFromDirectory('/non/existent/directory');

      expect(scripts).toEqual([]);
    });

    it('returns empty array for empty directory', () => {
      const emptyDir = join(testDir, 'empty');
      mkdirSync(emptyDir, { recursive: true });

      const scripts = parseScriptsFromDirectory(emptyDir);

      expect(scripts).toEqual([]);
    });
  });
});
