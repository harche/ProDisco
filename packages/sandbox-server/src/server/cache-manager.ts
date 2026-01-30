import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CacheEntry } from '../generated/sandbox.js';

/**
 * Simple async mutex to prevent race conditions during caching.
 * Ensures only one cacheCode operation runs at a time.
 */
class CacheMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export interface CachedCode {
  path: string;
  filename: string;
  code: string;
}

export interface CacheManagerConfig {
  cacheDir?: string;
}

/**
 * CacheManager handles caching and retrieval of executed code.
 */
export class CacheManager {
  private cacheDir: string;
  private mutex = new CacheMutex();

  constructor(config: CacheManagerConfig = {}) {
    this.cacheDir = config.cacheDir || process.env.SCRIPTS_CACHE_DIR || '/tmp/prodisco-scripts';
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Cache successfully executed code.
   * Uses a hash of the code to create a unique filename, avoiding duplicates.
   * Returns a CacheEntry if a new entry was created.
   *
   * @param code - The code to cache
   * @param scriptName - The name for the script (e.g., "list-pods")
   */
  async cache(code: string, scriptName: string): Promise<CacheEntry | undefined> {
    await this.mutex.acquire();

    try {
      this.ensureDirectory();

      // Create content hash for the cache entry
      const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);

      // Sanitize the script name and create filename
      const sanitizedName = this.sanitizeScriptName(scriptName);
      const filename = `${sanitizedName}.ts`;
      const filepath = join(this.cacheDir, filename);

      // Check if script with this name already exists
      if (existsSync(filepath)) {
        // Script with same name already cached
        return undefined;
      }

      writeFileSync(filepath, code, 'utf-8');

      // Extract description from code (first comment or first meaningful line)
      const description = this.extractDescription(code);

      const now = new Date();
      return {
        name: filename,
        description,
        createdAtMs: now.getTime().toString(),
        contentHash: hash,
      };
    } catch {
      // Silently ignore caching errors - don't fail the execution
      return undefined;
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Sanitize a script name to be safe for filesystem use.
   * Converts to lowercase, replaces spaces and invalid chars with hyphens.
   */
  private sanitizeScriptName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/\.ts$/, '') // Remove .ts extension if provided
      .replace(/[^a-z0-9-_]/g, '-') // Replace invalid chars with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Extract a description from code.
   * Looks for first comment line or first non-empty line.
   */
  private extractDescription(code: string): string {
    const lines = code.trim().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines
      if (!trimmed) continue;
      // Single-line comment
      if (trimmed.startsWith('//')) {
        return trimmed.slice(2).trim();
      }
      // Multi-line comment start
      if (trimmed.startsWith('/*')) {
        const match = trimmed.match(/\/\*\*?\s*(.+?)(?:\*\/)?$/);
        if (match) return match[1].trim();
      }
      // Use first meaningful code line as fallback
      return trimmed.slice(0, 100);
    }
    return 'Script execution';
  }

  /**
   * Find a cached code by name (exact or partial match).
   * Returns the full path, filename, and code if found.
   */
  find(name: string): CachedCode | null {
    if (!existsSync(this.cacheDir)) {
      return null;
    }

    const files = readdirSync(this.cacheDir).filter(f => f.endsWith('.ts'));

    // Try exact match first (with or without .ts extension)
    const exactName = name.endsWith('.ts') ? name : `${name}.ts`;
    if (files.includes(exactName)) {
      const path = join(this.cacheDir, exactName);
      return { path, filename: exactName, code: this.readCode(path) };
    }

    // Try partial match (name contains the search term)
    const partialMatch = files.find(f =>
      f.toLowerCase().includes(name.toLowerCase())
    );
    if (partialMatch) {
      const path = join(this.cacheDir, partialMatch);
      return { path, filename: partialMatch, code: this.readCode(path) };
    }

    return null;
  }

  /**
   * Read and return the code from a cached file.
   */
  private readCode(filePath: string): string {
    return readFileSync(filePath, 'utf-8');
  }

  /**
   * List all cached entries.
   * Optionally filter by name pattern.
   */
  list(filter?: string): CacheEntry[] {
    if (!existsSync(this.cacheDir)) {
      return [];
    }

    const files = readdirSync(this.cacheDir).filter(f => f.endsWith('.ts'));
    const entries: CacheEntry[] = [];

    for (const filename of files) {
      // Apply filter if provided
      if (filter && !filename.toLowerCase().includes(filter.toLowerCase())) {
        continue;
      }

      const filepath = join(this.cacheDir, filename);
      try {
        const stats = statSync(filepath);
        const code = this.readCode(filepath);
        const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);

        entries.push({
          name: filename,
          description: this.extractDescription(code),
          createdAtMs: stats.mtimeMs.toString(),
          contentHash: hash,
        });
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    // Sort by creation time (newest first)
    entries.sort((a, b) => Number(b.createdAtMs) - Number(a.createdAtMs));

    return entries;
  }

  /**
   * Clear all cached entries.
   * Returns the number of entries deleted.
   */
  clear(): number {
    if (!existsSync(this.cacheDir)) {
      return 0;
    }

    const files = readdirSync(this.cacheDir).filter(f => f.endsWith('.ts'));
    let deleted = 0;

    for (const filename of files) {
      try {
        unlinkSync(join(this.cacheDir, filename));
        deleted++;
      } catch {
        // Ignore deletion errors
      }
    }

    return deleted;
  }
}
