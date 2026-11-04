// T19: re-anchor a symbol whose name/path disappeared (rename, rename + move) by its normalized body, with call-graph and
// sibling neighbors as tie-break evidence. Pure over two source trees: the tree the anchor was written against (a git
// revision) and the tree now (the working directory, or an extracted commit in the M9 bench).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeSymbol } from './index.js';
import { declsOfText, sourceFiles, type SymbolDecl } from './symbols.js';

/** Thresholds, fixed in bench/m9-key.json before this code was written (the bench fails if they drift). */
export const REANCHOR = { renamedChangedMin: 0.55, tieEpsilon: 0.01, minTokens: 16 } as const;

/** A read-only view of a source tree: a directory (working tree) or a git revision. */
export interface SourceTree {
  label: string;
  files(): string[]; // repo-relative .ts/.tsx paths (no .d.ts)
  read(path: string): string | undefined;
  /** Files whose text contains `word` as a whole identifier (optional fast path; else every file is scanned). */
  grep?(word: string): string[];
}

/** What a note / seen event was anchored to. hash = normalized-body hash at anchoring time (optional). */
export interface Anchor {
  path: string;
  tail: string;
  kind: string;
  hash?: string;
}

export interface Reanchor {
  outcome: 'renamed' | 'renamed+changed' | 'ambiguous' | 'none';
  to?: CodeSymbol; // renamed / renamed+changed
  from?: CodeSymbol; // the anchored symbol as found in the old tree
  similarity?: number; // 0..1, 1 = identical normalized tokens
  candidates?: CodeSymbol[]; // ambiguous: every tied candidate
  reason?: string;
}

const isSource = (p: string) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts');
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage)\/|(^|\/)\./;

