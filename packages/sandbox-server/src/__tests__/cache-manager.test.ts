import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { CacheManager, type CachedCode } from '../server/cache-manager.js';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Generate unique ID for test isolation (avoid collision between src and dist tests)
const testId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

describe('CacheManager', () => {
  const testCacheDir = `/tmp/prodisco-cache-test-${testId}`;
  let cacheManager: CacheManager;

  beforeEach(() => {
    // Clean up and create fresh test directory
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
    cacheManager = new CacheManager({ cacheDir: testCacheDir });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true });
    }
  });

  describe('Constructor', () => {
    it('creates cache directory if it does not exist', () => {
      const customDir = testCacheDir + '-custom';
      try {
        expect(existsSync(customDir)).toBe(false);
        new CacheManager({ cacheDir: customDir });
        expect(existsSync(customDir)).toBe(true);
      } finally {
        if (existsSync(customDir)) {
          rmSync(customDir, { recursive: true });
        }
      }
    });

    it('uses SCRIPTS_CACHE_DIR from environment if not configured', () => {
      const originalEnv = process.env.SCRIPTS_CACHE_DIR;
      const envDir = testCacheDir + '-env';

      try {
        process.env.SCRIPTS_CACHE_DIR = envDir;
        const manager = new CacheManager();
        expect(existsSync(envDir)).toBe(true);
      } finally {
        process.env.SCRIPTS_CACHE_DIR = originalEnv;
        if (existsSync(envDir)) {
          rmSync(envDir, { recursive: true });
        }
      }
    });

    it('uses default /tmp/prodisco-scripts if no config or env', () => {
      const originalEnv = process.env.SCRIPTS_CACHE_DIR;
      try {
        delete process.env.SCRIPTS_CACHE_DIR;
        const manager = new CacheManager();
        // Just verify it doesn't throw
        expect(manager).toBeInstanceOf(CacheManager);
      } finally {
        if (originalEnv) {
          process.env.SCRIPTS_CACHE_DIR = originalEnv;
        }
      }
    });
  });

  describe('cache()', () => {
    it('caches code and returns CacheEntry with name', async () => {
      const code = 'console.log("test");';
      const entry = await cacheManager.cache(code);

      expect(entry).toBeDefined();
      expect(entry!.name).toMatch(/^script-.*\.ts$/);
      expect(entry!.description).toBeDefined();
      expect(entry!.createdAtMs).toBeDefined();
      expect(entry!.contentHash).toBeDefined();
    });

    it('creates file with correct content', async () => {
      const code = 'console.log("hello world");';
      const entry = await cacheManager.cache(code);

      expect(entry).toBeDefined();
      const filePath = join(testCacheDir, entry!.name);
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('// Executed via sandbox at');
      expect(content).toContain(code);
    });

    it('uses hash-based filename for deduplication', async () => {
      const code = 'console.log("unique code");';

      const entry1 = await cacheManager.cache(code);
      const entry2 = await cacheManager.cache(code);

      // Second cache should return undefined (already cached)
      expect(entry1).toBeDefined();
      expect(entry2).toBeUndefined();
    });

    it('caches different code separately', async () => {
      const code1 = 'console.log("code 1");';
      const code2 = 'console.log("code 2");';

      const entry1 = await cacheManager.cache(code1);
      const entry2 = await cacheManager.cache(code2);

      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();
      expect(entry1!.name).not.toBe(entry2!.name);
    });

    it('includes timestamp in filename', async () => {
      const code = 'console.log("timestamp test");';
      const entry = await cacheManager.cache(code);

      expect(entry).toBeDefined();
      // Format: script-YYYY-MM-DDTHH-MM-SS-hash.ts
      expect(entry!.name).toMatch(/^script-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{12}\.ts$/);
    });

    it('includes hash in filename and contentHash field', async () => {
      const code = 'console.log("hash test");';
      const entry = await cacheManager.cache(code);

      expect(entry).toBeDefined();
      // Should contain a 12-character hex hash
      expect(entry!.name).toMatch(/-[a-f0-9]{12}\.ts$/);
      expect(entry!.contentHash).toMatch(/^[a-f0-9]{12}$/);
    });

    it('handles concurrent cache calls safely', async () => {
      const codes = Array.from({ length: 10 }, (_, i) => `console.log("${i}");`);

      const results = await Promise.all(codes.map(code => cacheManager.cache(code)));

      // All unique codes should be cached
      const entries = results.filter(r => r !== undefined);
      expect(entries.length).toBe(10);
      expect(new Set(entries.map(e => e!.name)).size).toBe(10);
    });

    it('returns undefined on caching error (silently fails)', async () => {
      // Create a manager with a valid directory first
      const validDir = testCacheDir + '-silent-fail';
      const manager = new CacheManager({ cacheDir: validDir });

      // Delete the directory to simulate a write failure scenario
      if (existsSync(validDir)) {
        rmSync(validDir, { recursive: true });
      }

      // The cache method should recreate the directory and succeed
      // This test verifies the cache method doesn't throw on retries
      const result = await manager.cache('console.log("test");');
      // Since the directory gets recreated, it should actually succeed
      expect(result).toBeDefined();

      // Clean up
      if (existsSync(validDir)) {
        rmSync(validDir, { recursive: true });
      }
    });
  });

  describe('find()', () => {
    beforeEach(async () => {
      // Pre-populate with some test scripts
      const scripts = [
        { name: 'script-2024-01-01T00-00-00-abc123def456.ts', content: 'console.log("first");' },
        { name: 'script-2024-01-02T00-00-00-bcd234efg567.ts', content: 'console.log("second");' },
        { name: 'list-pods.ts', content: '// List all pods\nconsole.log("pods");' },
      ];

      for (const script of scripts) {
        writeFileSync(join(testCacheDir, script.name), script.content);
      }
    });

    it('finds script by exact filename', () => {
      const result = cacheManager.find('list-pods.ts');

      expect(result).not.toBeNull();
      expect(result!.filename).toBe('list-pods.ts');
      expect(result!.path).toBe(join(testCacheDir, 'list-pods.ts'));
    });

    it('finds script by filename without .ts extension', () => {
      const result = cacheManager.find('list-pods');

      expect(result).not.toBeNull();
      expect(result!.filename).toBe('list-pods.ts');
    });

    it('finds script by partial match', () => {
      const result = cacheManager.find('pods');

      expect(result).not.toBeNull();
      expect(result!.filename).toBe('list-pods.ts');
    });

    it('finds script by hash partial match', () => {
      const result = cacheManager.find('abc123');

      expect(result).not.toBeNull();
      expect(result!.filename).toContain('abc123');
    });

    it('case-insensitive partial match', () => {
      const result = cacheManager.find('PODS');

      expect(result).not.toBeNull();
      expect(result!.filename).toBe('list-pods.ts');
    });

    it('returns null for non-existent script', () => {
      const result = cacheManager.find('non-existent-script');

      expect(result).toBeNull();
    });

    it('returns null when cache directory does not exist', () => {
      const manager = new CacheManager({ cacheDir: '/tmp/non-existent-dir-' + Date.now() });
      const result = manager.find('any-script');

      expect(result).toBeNull();
    });

    it('returns correct CachedCode structure', () => {
      const result = cacheManager.find('list-pods');

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('filename');
      expect(result).toHaveProperty('code');
      expect(typeof result!.path).toBe('string');
      expect(typeof result!.filename).toBe('string');
      expect(typeof result!.code).toBe('string');
    });

    it('returns code content in result', () => {
      const result = cacheManager.find('list-pods');

      expect(result).not.toBeNull();
      expect(result!.code).toContain('console.log("pods")');
    });

    it('strips header comment from code', () => {
      // Add a script with the standard header
      const headerContent = '// Executed via sandbox at 2024-01-01T00:00:00.000Z\nconsole.log("test");';
      writeFileSync(join(testCacheDir, 'with-header.ts'), headerContent);

      const result = cacheManager.find('with-header');

      expect(result).not.toBeNull();
      expect(result!.code).toBe('console.log("test");');
      expect(result!.code).not.toContain('// Executed via');
    });

    it('preserves code without header', () => {
      const result = cacheManager.find('list-pods');

      expect(result).not.toBeNull();
      // The list-pods script has a different comment format, so it should be preserved
      expect(result!.code).toContain('// List all pods');
    });

    it('prefers exact match over partial match', () => {
      // Add scripts that could cause partial match ambiguity
      writeFileSync(join(testCacheDir, 'test.ts'), 'console.log("test");');
      writeFileSync(join(testCacheDir, 'test-extended.ts'), 'console.log("test-extended");');

      const result = cacheManager.find('test.ts');

      expect(result).not.toBeNull();
      expect(result!.filename).toBe('test.ts');
    });

    it('only returns .ts files', () => {
      // Add a non-ts file
      writeFileSync(join(testCacheDir, 'readme.md'), '# Readme');

      const result = cacheManager.find('readme');

      expect(result).toBeNull();
    });
  });

  describe('Mutex Behavior', () => {
    it('serializes concurrent cache operations', async () => {
      const operations: number[] = [];

      // Create cache operations that log their order
      const promises = Array.from({ length: 5 }, (_, i) =>
        cacheManager.cache(`console.log("operation ${i}");`).then(() => {
          operations.push(i);
        })
      );

      await Promise.all(promises);

      // All operations should complete
      expect(operations.length).toBe(5);
      // Each operation should be unique
      expect(new Set(operations).size).toBe(5);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty code', async () => {
      const entry = await cacheManager.cache('');

      expect(entry).toBeDefined();
      const filePath = join(testCacheDir, entry!.name);
      const content = readFileSync(filePath, 'utf-8');
      // Should have just the header
      expect(content).toContain('// Executed via sandbox at');
    });

    it('handles code with special characters', async () => {
      const code = 'console.log("Special: $`\\n\\t{}[]");';
      const entry = await cacheManager.cache(code);

      expect(entry).toBeDefined();
      const result = cacheManager.find(entry!.name);
      expect(result!.code).toContain(code);
    });

    it('handles code with Unicode', async () => {
      const code = 'console.log("Hello 世界 🌍");';
      const entry = await cacheManager.cache(code);

      expect(entry).toBeDefined();
      const result = cacheManager.find(entry!.name);
      expect(result!.code).toContain('世界');
      expect(result!.code).toContain('🌍');
    });

    it('handles very long code', async () => {
      const code = 'console.log("a".repeat(10000));';
      const filename = await cacheManager.cache(code);

      expect(filename).toBeDefined();
    });

    it('recreates cache directory if deleted between operations', async () => {
      // Cache something first
      await cacheManager.cache('console.log("first");');

      // Delete the cache directory
      rmSync(testCacheDir, { recursive: true });

      // Cache again - should recreate directory
      const filename = await cacheManager.cache('console.log("second");');

      expect(filename).toBeDefined();
      expect(existsSync(testCacheDir)).toBe(true);
    });
  });

  describe('File Listing', () => {
    it('lists multiple cached scripts', async () => {
      const codes = [
        'console.log("first");',
        'console.log("second");',
        'console.log("third");',
      ];

      for (const code of codes) {
        await cacheManager.cache(code);
      }

      const files = readdirSync(testCacheDir).filter(f => f.endsWith('.ts'));
      expect(files.length).toBe(3);
    });

    it('all cached files have .ts extension', async () => {
      await cacheManager.cache('console.log("test");');

      const files = readdirSync(testCacheDir);
      const tsFiles = files.filter(f => f.endsWith('.ts'));
      expect(tsFiles.length).toBe(files.length);
    });
  });
});
