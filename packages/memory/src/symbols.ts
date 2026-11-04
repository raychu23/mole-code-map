// Symbols a note can anchor to, and the normalized-body hash (comments + whitespace removed, string contents kept).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { CodeSymbol } from './index.js';

const isJsDoc = (n: ts.Node) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/** Token texts of a node in source order: trivia (whitespace, comments) never appears; JSX text loses its whitespace. */
function tokens(node: ts.Node, sf: ts.SourceFile, out: string[]): string[] {
  if (isJsDoc(node)) return out;
  const kids = node.getChildren(sf);
  if (kids.length === 0) {
    let text = node.getText(sf);
    if (node.kind === ts.SyntaxKind.JsxText) text = text.replace(/\s+/g, '');
    if (text !== '') out.push(text);
    return out;
  }
  for (const k of kids) tokens(k, sf, out);
  return out;
}

const digest = (toks: string[]) => createHash('sha256').update(toks.join('\n')).digest('hex').slice(0, 16);

const scriptKind = (path: string) => (/\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));

/** sha256 (16 hex) of the text's tokens: whitespace and comments do not count, string/template contents do. */
export function normalizedHash(text: string): string {
  const sf = parse('snippet.ts', text);
  return digest(tokens(sf, sf, []));
}

/** A symbol plus its declaration tokens (trivia-free; every declaration of an overloaded tail, in source order). */
export interface SymbolDecl {
  sym: CodeSymbol;
  tokens: string[];
}

/** Symbols of one source text (path is only used for names and the TS/TSX choice). */
export function symbolsOfText(path: string, text: string): CodeSymbol[] {
  return declsOfText(path, text).map((d) => d.sym);
}

/** symbolsOfText plus each symbol's tokens (T19 re-anchoring compares bodies token by token). */
export function declsOfText(path: string, text: string): SymbolDecl[] {
  const sf = parse(path, text);
  const out: Array<CodeSymbol & { hasBody: boolean; node: ts.Node }> = [];
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const push = (tail: string, node: ts.Node, kind: CodeSymbol['kind'], hasBody = true) =>
    out.push({
      qualifiedName: `${path}#${tail}`,
      path,
      tail,
      kind,
      startLine: line(node.getStart(sf)),
      endLine: line(node.getEnd()),
      hash: '', // set below from every declaration of the tail
      hasBody,
      node,
    });
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) push(st.name.text, st, 'function', st.body !== undefined);
    else if (ts.isClassDeclaration(st) && st.name) {
      const cls = st.name.text;
      push(cls, st, 'class');
      for (const m of st.members) {
        if (ts.isConstructorDeclaration(m)) push(`${cls}.constructor`, m, 'method', m.body !== undefined);
        else if (ts.isMethodDeclaration(m) && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) push(`${cls}.${m.name.text}`, m, 'method', m.body !== undefined);
      }
    } else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
      const d = st.declarationList.declarations[0]!;
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) push(d.name.text, st, 'function');
    }
  }
  // overloads share a tail: keep the implementation (the one with a body), else the first
  // the hash covers every declaration of the tail, so an edited overload signature makes the note stale (T11 review P2-1)
  const keep = new Map<string, CodeSymbol & { hasBody: boolean; node: ts.Node }>();
  const all = new Map<string, ts.Node[]>();
  for (const s of out) {
    const prev = keep.get(s.tail);
    if (!prev || (!prev.hasBody && s.hasBody)) keep.set(s.tail, s);
    all.set(s.tail, [...(all.get(s.tail) ?? []), s.node]);
  }
  return out
    .filter((s) => keep.get(s.tail) === s)
    .map(({ hasBody: _h, node: _n, ...s }) => {
      const nodes = all.get(s.tail) ?? [];
      const toks = nodes.flatMap((n) => tokens(n, sf, []));
      return { sym: { ...s, hash: digest(toks) }, tokens: toks };
    });
}

const cache = new Map<string, { textHash: string; syms: CodeSymbol[] }>(); // parsed files, keyed by repo-relative path + content

/** Repo-relative, forward-slash form of a user-given path. */
export function relPath(root: string, p: string): string {
  let r = isAbsolute(p) ? relative(root, p) : p;
  r = r.split(sep).join('/').replace(/\\/g, '/');
  while (r.startsWith('./')) r = r.slice(2);
  return r;
}

export function symbolsInFile(root: string, rel: string): CodeSymbol[] {
  const path = relPath(root, rel);
  const abs = join(root, path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (!st.isFile()) return [];
  const text = readFileSync(abs, 'utf8');
  const textHash = createHash('sha1').update(text).digest('hex');
  const key = `${abs}\0${path}`;
  const hit = cache.get(key);
  if (hit && hit.textHash === textHash) return hit.syms;
  const syms = symbolsOfText(path, text);
  if (cache.size > 2000) cache.clear();
  cache.set(key, { textHash, syms });
  return syms;
}

/** Split 'path#Tail' at the first '#' (tails may contain '#' for private methods). */
export function splitTarget(root: string, target: string): { path: string; tail: string } | undefined {
  const i = target.indexOf('#');
  if (i <= 0 || i === target.length - 1) return undefined;
  return { path: relPath(root, target.slice(0, i)), tail: target.slice(i + 1) };
}

export function findSymbol(root: string, target: string): CodeSymbol | undefined {
  const t = splitTarget(root, target);
  return t ? symbolsInFile(root, t.path).find((s) => s.tail === t.tail) : undefined;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/** Every .ts/.tsx (not .d.ts) under root, repo-relative, sorted; skips dot-dirs, node_modules and build output. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
      const rel = dir ? `${dir}/${n}` : n;
      let st;
      try {
        st = statSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(n) && !n.endsWith('.d.ts')) out.push(rel);
    }
  };
  walk('');
  return out;
}
