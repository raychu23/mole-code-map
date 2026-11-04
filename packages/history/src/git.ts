// git plumbing for @mole/history: read-only commands only (diff, blame, show, log, ls-tree, grep, rev-parse).
import { execFile } from 'node:child_process';

/** run git in repoRoot; never takes optional locks (no index refresh writes) */
export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolveP, reject) => {
    execFile(
      'git',
      ['-C', root, '--no-optional-locks', '-c', 'core.quotePath=false', ...args],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.slice(0, 2).join(' ')}: ${(stderr || err.message).trim().split('\n')[0]}`));
        else resolveP(stdout);
      },
    );
  });
}

/** run fns with at most n in flight */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
