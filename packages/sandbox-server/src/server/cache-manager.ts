import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
   * Returns the cached filename if a new file was created.
   */
  async cache(code: string): Promise<string | undefined> {
    await this.mutex.acquire();

    try {
      this.ensureDirectory();

      // Create a hash-based filename to deduplicate by content
      const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);

      // Check if code with this hash already exists
      const existingFiles = readdirSync(this.cacheDir);
      const existingScript = existingFiles.find(f => f.includes(hash) && f.endsWith('.ts'));

      if (existingScript) {
        // Code with same content already cached
        return undefined;
      }

      // Create new file with timestamp and hash
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `script-${timestamp}-${hash}.ts`;
      const filepath = join(this.cacheDir, filename);

      // Add a header comment with execution timestamp
      const header = `// Executed via sandbox at ${new Date().toISOString()}\n`;
      writeFileSync(filepath, header + code, 'utf-8');

      return filename;
    } catch {
      // Silently ignore caching errors - don't fail the execution
      return undefined;
    } finally {
      this.mutex.release();
    }
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
   * Strips the auto-generated header comment if present.
   */
  private readCode(filePath: string): string {
    const content = readFileSync(filePath, 'utf-8');
    // Strip the auto-generated header comment (first line if it starts with "// Executed via")
    const lines = content.split('\n');
    if (lines[0]?.startsWith('// Executed via')) {
      return lines.slice(1).join('\n').trim();
    }
    return content;
  }
}
