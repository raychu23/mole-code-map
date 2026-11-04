// Vite plugin (vitest runs every module through Vite): instruments the repo's own source and test files.
// Built output of the repo's packages (…/dist/x.js) is instrumented under its source path (…/src/x.ts) so the ids
// match the static graph; node_modules, files outside the root and the flows package itself are left alone.
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { instrumentSource } from './instrument.js';

const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** dist/x.js -> the source it was built from (x.ts / src/x.ts / .tsx), or undefined when there is none */
export function sourceOfBuilt(root: string, rel: string): string | undefined {
  const m = /^(.*?)dist\/(.+)\.[cm]?js$/.exec(rel);
  if (!m) return undefined;
  const [, pre, rest] = m as unknown as [string, string, string];
  for (const cand of [`${pre}${rest}`, `${pre}src/${rest}`]) for (const ext of ['.ts', '.tsx', '.mts']) if (existsSync(join(root, cand + ext))) return cand + ext;
  return undefined;
}

export interface FlowsPluginOptions {
  root: string;
  /** absolute directories never instrumented (the flows runtime itself) */
  exclude?: string[];
  /** absolute files instrumented as muted frames: the test harness's setup files are not repo code (and not graph
   * nodes), but their mocks run between repo frames, so they must still hold the stack */
  muted?: string[];
}

export function moleFlowsPlugin(opts: FlowsPluginOptions) {
  const root = resolve(opts.root);
  const exclude = (opts.exclude ?? []).map((d) => resolve(d) + sep);
  const muted = new Set((opts.muted ?? []).map((f) => resolve(f)));
  return {
    name: 'mole-flows',
    enforce: 'pre' as const,
    transform(code: string, id: string): { code: string; map: null } | null {
      if (id.startsWith('\0')) return null;
      const file = id.split('?')[0]!;
      if (!CODE.test(file) || file.endsWith('.d.ts') || file.includes(`${sep}node_modules${sep}`)) return null;
      if (!file.startsWith(root + sep) || exclude.some((d) => file.startsWith(d))) return null;
      const rel = relative(root, file).split(sep).join('/');
      if (rel.split('/').some((seg) => seg.startsWith('.'))) return null; // dot folders (.mole store, .git): not repo code, the static graph skips them too
      let idPath = rel;
      if (/(^|\/)dist\//.test(rel)) {
        const src = sourceOfBuilt(root, rel);
        if (!src) return null;
        idPath = src;
      }
      try {
        const r = instrumentSource(code, rel, { idPath, muted: muted.has(file) });
        return r ? { code: r.code, map: null } : null;
      } catch {
        return null; // never break a test run over a file the transform cannot handle: it just is not recorded
      }
    },
  };
}
