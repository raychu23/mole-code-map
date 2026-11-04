// Call graph for selection: @mole/indexer's TypeScript Compiler API graph (SQLite), test files included.
// Reused from a SQLite file while its recorded commit + root match (HEAD), else rebuilt.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { gitHead, openDb, TsIndexer } from '@mole/indexer';

export const RUNNER_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const SOURCE = /\.(?:ts|tsx|mts|cts)$/;

/** tsconfig for the index: the root one when it has compilerOptions, else one generated with npm-workspace paths */
function tsconfigFor(root: string): string {
  const own = join(root, 'tsconfig.json');
  if (existsSync(own)) {
    const read = ts.readConfigFile(own, ts.sys.readFile);
    if (read.config && read.config.compilerOptions && !(Array.isArray(read.config.files) && read.config.files.length === 0)) return own;
  }
  const paths: Record<string, string[]> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
    const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    for (const g of globs) {
      const m = /^(.*)\/\*$/.exec(g);
      const dirs = m ? listDirs(join(root, m[1]!)) : [join(root, g)];
      for (const d of dirs) {
        try {
          const name = (JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as { name?: string }).name;
          if (!name) continue;
          for (const entry of ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx']) {
            if (existsSync(join(d, entry))) {
              paths[name] = [join(d, entry)];
              paths[`${name}/*`] = [join(d, dirname(entry) === '.' ? '*' : `${dirname(entry)}/*`)];
              break;
            }
          }
        } catch {
          // not a package
        }
      }
    }
  } catch {
    // no package.json: no workspace paths
  }
  const dir = join(root, '.mole/local/verify');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tsconfig.index.json');
  const cfg = {
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, allowJs: false, noEmit: true, baseUrl: root, paths },
    files: [],
  };
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

function listDirs(d: string): string[] {
  try {
    return ts.sys.getDirectories(d).map((n) => join(d, n));
  } catch {
    return [];
  }
}

export interface Graph {
  db: DatabaseSync;
  built: boolean;
  ms: number;
  close(): void;
}

export function openGraph(root: string, graphDb?: string): Graph {
  const t0 = performance.now();
  const head = gitHead(root);
  if (graphDb && existsSync(graphDb)) {
    const db = openDb(graphDb);
    const meta = new Map(db.prepare('SELECT key, value FROM meta').all().map((r) => [String(r.key), String(r.value)]));
    if (head !== 'unversioned' && meta.get('commit') === head && meta.get('root') === resolve(root) && meta.get('verify') === '1') {
      return { db, built: false, ms: performance.now() - t0, close: () => db.close() };
    }
    db.close();
    for (const f of [graphDb, `${graphDb}-wal`, `${graphDb}-shm`]) rmSync(f, { force: true });
  }
  if (graphDb) mkdirSync(dirname(graphDb), { recursive: true });
  const indexer = new TsIndexer({ root, dbPath: graphDb ?? ':memory:', tsconfig: tsconfigFor(root), srcDir: '.' });
  indexer.indexAll();
  // marks a graph built with test files included (srcDir '.'), so a daemon's src-only graph is never mistaken for it
  indexer.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('verify', '1');
  return { db: indexer.db, built: true, ms: performance.now() - t0, close: () => indexer.close() };
}

export interface Caller {
  from: string;
  path: string;
  line: number;
}

export function callersOf(db: DatabaseSync, id: string): Caller[] {
  return db
    .prepare("SELECT from_id, path, line FROM edges WHERE to_id = ? AND kind = 'calls'")
    .all(id)
    .map((r) => ({ from: String(r.from_id), path: String(r.path), line: Number(r.line) }));
}

export function importersOf(db: DatabaseSync, path: string): Caller[] {
  return db
    .prepare("SELECT from_id, path, line FROM edges WHERE to_id = ? AND kind = 'imports'")
    .all(`file:${path}#${path}`)
    .map((r) => ({ from: String(r.from_id), path: String(r.path), line: Number(r.line) }));
}

export function hasNode(db: DatabaseSync, id: string): boolean {
  return db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id) !== undefined;
}

// ---- edited symbols: the innermost declaration the indexer tracks that holds an edited line --------------------------

export interface Decl {
  id: string;
  kind: string;
  name: string;
  start: number;
  end: number;
  line: number;
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
};
const memberName = (n: ts.PropertyName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined;

/** declarations with the same ids @mole/indexer gives them (function:, class:, method:, type:, variable:) */
export function declarations(path: string, text: string): Decl[] {
  const kind = /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out: Decl[] = [];
  const push = (k: string, q: string, node: ts.Node): void => {
    out.push({ id: `${k}:${path}#${q}`, kind: k, name: q, start: line(node.getStart(sf)), end: line(node.getEnd()), line: line(node.getStart(sf)) });
  };
  const walk = (stmts: ts.NodeArray<ts.Statement>, prefix: string): void => {
    for (const st of stmts) {
      if (ts.isFunctionDeclaration(st) && st.name) push('function', prefix + st.name.text, st);
      else if ((ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name) {
        const cls = prefix + st.name.text;
        push(ts.isClassDeclaration(st) ? 'class' : 'type', cls, st);
        for (const m of st.members) {
          const n = memberName(m.name as ts.PropertyName | undefined);
          if (ts.isConstructorDeclaration(m)) push('method', `${cls}.constructor`, m);
          else if ((ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && n) push('method', `${cls}.${n}`, m);
          else if ((ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) && n) {
            const init = ts.isPropertyDeclaration(m) && m.initializer ? unwrap(m.initializer) : undefined;
            if ((init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) || (m.type && ts.isFunctionTypeNode(m.type))) push('method', `${cls}.${n}`, m);
          }
        }
      } else if ((ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) push('type', prefix + st.name.text, st);
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const init = d.initializer ? unwrap(d.initializer) : undefined;
          const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
          out.push({ id: `${fn ? 'function' : 'variable'}:${path}#${prefix}${d.name.text}`, kind: fn ? 'function' : 'variable', name: prefix + d.name.text, start: line(st.getStart(sf)), end: line(st.getEnd()), line: line(st.getStart(sf)) });
        }
      } else if (ts.isModuleDeclaration(st) && ts.isStringLiteral(st.name) && st.body && ts.isModuleBlock(st.body)) walk(st.body.statements, `${st.name.text}::`);
    }
  };
  walk(sf.statements, '');
  return out;
}

/** innermost declaration holding any of the lines (methods before their class) */
export function enclosing(decls: Decl[], lines: number[]): Decl[] {
  const hits = new Map<string, Decl>();
  for (const l of lines) {
    const holding = decls.filter((d) => d.start <= l && l <= d.end);
    if (!holding.length) continue;
    const inner = holding.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
    hits.set(inner.id, inner);
  }
  return [...hits.values()];
}

/** functions/methods in the same file whose text mentions `name` as a word (for edits to constants and types) */
export function usersInFile(decls: Decl[], text: string, name: string, self: string): Decl[] {
  const lines = text.split('\n');
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return decls.filter((d) => d.id !== self && (d.kind === 'function' || d.kind === 'method') && word.test(lines.slice(d.start, d.end).join('\n')));
}
