import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Get the package root directory.
 * This works for both ESM and when compiled to dist/.
 */
export function getPackageRoot(): string {
  // When this file is in dist/util/paths.js, we go up 2 levels to get to the package root
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '../..');
}

export const PACKAGE_ROOT = getPackageRoot();