export function dirTree(root: string): SourceTree {
  let files: string[] | undefined;
  return {
    label: root,
    files: () => (files ??= sourceFiles(root)),
    read(path) {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export function gitTree(root: string, rev: string): SourceTree {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
  };
  let files: string[] | undefined;
  const texts = new Map<string, string | undefined>();
  return {
    label: `${root}@${rev}`,
    files: () => (files ??= (run(['ls-tree', '-r', '--name-only', rev]) ?? '').split('\n').filter((f) => isSource(f) && !SKIP.test(f))),
    read(path) {
      if (!texts.has(path)) texts.set(path, run(['show', `${rev}:${path}`]));
      return texts.get(path);
    },
    grep(word) {
      // exit 1 = no match; -w treats '$' as a non-word char, so callers re-check matches with identRe
      const out = run(['grep', '-l', '-F', '-w', '-e', word, rev, '--', '*.ts', '*.tsx']) ?? '';
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(rev.length + 1))
        .filter((f) => isSource(f) && !SKIP.test(f));
    },
  };
}

// parsed declarations, keyed by path + content (trees share most files, e.g. consecutive commits in the bench)
const declCache = new Map<string, SymbolDecl[]>();
function decls(path: string, text: string): SymbolDecl[] {
  const k = `${path}\0${createHash('sha1').update(text).digest('hex')}`;
  let d = declCache.get(k);
  if (!d) {
    d = declsOfText(path, text);
    if (declCache.size > 20000) declCache.clear();
    declCache.set(k, d);
  }
  return d;
}
const declsIn = (tree: SourceTree, path: string): SymbolDecl[] | undefined => {
  const t = tree.read(path);
  return t === undefined ? undefined : decls(path, t);
};

const lastSeg = (tail: string) => tail.slice(tail.lastIndexOf('.') + 1);
const container = (s: CodeSymbol) => (s.kind === 'method' && s.tail.includes('.') ? s.tail.slice(0, s.tail.indexOf('.')) : undefined);

/** Tokens with the symbol's own name -> $SELF and (methods) its class name -> $CLS, so self-references follow a rename. */
function normalized(d: SymbolDecl): string[] {
  const self = lastSeg(d.sym.tail);
  const cls = container(d.sym);
  return d.tokens.map((t) => (t === self ? '$SELF' : t === cls ? '$CLS' : t));
}

function bigrams(toks: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < toks.length; i++) {
    const k = `${toks[i]}\u0001${toks[i + 1]}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}
/** Dice coefficient over token-bigram multisets (key: thresholds.similarity). */
function dice(a: Map<string, number>, na: number, b: Map<string, number>, nb: number): number {
  if (na + nb === 0) return 1;
  let common = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, c] of small) common += Math.min(c, big.get(k) ?? 0);
  return (2 * common) / (na + nb);
}
const sameSeq = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

const identRe = (word: string) => new RegExp(`(?<![\\w$])${word.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');

interface Cand {
  d: SymbolDecl;
  toks: string[];
  exact: boolean;
  s: number;
  evidence?: number;
}

/**
 * Where did the anchored symbol go? 'renamed' = one new-named symbol of the same kind whose normalized tokens equal the old
 * ones; 'renamed+changed' = best one-to-one candidate with similarity >= REANCHOR.renamedChangedMin; 'ambiguous' = two or
 * more equal best candidates even after neighbor tie-breaks (or the best candidate is claimed equally by another vanished
 * symbol): never guessed; 'none' = deleted.
 */
export function reanchor(anchor: Anchor, oldTree: SourceTree, newTree: SourceTree): Reanchor {
  const oldDecl = declsIn(oldTree, anchor.path)?.find((d) => d.sym.tail === anchor.tail);
  if (!oldDecl) return { outcome: 'none', reason: `${anchor.path}#${anchor.tail} not found in ${oldTree.label}` };
  const kind = oldDecl.sym.kind;
  const A = normalized(oldDecl);
  const AB = bigrams(A);
  const T = REANCHOR.renamedChangedMin;
  const tiny = A.length < REANCHOR.minTokens;

  // every same-kind symbol of the new tree whose name is new in its file (a symbol that already existed is not a rename target)
  const oldTailsCache = new Map<string, Set<string> | undefined>();
  const oldTails = (path: string) => {
    if (!oldTailsCache.has(path)) oldTailsCache.set(path, declsIn(oldTree, path) && new Set(declsIn(oldTree, path)!.map((d) => d.sym.tail)));
    return oldTailsCache.get(path);
  };
  const isNew = (s: CodeSymbol) => !oldTails(s.path)?.has(s.tail);
  const newAll: SymbolDecl[] = [];
  for (const f of newTree.files()) newAll.push(...(declsIn(newTree, f) ?? []));
  const newTails = new Set(newAll.map((d) => `${d.sym.path}#${d.sym.tail}`));
  const newTailNames = new Set(newAll.map((d) => d.sym.tail));
  if (newTails.has(`${anchor.path}#${anchor.tail}`)) return { outcome: 'none', from: oldDecl.sym, reason: 'the symbol still exists' };

  const scoreAgainst = (toks: string[], bg: Map<string, number>, d: SymbolDecl): Cand | undefined => {
    const n = d.tokens.length;
    // even a perfect overlap could not reach the threshold (and different lengths can't be an exact match)
    if (toks.length !== n && (2 * Math.min(toks.length, n)) / (toks.length + n) < T) return undefined;
    const b = normalized(d);
    const exact = sameSeq(toks, b);
    const s = exact ? 1 : dice(bg, Math.max(0, toks.length - 1), bigrams(b), Math.max(0, b.length - 1));
    return { d, toks: b, exact, s };
  };

  let pool: Cand[] = [];
  for (const d of newAll) {
    if (d.sym.kind !== kind) continue;
    const c = scoreAgainst(A, AB, d);
    if (!c || !(c.exact || c.s >= T) || !isNew(d.sym)) continue;
    pool.push(c);
  }
  if (tiny) pool = pool.filter((c) => c.exact && callerFollow(anchor, oldDecl, c.d, oldTree, newTree, newAll) > 0);
  if (pool.length === 0) return { outcome: 'none', from: oldDecl.sym, reason: 'no candidate above the similarity threshold' };

  // vanished old symbols that could compete for the same new symbol (one-to-one): same kind, in the old versions of the
  // anchor's file and of the candidate's file, whose name is gone from the new tree
  const vanishedNear = (path: string): SymbolDecl[] =>
    (declsIn(oldTree, path) ?? []).filter((v) => v.sym.kind === kind && v.sym.tail !== anchor.tail && !newTailNames.has(v.sym.tail));

  const eps = REANCHOR.tieEpsilon;
  for (;;) {
    if (pool.length === 0) return { outcome: 'none', from: oldDecl.sym, reason: 'every candidate belongs to another vanished symbol' };
    pool.sort((a, b) => Number(b.exact) - Number(a.exact) || b.s - a.s || a.d.sym.qualifiedName.localeCompare(b.d.sym.qualifiedName));
    const best0 = pool[0]!;
    let top = pool.filter((c) => c.exact === best0.exact && best0.s - c.s < eps);
    if (top.length > 1) {
      // tie-break: callers that now call the candidate (call-graph neighbors) + same file as before (sibling)
      for (const c of top) c.evidence = callerFollow(anchor, oldDecl, c.d, oldTree, newTree, newAll) + (c.d.sym.path === anchor.path ? 1 : 0);
      const most = Math.max(...top.map((c) => c.evidence!));
      top = top.filter((c) => c.evidence === most);
      if (top.length > 1) return { outcome: 'ambiguous', from: oldDecl.sym, similarity: best0.s, candidates: top.map((c) => c.d.sym), reason: 'equal candidates' };
    }
    const best = top[0]!;
    // contested: another vanished symbol matches this candidate better (it is that one's rename) or just as well (merge)
    const seen = new Set<string>();
    let verdict: 'mine' | 'theirs' | 'tie' = 'mine';
    let rival: CodeSymbol | undefined;
    for (const v of [...vanishedNear(anchor.path), ...(best.d.sym.path === anchor.path ? [] : vanishedNear(best.d.sym.path))]) {
      if (seen.has(v.sym.qualifiedName)) continue;
      seen.add(v.sym.qualifiedName);
      const vt = normalized(v);
      const exact = sameSeq(vt, best.toks);
      const s = exact ? 1 : dice(bigrams(vt), Math.max(0, vt.length - 1), bigrams(best.toks), Math.max(0, best.toks.length - 1));
      if ((exact && !best.exact) || s - best.s >= eps) {
        verdict = 'theirs';
        rival = v.sym;
        break;
      }
      if (exact === best.exact && Math.abs(s - best.s) < eps) {
        verdict = 'tie';
        rival = v.sym;
      }
    }
    if (verdict === 'theirs') {
      pool = pool.filter((c) => c !== best);
      continue;
    }
    if (verdict === 'tie')
      return { outcome: 'ambiguous', from: oldDecl.sym, similarity: best.s, candidates: [best.d.sym], reason: `${rival!.qualifiedName} matches ${best.d.sym.qualifiedName} equally` };
    return { outcome: best.exact ? 'renamed' : 'renamed+changed', to: best.d.sym, from: oldDecl.sym, similarity: best.s };
  }
}

/** Callers of the old symbol (in the old tree) that still exist and now reference the candidate's name. */
function callerFollow(anchor: Anchor, oldDecl: SymbolDecl, cand: SymbolDecl, oldTree: SourceTree, newTree: SourceTree, newAll: SymbolDecl[]): number {
  const oldName = lastSeg(anchor.tail);
  const newName = lastSeg(cand.sym.tail);
  const re = identRe(oldName);
  const files = oldTree.grep ? oldTree.grep(oldName) : oldTree.files().filter((f) => identRe(oldName).test(oldTree.read(f) ?? ''));
  const callers = new Set<string>();
  for (const f of files) {
    const text = oldTree.read(f);
    if (text === undefined) continue;
    const ds = decls(f, text);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    for (const m of text.matchAll(re)) {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= m.index) lo = mid;
        else hi = mid - 1;
      }
      const line = lo + 1;
      const enclosing = ds
        .filter((d) => d.sym.startLine <= line && line <= d.sym.endLine && d.sym.kind !== 'class')
        .sort((a, b) => a.sym.endLine - a.sym.startLine - (b.sym.endLine - b.sym.startLine))[0];
      if (!enclosing || enclosing.sym.qualifiedName === oldDecl.sym.qualifiedName) continue;
      callers.add(enclosing.sym.qualifiedName);
    }
  }
  let follow = 0;
  for (const q of callers) {
    const d = newAll.find((x) => x.sym.qualifiedName === q);
    if (d && d.tokens.includes(newName)) follow++;
  }
  return follow;
}
