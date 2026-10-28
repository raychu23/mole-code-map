import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import type { EdgeKind, Evidence, NodeKind } from '@mole/core';
import { clearFile, insertEdge, insertFile, insertNode, openDb, type FileStatus } from './db.js';

export interface IndexOptions {
  /** Repo root; every stored path is relative to it, with forward slashes. */
  root: string;
  /** SQLite file, or ':memory:' (default). */
  dbPath?: string;
  /** tsconfig to take compiler options + file list from (absolute, or relative to root). */
  tsconfig?: string;
  /** Index every .ts/.tsx under this dir (default 'src' without a tsconfig; with one, overrides its file list). */
  srcDir?: string;
  /** Commit the evidence is read at; default git HEAD of root, else 'unversioned'. */
  commit?: string;
}

export interface IndexStats {
  files: number;
  partialFiles: number;
  nodes: number;
  edges: number;
  ms: number;
}

interface Tracked {
  id: string;
  kind: NodeKind;
  name: string;
  qualified: string;
}

const TS_EXT = /\.(?:ts|tsx|mts|cts)$/;

export function gitHead(root: string): string {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unversioned';
  }
}

function listSources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listSources(p, out);
    else if (TS_EXT.test(e.name)) out.push(p);
  }
  return out;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function memberName(n: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return undefined;
}

/** Cache parsed source files by mtime so a 1-file update does not re-parse the program. */
function cachingHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const cache = new Map<string, { mtime: number; sf: ts.SourceFile }>();
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    let mtime = -1;
    try {
      mtime = statSync(fileName).mtimeMs;
    } catch {
      return orig(fileName, languageVersionOrOptions, onError, shouldCreate);
    }
    const hit = cache.get(fileName);
    if (hit && hit.mtime === mtime) return hit.sf;
    const sf = orig(fileName, languageVersionOrOptions, onError, shouldCreate);
    if (sf) cache.set(fileName, { mtime, sf });
    return sf;
  };
  return host;
}

/**
 * TypeScript Compiler API engine (plan M0 candidate A). Resolves calls with the real type checker,
 * writes the Mole graph schema (packages/core) into SQLite with file:line@commit evidence.
 */
export class TsIndexer {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly commit: string;
  private options: ts.CompilerOptions = {};
  private rootNames: string[] = [];
  private host!: ts.CompilerHost;
  private program!: ts.Program;
  private checker!: ts.TypeChecker;
  private inProject = new Set<string>();

  constructor(private readonly opts: IndexOptions) {
    this.root = resolve(opts.root);
    this.db = openDb(opts.dbPath ?? ':memory:');
    this.commit = opts.commit ?? gitHead(this.root);
    this.loadConfig();
    this.host = cachingHost(this.options);
  }

  close(): void {
    this.db.close();
  }

