import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which sources to index when the user set nothing. The indexer's own default is `<root>/src`; a repository without one
 * (a monorepo with packages/*\/src, a project with lib/ or app/, or .ts files in the root) would otherwise get an empty
 * map that looks broken. Fall back to the whole folder (the indexer skips node_modules, dist and dot-folders).
 * An explicit tsconfig or source folder is always respected.
 */
export function defaultSources(root: string, tsconfig?: string, srcDir?: string): { tsconfig?: string; srcDir?: string } {
  if (tsconfig || srcDir) return { tsconfig, srcDir };
  if (existsSync(join(root, 'src'))) return {};
  return { srcDir: '.' };
}
