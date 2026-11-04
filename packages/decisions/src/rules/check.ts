// checkRules: run a repo's decision rules. Import rules go through dependency-cruiser (resolution + rule matching);
// Mole's TS AST pass then finds each import's line and drops type-only / dynamic sites the rule allows. Call rules are
// Mole's own TS AST scan (dependency-cruiser sees imports, not calls). Every violation cites its decision.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type TS from 'typescript';
import { computeFlags } from '../flags.js';
import { loadGraph } from '../graph.js';
import type { Flag } from '../types.js';
import { cruiseOptions, depcruiseRuleSet, entryPrefixes, EXCLUDE } from './compile.js';
import { anyOf, isModuleName, loadRules, pathRegex } from './parse.js';
import type { RuleSpec, RulesOptions, RulesResult, Violation } from './types.js';

type TSMod = typeof TS;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const posix = (p: string) => p.split(sep).join('/');

interface Site {
  spec: string;
  line: number;
  kind: 'static' | 'dynamic' | 'type';
}

class Sources {
  private cache = new Map<string, TS.SourceFile | null>();
  constructor(
    private ts: TSMod,
    private root: string,
  ) {}
  get(rel: string): TS.SourceFile | null {
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    let sf: TS.SourceFile | null = null;
    try {
      const text = readFileSync(join(this.root, rel), 'utf8');
      const ext = rel.slice(rel.lastIndexOf('.'));
      const k = this.ts.ScriptKind;
      const kind = ext.endsWith('x') ? (ext.includes('t') ? k.TSX : k.JSX) : ext.includes('t') ? k.TS : k.JS;
      sf = this.ts.createSourceFile(rel, text, this.ts.ScriptTarget.Latest, true, kind);
    } catch {
      sf = null;
    }
    this.cache.set(rel, sf);
    return sf;
  }
}

