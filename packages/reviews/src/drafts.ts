// T40 capture: resolve a flagged note's candidates against real code (D38: a draft never invents an anchor --
// it either finds a real symbol/file or stays unanchored). Reuses @mole/memory's own symbol extraction and
// file listing (T11/T19's anchor format), the same way packages/decisions/src/check/pr-check.ts resolves
// symbol anchors, instead of re-parsing TypeScript itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles, symbolsOfText } from '@mole/memory';
import { candidatesOf, flaggedLinesOf } from './notes.js';
import type { DraftDecision } from './types.js';

/** path-like candidate (contains a slash or a known source extension) */
const looksLikePath = (c: string) => /\.(ts|tsx|js|jsx)$/.test(c) || c.includes('/');

class RepoSymbolIndex {
  private byName = new Map<string, string[]>(); // symbol tail -> files it's declared in
  private files: Set<string>;
  constructor(private root: string) {
    this.files = new Set(sourceFiles(root));
    for (const f of this.files) {
      let text: string;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        continue;
      }
      for (const s of symbolsOfText(f, text)) {
        const arr = this.byName.get(s.tail) ?? [];
        arr.push(f);
        this.byName.set(s.tail, arr);
      }
    }
  }
  /** files declaring this exact symbol tail (e.g. "prCheck" or "Widget.render") */
  filesOf(tail: string): string[] {
    return this.byName.get(tail) ?? [];
  }
  hasFile(path: string): boolean {
    return this.files.has(path);
  }
}

const indexCache = new Map<string, RepoSymbolIndex>();
function indexFor(root: string): RepoSymbolIndex {
  let idx = indexCache.get(root);
  if (!idx) {
    idx = new RepoSymbolIndex(root);
    indexCache.set(root, idx);
  }
  return idx;
}

/** Resolve one candidate string to a 'path' or 'path#tail' anchor, or null if it cannot be resolved to exactly
 *  one real place in the repo (ambiguous or unknown candidates are left unanchored, never guessed -- D38). */
function resolveCandidate(idx: RepoSymbolIndex, candidate: string): string | null {
  if (looksLikePath(candidate)) {
    const p = candidate.replace(/^\.\//, '');
    return idx.hasFile(p) ? p : null;
  }
  const files = idx.filesOf(candidate);
  return files.length === 1 ? `${files[0]}#${candidate}` : null;
}

/** D38: a person's sparse notes expand only around what they flagged, into decision drafts pinned to real
 *  functions/files. Unflagged lines never produce a draft, and a flagged line with no resolvable code
 *  reference stays unanchored rather than guessing. */
export function draftsFromNotes(root: string, noteText: string): DraftDecision[] {
  const idx = indexFor(root);
  const flagged = flaggedLinesOf(noteText);
  return flagged.map((f): DraftDecision => {
    const candidates = candidatesOf(f.text);
    let anchor: string | null = null;
    for (const c of candidates) {
      const r = resolveCandidate(idx, c);
      if (r) {
        anchor = r;
        break;
      }
    }
    return { line: f.line, flagged: true, title: f.text, anchor, candidates };
  });
}
