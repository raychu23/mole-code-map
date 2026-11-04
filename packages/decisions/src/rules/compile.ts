// RuleSpec[] -> a dependency-cruiser ruleSet (`forbidden`, one rule per import rule) and the cruise options Mole runs it with.
import { anyOf, pathRegex, toRegex } from './parse.js';
import type { RuleSpec } from './types.js';

export type DepcruiseRule = {
  name: string;
  severity: 'error';
  comment: string;
  from: { path: string; pathNot?: string };
  to: { path: string; dynamic?: boolean };
};

export const cite = (r: RuleSpec): string =>
  `${r.decision} "${r.title}" (${r.status})${r.why ? `: ${r.why}` : ''} [${r.file}:${r.line}]`;

/** One dependency-cruiser forbidden rule per import rule; its comment cites the decision, why and record file:line.
 * Type-only imports are NOT filtered here: dependency-cruiser reports an unresolved module's `import type` as
 * dependencyTypes ['unknown'], so Mole filters type-only sites with its own TS AST pass (see check.ts). */
export function depcruiseRuleSet(rules: RuleSpec[], opts: { siteFilter?: boolean } = {}): { forbidden: DepcruiseRule[] } {
  const forbidden: DepcruiseRule[] = [];
  for (const r of rules) {
    if (r.kind !== 'import') continue;
    forbidden.push({
      name: r.name,
      severity: 'error',
      comment: cite(r),
      from: { path: pathRegex(r.from), ...(r.except.length ? { pathNot: anyOf(r.except.map(pathRegex)) } : {}) },
      // siteFilter (checkRules): dynamic: is applied per import site by Mole, because dependency-cruiser merges a static and a
      // dynamic import of one module into a single {dynamic: false} dependency (review 1 P2-1)
      to: { path: anyOf(r.to.map(toRegex)), ...(r.dynamic === undefined || opts.siteFilter ? {} : { dynamic: r.dynamic }) },
    });
  }
  return { forbidden };
}

/** Files never scanned as rule sources (build output, git, Mole's own records, declaration files). */
export const EXCLUDE = '(^|/)(node_modules|dist|\\.git|\\.mole)/|\\.d\\.[cm]?ts$';

/** Options for dependency-cruiser: symlinks kept so a workspace package resolves to node_modules/<name>/..., TypeScript
 * imports read before compilation (type-only kept), and only modules inside a rule's `from` are followed (their direct
 * dependencies are what the rules judge). maxDepth is NOT used: a module first reached at the depth limit is never
 * expanded, even when it is itself an entry (probe 2026-10-29: src/core/a.ts -> src/ui/view.ts hid view.ts's imports). */
export function cruiseOptions(froms: string[]) {
  // doNotFollow, not exclude: dependency-cruiser drops an excluded module as a dependency too, so excluding dist/ would hide
  // node_modules/@mole/indexer/dist/... imports. A doNotFollow module stays a dependency node; it is just never scanned
  // (and is not an initial source), which keeps node_modules, build output and code outside every rule's `from` unread.
  // dependency-cruiser also tests every directory it gathers from an entry against doNotFollow (without a trailing '/'), so
  // the outside-every-from part only matches source FILES: otherwise `src` itself, or `packages` under a `packages/*/src/`
  // from, is pruned and the cruise reads 0 modules (review 1 P1-1). No `validate` here: it is a cruise() API flag and the
  // depcruise CLI rejects a config whose options carry it (checkRules passes it to the API itself).
  // (safe-regex refuses nested quantifiers here, so a folder named like a source file, e.g. `apps/x.js/`, outside every from
  // is pruned too: a from under such a folder would cruise 0 modules; the dead-rule warning does not catch this case)
  const skip = '(^|/)(node_modules|dist|\\.git|\\.mole)/';
  const file = '.*\\.(?:[cm]?[jt]sx?|vue|svelte|json)$';
  return {
    tsPreCompilationDeps: true,
    preserveSymlinks: true,
    doNotFollow: { path: froms.length ? `${skip}|^(?!${anyOf(froms.map(pathRegex))})${file}` : skip },
  };
}

/** The source roots to hand dependency-cruiser / the call scan: each `from`'s static prefix (before any glob). */
export function entryPrefixes(froms: string[]): string[] {
  const out = new Set<string>();
  for (const f of froms) {
    const s = f.replace(/^\.\//, '');
    const g = s.search(/[*?{]/);
    let p = g < 0 ? s : s.slice(0, s.lastIndexOf('/', g) + 1);
    p = p.replace(/\/+$/, '');
    out.add(p === '' ? '.' : p);
  }
  if (out.has('.')) return ['.'];
  // drop prefixes inside another prefix
  const list = [...out].sort();
  return list.filter((p) => !list.some((q) => q !== p && p.startsWith(`${q}/`)));
}