const lineOf = (sf: TS.SourceFile, n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** Every import site of a file: import / export-from / import = require / import() / require() / import('x').T */
function importSites(ts: TSMod, sf: TS.SourceFile): Site[] {
  const out: Site[] = [];
  const lit = (n: TS.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
  const visit = (n: TS.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = lit(n.moduleSpecifier);
      const c = n.importClause;
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : undefined;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      if (spec !== undefined) out.push({ spec, line: lineOf(sf, n), kind: typeOnly ? 'type' : 'static' });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = lit(n.moduleSpecifier);
      const named = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements : undefined;
      const typeOnly = n.isTypeOnly || (!!named && named.length > 0 && named.every((e) => e.isTypeOnly));
      if (spec !== undefined) out.push({ spec, line: lineOf(sf, n), kind: typeOnly ? 'type' : 'static' });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = lit(n.moduleReference.expression);
      if (spec !== undefined) out.push({ spec, line: lineOf(sf, n), kind: n.isTypeOnly ? 'type' : 'static' });
    } else if (ts.isCallExpression(n)) {
      const spec = lit(n.arguments[0]);
      if (spec !== undefined && n.expression.kind === ts.SyntaxKind.ImportKeyword) out.push({ spec, line: lineOf(sf, n), kind: 'dynamic' });
      else if (spec !== undefined && ts.isIdentifier(n.expression) && n.expression.text === 'require') out.push({ spec, line: lineOf(sf, n), kind: 'static' });
    } else if (ts.isImportTypeNode(n)) {
      const a = n.argument;
      const spec = ts.isLiteralTypeNode(a) ? lit(a.literal) : undefined;
      if (spec !== undefined) out.push({ spec, line: lineOf(sf, n), kind: 'type' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Callee text of a call, normalized: whitespace, `?.` and `!` dropped (fs?.rmSync -> fs.rmSync). */
function calleeText(sf: TS.SourceFile, e: TS.Expression): string {
  return e.getText(sf).replace(/\s+/g, '').replace(/\?\./g, '.').replace(/!/g, '');
}

function walkFiles(root: string, prefix: string, out: Set<string>): void {
  const abs = join(root, prefix);
  if (!existsSync(abs)) return;
  const exclude = new RegExp(EXCLUDE);
  const st = statSync(abs);
  if (st.isFile()) {
    if (SOURCE.test(prefix)) out.add(posix(prefix));
    return;
  }
  const rec = (dir: string): void => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!exclude.test(`${rel}/`)) rec(rel);
      } else if (SOURCE.test(e.name) && !exclude.test(rel)) out.add(posix(rel));
    }
  };
  rec(prefix);
}

type CruiseDep = { module: string; protocol?: string; resolved: string; dynamic: boolean; valid: boolean; dependencyTypes?: string[]; rules?: Array<{ name: string }> };
type CruiseModule = { source: string; dependencies: CruiseDep[] };

/** Run every rule of root's decision records. */
export async function checkRules(root: string, opts: RulesOptions = {}): Promise<RulesResult> {
  const t0 = Date.now();
  const load = loadRules(root);
  const violations: Violation[] = [];
  const result = (): RulesResult => ({ root, ...load, violations: sortV(violations), ms: Date.now() - t0 });
  if (load.rules.length === 0) return result();

  // a from: or path to: that matches no source file narrows the rule to nothing and reads as green (review 1 P2-2)
  const filesUnder = new Map<string, Set<string>>();
  const anyFile = (p: string): boolean => {
    const re = new RegExp(pathRegex(p));
    for (const pre of entryPrefixes([p])) {
      if (!filesUnder.has(pre)) {
        const s = new Set<string>();
        walkFiles(root, pre, s);
        filesUnder.set(pre, s);
      }
      for (const f of filesUnder.get(pre)!) if (re.test(f)) return true;
    }
    return false;
  };
  for (const r of load.rules) {
    const dead = [r.from, ...r.to.filter((t) => !isModuleName(t))].filter((p) => !anyFile(p));
    for (const p of dead) load.warnings.push({ file: r.file, line: r.line, message: `rule ${r.name}: ${p === r.from ? 'from' : 'to'}: '${p}' matches no source file (typo?)` });
  }

  const flags = new Map<string, Flag>();
  try {
    for (const f of computeFlags(loadGraph(root))) flags.set(f.id, f.flag);
  } catch {
    // flags are context, not the check: a tree without git history still gets its violations
  }
  const ts = ((await import('typescript')) as unknown as { default: TSMod }).default;
  const sources = new Sources(ts, root);
  const byName = new Map(load.rules.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const add = (r: RuleSpec, file: string, line: number, target: string) => {
    const k = `${file}:${line}:${r.name}:${target}`;
    if (seen.has(k)) return;
    seen.add(k);
    violations.push({
      file,
      line,
      rule: r.name,
      kind: r.kind,
      target,
      decision: { id: r.decision, title: r.title, status: r.status, flag: flags.get(r.decision), ...(r.why ? { why: r.why } : {}), file: r.file, line: r.line },
    });
  };

  // ---- import rules: dependency-cruiser
  const imports = load.rules.filter((r) => r.kind === 'import');
  const entries = entryPrefixes(imports.map((r) => r.from)).filter((p) => existsSync(join(root, p)));
  if (imports.length && entries.length) {
    const { cruise } = await import('dependency-cruiser');
    const tsConfigFile = opts.tsConfig ? (isAbsolute(opts.tsConfig) ? opts.tsConfig : join(root, opts.tsConfig)) : undefined;
    let transpile: Record<string, unknown> = {};
    if (tsConfigFile) {
      const extract = ((await import('dependency-cruiser/config-utl/extract-ts-config')) as unknown as { default: (f: string) => unknown }).default;
      transpile = { tsConfig: extract(tsConfigFile) };
    }
    const res = await cruise(
      entries,
      {
        ...cruiseOptions(imports.map((r) => r.from)),
        validate: true,
        baseDir: root,
        ruleSet: depcruiseRuleSet(imports, { siteFilter: true }) as never,
        ...(tsConfigFile ? { tsConfig: { fileName: relative(root, tsConfigFile) } } : {}),
      },
      {},
      transpile,
    );
    const modules = (res.output as unknown as { modules: CruiseModule[] }).modules;
    for (const m of modules)
      for (const d of m.dependencies) {
        if (d.valid || !d.rules) continue;
        const sf = sources.get(m.source);
        const sites = (sf ? importSites(ts, sf) : []).filter((s) => s.spec === d.module || s.spec === `${d.protocol ?? ''}${d.module}`);
        for (const hit of d.rules) {
          const r = byName.get(hit.name);
          if (!r) continue;
          // each site judged on its own: dependency-cruiser merges a static and a dynamic import of one module into one
          // {dynamic: false} dependency, so d.dynamic says nothing about a given site (review 1 P2-1)
          for (const s of sites) {
            if (s.kind === 'type' && !r.types) continue; // erased at build: loads nothing
            if (r.dynamic === false && s.kind === 'dynamic') continue;
            if (r.dynamic === true && s.kind !== 'dynamic') continue;
            add(r, m.source, s.line, s.spec);
          }
          // no import site Mole's AST pass knows (/// <reference path>, ...): report dependency-cruiser's finding at line 1
          // rather than drop it (review 1 P2-4)
          if (sites.length === 0) {
            if (r.dynamic !== undefined && r.dynamic !== d.dynamic) continue;
            if (!r.types && d.dependencyTypes?.includes('type-only')) continue;
            add(r, m.source, 1, d.module);
          }
        }
      }
  }

  // ---- call rules: Mole's TS AST scan
  const calls = load.rules.filter((r) => r.kind === 'call');
  if (calls.length) {
    const files = new Set<string>();
    for (const p of entryPrefixes(calls.map((r) => r.from))) walkFiles(root, p, files);
    const compiled = calls.map((r) => ({
      r,
      from: new RegExp(pathRegex(r.from)),
      except: r.except.length ? new RegExp(anyOf(r.except.map(pathRegex))) : undefined,
    }));
    for (const file of [...files].sort()) {
      const rules = compiled.filter((c) => c.from.test(file) && !c.except?.test(file));
      if (!rules.length) continue;
      const sf = sources.get(file);
      if (!sf) continue;
      const visit = (n: TS.Node): void => {
        if (ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) {
          const text = calleeText(sf, n.expression);
          for (const { r } of rules) if (r.callee.some((c) => text === c || text.endsWith(`.${c}`))) add(r, file, lineOf(sf, n), text);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return result();
}

function sortV(v: Violation[]): Violation[] {
  return v.sort((a, b) => (a.file === b.file ? a.line - b.line || a.rule.localeCompare(b.rule) : a.file < b.file ? -1 : 1));
}
