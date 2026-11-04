// T40: design review + meeting notes -> pinned decision drafts, a deterministic delta diagram over the file
// tree, and a Swimm-style drift policy (M34). See packages/reviews/bench/m34.ts for the benchmark that scores
// all three against the frozen keys, and (internal reference removed) start.md for the contract.
export { candidatesOf, flaggedLinesOf } from './notes.js';
export type { FlaggedLine } from './notes.js';
export { draftsFromNotes } from './drafts.js';
export { buildTreeGraph, renderSvg } from './diagram.js';
export type { Delta, DeltaColors, TreeGraph, TreeNode } from './diagram.js';
export { classifyDrift } from './drift.js';
export type { DriftResult, DriftStatus } from './drift.js';
export type { DraftDecision } from './types.js';

/** One short line per fixture note, meant for the T32 PR check and the VS Code panel: drafts awaiting a
 *  person's approval (Granola model, D38 -- this never applies them, only surfaces them). Reads
 *  `.mole/local/meetings/*.md` if present; returns [] when there is nothing to show (never throws on a
 *  missing/empty directory, matching the pr-check "silent when nothing governs" convention). */
export async function reviewDraftsSummary(root: string): Promise<string[]> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(root, '.mole', 'local', 'meetings');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const { draftsFromNotes } = await import('./drafts.js');
  const out: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const d of draftsFromNotes(root, text)) {
      out.push(`${f}:${d.line} ${d.title}${d.anchor ? ` -> ${d.anchor}` : ' (unanchored, needs a person to pin it)'}`);
    }
  }
  return out;
}