  private loadConfig(): void {
    if (this.opts.tsconfig) {
      const cfgPath = resolve(this.root, this.opts.tsconfig);
      const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, resolve(cfgPath, '..'), undefined, cfgPath);
      this.options = { ...parsed.options, noEmit: true, composite: false, incremental: false, tsBuildInfoFile: undefined };
      // srcDir given with a tsconfig = take options from the config, files from the whole dir (tests included).
      this.rootNames = this.opts.srcDir ? listSources(resolve(this.root, this.opts.srcDir)) : parsed.fileNames.map((f) => resolve(f));
    } else {
      this.options = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        skipLibCheck: true,
        allowJs: false,
        noEmit: true,
      };
      this.rootNames = listSources(resolve(this.root, this.opts.srcDir ?? 'src'));
    }
  }

  private rel(fileName: string): string | undefined {
    const abs = resolve(fileName);
    const r = relative(this.root, abs);
    if (r.startsWith('..') || r.includes(`node_modules${sep}`)) return undefined;
    return r.split(sep).join('/');
  }

  private build(old?: ts.Program): void {
    this.program = ts.createProgram({ rootNames: this.rootNames, options: this.options, host: this.host, oldProgram: old });
    this.checker = this.program.getTypeChecker();
    this.inProject = new Set(this.rootNames.map((f) => resolve(f)));
  }

  /** Full index of every file. */
  indexAll(): IndexStats {
    const t0 = performance.now();
    this.build(); // the slow part, before the transaction: readers keep seeing the previous index until COMMIT
    this.db.exec('BEGIN');
    this.db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM files;');
    for (const sf of this.program.getSourceFiles()) if (this.inProject.has(resolve(sf.fileName))) this.extractFile(sf);
    this.db.exec('COMMIT');
    this.setMeta();
    return this.stats(performance.now() - t0);
  }

  /** Re-index one file after it changed on disk (or was added/removed). */
  updateFile(relPath: string): IndexStats {
    const t0 = performance.now();
    const abs = resolve(this.root, relPath);
    const exists = existsSync(abs);
    if (exists && !this.rootNames.includes(abs) && TS_EXT.test(abs)) this.rootNames.push(abs);
    if (!exists) this.rootNames = this.rootNames.filter((f) => f !== abs);
    this.build(this.program);
    this.db.exec('BEGIN');
    clearFile(this.db, relPath);
    const sf = this.program.getSourceFile(abs);
    if (exists && sf && this.inProject.has(abs)) this.extractFile(sf);
    // Edges in other files may point at symbols this file no longer defines: drop them (still-valid targets keep their ids).
    this.db.exec('DELETE FROM edges WHERE to_id NOT IN (SELECT id FROM nodes)');
    this.db.exec('COMMIT');
    return this.stats(performance.now() - t0);
  }

  private setMeta(): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    put.run('engine', 'typescript-compiler-api');
    put.run('typescript', ts.version);
    put.run('commit', this.commit);
    put.run('root', this.root);
  }

  private stats(ms: number): IndexStats {
    const n = (q: string): number => Number(this.db.prepare(q).get()?.c ?? 0);
    return {
      files: n('SELECT COUNT(*) c FROM files'),
      partialFiles: n("SELECT COUNT(*) c FROM files WHERE status='partial'"),
      nodes: n('SELECT COUNT(*) c FROM nodes'),
      edges: n('SELECT COUNT(*) c FROM edges'),
      ms,
    };
  }

  // ---- extraction -------------------------------------------------------------------------

  /** Which graph node (if any) a declaration is. Used both to create nodes and to resolve edge targets. */
  private describe(decl: ts.Node): Tracked | undefined {
    const sf = decl.getSourceFile();
    if (!this.inProject.has(resolve(sf.fileName))) return undefined;
    const path = this.rel(sf.fileName);
    if (!path) return undefined;
    // Members of `declare module 'x' { ... }` are qualified by the module name so two blocks in one file cannot collide.
    const modPrefix = (n: ts.Node): string => {
      const p = n.parent;
      return ts.isModuleBlock(p) && ts.isModuleDeclaration(p.parent) && ts.isStringLiteral(p.parent.name) ? `${p.parent.name.text}::` : '';
    };
    const mk = (kind: NodeKind, qualified: string, at: ts.Node = decl): Tracked => {
      const q = (ts.isSourceFile(at.parent) || ts.isModuleBlock(at.parent) ? modPrefix(at) : modPrefix(at.parent)) + qualified;
      const name = qualified.slice(qualified.lastIndexOf('.') + 1);
      return { id: `${kind}:${path}#${q}`, kind, name, qualified: q };
    };
    const topLevel = (n: ts.Node): boolean => ts.isSourceFile(n.parent) || ts.isModuleBlock(n.parent);
    const owner = (m: ts.Node): string | undefined => {
      const p = m.parent;
      if ((ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name && topLevel(p)) return p.name.text;
      return undefined;
    };
    if (ts.isFunctionDeclaration(decl) && decl.name && topLevel(decl)) return mk('function', decl.name.text);
    if (ts.isClassDeclaration(decl) && decl.name && topLevel(decl)) return mk('class', decl.name.text);
    if ((ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl)) && topLevel(decl)) return mk('type', decl.name.text);
    if (ts.isConstructorDeclaration(decl)) {
      const o = owner(decl);
      return o ? mk('method', `${o}.constructor`) : undefined;
    }
    if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
      const o = owner(decl);
      const n = memberName(decl.name);
      return o && n ? mk('method', `${o}.${n}`) : undefined;
    }
    if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) {
      const o = owner(decl);
      const n = memberName(decl.name);
      if (!o || !n) return undefined;
      const init = ts.isPropertyDeclaration(decl) && decl.initializer ? unwrap(decl.initializer) : undefined;
      const fnLike = (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) || (decl.type && ts.isFunctionTypeNode(decl.type));
      return fnLike ? mk('method', `${o}.${n}`) : undefined;
    }
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      const list = decl.parent;
      const stmt = list.parent;
      if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(stmt) || !topLevel(stmt)) return undefined;
      const init = decl.initializer ? unwrap(decl.initializer) : undefined;
      const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      return mk(isFn ? 'function' : 'variable', decl.name.text, stmt);
    }
    return undefined;
  }

  private targetOf(sym: ts.Symbol | undefined): Tracked | undefined {
    if (!sym) return undefined;
    let s = sym;
    if (s.flags & ts.SymbolFlags.Alias) {
      try {
        s = this.checker.getAliasedSymbol(s);
      } catch {
        return undefined;
      }
    }
    for (const d of s.declarations ?? []) {
      const t = this.describe(d);
      if (t) return t;
    }
    return undefined;
  }

  /**
   * `this.checked!(x)` inside an object literal: the checker resolves the member to the literal's own property
   * assignment (not a tracked node); the language service resolves it to the contextual interface member. Follow that.
   */
  private viaContextualType(sym: ts.Symbol): Tracked | undefined {
    for (const d of sym.declarations ?? []) {
      if (!ts.isPropertyAssignment(d) && !ts.isShorthandPropertyAssignment(d) && !ts.isMethodDeclaration(d)) continue;
      const lit = d.parent;
      if (!ts.isObjectLiteralExpression(lit)) continue;
      for (const ty of this.declaredTypesFor(lit)) {
        const t = this.targetOf(ty.getProperty(sym.name));
        if (t) return t;
      }
    }
    return undefined;
  }

  /**
   * Types the author declared for an object literal (not the literal's own inferred type): the parameter type when it
   * is a call argument (looking through `<T extends Action>` to its constraint), or the annotation of its variable.
   */
  private declaredTypesFor(lit: ts.ObjectLiteralExpression): ts.Type[] {
    const out: ts.Type[] = [];
    const add = (node: ts.TypeNode | undefined): void => {
      if (!node) return;
      const t = this.checker.getTypeFromTypeNode(node);
      out.push(t);
      const base = this.checker.getBaseConstraintOfType(t);
      if (base && base !== t) out.push(base);
    };
    let n: ts.Node = lit;
    while (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isSatisfiesExpression(n.parent)) n = n.parent;
    const p = n.parent;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments) {
      const i = p.arguments.indexOf(n as ts.Expression);
      const decl = i >= 0 ? this.checker.getResolvedSignature(p)?.declaration : undefined;
      const params = decl && !ts.isJSDocSignature(decl) ? decl.parameters : undefined;
      add(params?.[Math.min(i, params.length - 1)]?.type);
    } else if (ts.isVariableDeclaration(p)) add(p.type);
    return out;
  }

  private extractFile(sf: ts.SourceFile): void {
    const path = this.rel(sf.fileName);
    if (!path) return;
    const text = sf.text;
    let errors = 0;
    try {
      errors = this.program.getSyntacticDiagnostics(sf).length;
    } catch {
      errors = 1;
    }
    let failed = false;
    // Facts read from a file with syntax errors are best-effort: mark them 'inferred' so consumers can tell.
    const factStatus = errors > 0 ? 'inferred' : 'observed';
    const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const ev = (n: ts.Node): Evidence => ({ path, line: line(n), commit: this.commit });
    const fileId = `file:${path}#${path}`;
    insertNode(this.db, { id: fileId, kind: 'file', name: path.slice(path.lastIndexOf('/') + 1), layer: 'current', status: factStatus, evidence: { path, line: 1, commit: this.commit } });

    const edge = (from: string, to: string, kind: EdgeKind, at: ts.Node): void => {
      if (from === to && kind !== 'calls') return;
      insertEdge(this.db, { from, to, kind, layer: 'current', status: factStatus, evidence: ev(at) });
    };

    const visit = (node: ts.Node, enclosing: string): void => {
      let cur = enclosing;
      const t = this.describe(node);
      if (t && this.describeIsNodeOf(node, sf)) {
        insertNode(this.db, { id: t.id, kind: t.kind, name: t.name, layer: 'current', status: factStatus, evidence: ev(node) });
        edge(enclosing, t.id, 'contains', node);
        cur = t.id;
      }
      try {
        this.edgesFor(node, cur, edge);
      } catch {
        failed = true;
      }
      ts.forEachChild(node, (c) => visit(c, cur));
    };
    visit(sf, fileId);

    const status: FileStatus = errors > 0 || failed ? 'partial' : 'ok';
    insertFile(this.db, path, status, errors, createHash('sha1').update(text).digest('hex'));
  }

  /** describe() also accepts declarations from other files (for targets); node creation must be the file being walked. */
  private describeIsNodeOf(node: ts.Node, sf: ts.SourceFile): boolean {
    return node.getSourceFile() === sf;
  }

  private edgesFor(node: ts.Node, from: string, edge: (f: string, t: string, k: EdgeKind, at: ts.Node) => void): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      let at: ts.Node = callee;
      let sym: ts.Symbol | undefined;
      if (ts.isIdentifier(callee)) sym = this.checker.getSymbolAtLocation(callee);
      else if (ts.isPropertyAccessExpression(callee)) {
        sym = this.checker.getSymbolAtLocation(callee.name);
        at = callee.name;
      } else if (ts.isElementAccessExpression(callee)) {
        sym = this.checker.getSymbolAtLocation(callee.argumentExpression);
        at = callee.argumentExpression;
      }
      let target = this.targetOf(sym);
      if (!target && sym) target = this.viaContextualType(sym);
      if (!target) {
        const decl = this.checker.getResolvedSignature(node)?.declaration;
        if (decl) target = this.describe(decl);
      }
      if (target) edge(from, target.id, 'calls', at);
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        const msym = this.checker.getSymbolAtLocation(spec);
        const f = msym?.declarations?.find(ts.isSourceFile);
        if (f) {
          const p = this.rel(f.fileName);
          if (p && this.inProject.has(resolve(f.fileName))) edge(from, `file:${p}#${p}`, 'imports', node);
        }
      }
    } else if (ts.isHeritageClause(node)) {
      const kind: EdgeKind = node.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
      for (const t of node.types) {
        const target = this.targetOf(this.checker.getSymbolAtLocation(t.expression));
        if (target) edge(from, target.id, kind, t);
      }
    }
  }
}

/** Convenience: index a repo once. */
export function indexRepo(opts: IndexOptions): { indexer: TsIndexer; stats: IndexStats } {
  const indexer = new TsIndexer(opts);
  return { indexer, stats: indexer.indexAll() };
}

