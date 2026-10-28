import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Git's common dir (shared by every worktree of a repo), or undefined outside git. */
export function gitCommonDir(root: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return isAbsolute(out) ? out : resolve(root, out);
  } catch {
    return undefined;
  }
}

/**
 * Where the daemon keeps its lock and the SQLite graph: `<git common dir>/mole` (one daemon per repo, shared by
 * worktrees), `<root>/.mole` outside git. `override` / MOLE_STATE_DIR exists so a read-only repo (the benchmark
 * fixtures) never gets written to.
 */
export function stateDir(root: string, override?: string): string {
  const dir = override ?? process.env.MOLE_STATE_DIR ?? (gitCommonDir(root) ? join(gitCommonDir(root) as string, 'mole') : join(root, '.mole'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Unix sockets are limited to ~104 bytes on macOS, so the socket lives in /tmp keyed by repo + state dir. */
export function socketPath(root: string, dir: string): string {
  const key = createHash('sha1').update(`${resolve(root)}\0${resolve(dir)}`).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\mole-${key}` : join(process.platform === 'darwin' || process.platform === 'linux' ? '/tmp' : tmpdir(), `mole-${key}.sock`);
}

/** Worktrees of one repo share the state dir, but each worktree root has its own lock, daemon and graph. */
export const rootKey = (root: string): string => createHash('sha1').update(resolve(root)).digest('hex').slice(0, 10);
export const lockPath = (dir: string, root: string): string => join(dir, `daemon-${rootKey(root)}.lock`);
export const dbPath = (dir: string, root: string): string => join(dir, `graph-${rootKey(root)}.sqlite`);
export const hasDb = (dir: string, root: string): boolean => existsSync(dbPath(dir, root));
