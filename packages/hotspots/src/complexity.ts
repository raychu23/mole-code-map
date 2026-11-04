// Indentation-based ("whitespace") complexity (Tornhill, "Your Code as a Crime Scene" p.25;
// Hindle/Godfrey/Holt ICPC 2008): per non-blank line, logical-indent depth = how many
// `spacesPerIndent`-wide (or 1-tab-wide) steps its leading whitespace is; file complexity = sum of
// every line's depth. Deterministic, language-independent (no parser).
//
// review-1 MED 3: computeHotspots() no longer calls `indentComplexityFromText` via one `git show`
// per file -- it reads every blob in a single `git cat-file --batch` (index.ts) and calls the pure
// text function below in-process. `indentComplexity`/`indentComplexityDetail` (one `git show` per
// call) are kept as a small single-file convenience API for callers that just want one file's
// number (e.g. this package's own unit tests), not used in computeHotspots' hot path any more.
import { git } from '@mole/history/dist/src/git.js';

export interface IndentComplexity {
  file: string;
  total: number;
  lines: number;
  mean: number;
}

/** leading-whitespace width of one line, tabs counted as 1 logical indent each (Tornhill's
 * indent-complexity-proxy --tabs default), spaces counted in groups of `spacesPerIndent` */
function depthOf(line: string, spacesPerIndent: number): number {
  let spaces = 0;
  let depth = 0;
  for (const ch of line) {
    if (ch === '\t') {
      depth += 1;
      spaces = 0;
    } else if (ch === ' ') {
      spaces += 1;
      if (spaces === spacesPerIndent) {
        depth += 1;
        spaces = 0;
      }
    } else {
      break;
    }
  }
  return depth;
}

/** pure, in-process: sum of per-line logical-indent depth over non-blank lines of already-read text */
export function indentComplexityFromText(text: string, spacesPerIndent = 2): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    total += depthOf(line, spacesPerIndent);
  }
  return total;
}

export async function indentComplexity(root: string, file: string, spacesPerIndent = 2): Promise<number> {
  const text = await git(root, ['show', `HEAD:${file}`]);
  return indentComplexityFromText(text, spacesPerIndent);
}

export async function indentComplexityDetail(root: string, file: string, spacesPerIndent = 2): Promise<IndentComplexity> {
  const text = await git(root, ['show', `HEAD:${file}`]);
  let total = 0;
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    total += depthOf(line, spacesPerIndent);
    lines += 1;
  }
  return { file, total, lines, mean: lines ? total / lines : 0 };
}
