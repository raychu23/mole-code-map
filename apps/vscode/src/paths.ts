import { relative, resolve, sep } from 'node:path';

/** Repo-relative POSIX path of a file URI's fsPath, or undefined when it is outside the repo root. */
export function toRepoPath(root: string, fsPath: string): string | undefined {
  const rel = relative(resolve(root), resolve(fsPath));
  if (!rel || rel.startsWith('..') || resolve(rel) === rel) return undefined;
  return rel.split(sep).join('/');
}

/**
 * Leading + trailing debounce: the first call runs at once (a single deliberate file switch pays no waiting), calls that
 * follow within `ms` are coalesced into one trailing call with the last arguments (rapid tabbing does not hammer the daemon).
 */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: NodeJS.Timeout | undefined;
  let pending: A | undefined;
  const open = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (pending) {
        const a = pending;
        pending = undefined;
        fn(...a);
        open();
      }
    }, ms);
  };
  return (...a: A) => {
    if (timer) {
      pending = a;
      return;
    }
    fn(...a);
    open();
  };
}
