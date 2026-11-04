// Unified-diff parsing into change blocks: one block per run of -/+ lines (what `git diff -U0` calls a hunk),
// whatever context the input diff carries. Works on `git diff -U0` output and on diff files with context.

export interface Line {
  line: number;
  text: string;
}

export interface Block {
  /** git convention: when oldLines is 0, oldStart is the line before the insertion (same for new) */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** the hunk header's function context (text after the second @@) */
  context: string;
  removed: Line[];
  added: Line[];
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  blocks: Block[];
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function headerPath(rest: string): string | null {
  const p = unquote(rest.replace(/\t.*$/, '').trim());
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let oldLn = 0;
  let newLn = 0;
  let oldRem = 0;
  let newRem = 0;
  let ctx = '';
  let open: { removed: Line[]; added: Line[]; oldAt: number; newAt: number } | undefined;

  const flush = () => {
    if (!open || !cur) return (open = undefined);
    const { removed, added, oldAt, newAt } = open;
    cur.blocks.push({
      oldStart: removed.length ? oldAt : oldAt - 1,
      oldLines: removed.length,
      newStart: added.length ? newAt : newAt - 1,
      newLines: added.length,
      context: ctx,
      removed,
      added,
    });
    open = undefined;
  };
  const inHunk = () => oldRem > 0 || newRem > 0;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (inHunk()) {
      const c = line[0];
      if (c === ' ' || line === '') {
        flush();
        oldLn++;
        newLn++;
        oldRem--;
        newRem--;
        continue;
      }
      if (c === '-' || c === '+') {
        open ??= { removed: [], added: [], oldAt: oldLn, newAt: newLn };
        if (c === '-') {
          open.removed.push({ line: oldLn++, text: line.slice(1) });
          oldRem--;
        } else {
          open.added.push({ line: newLn++, text: line.slice(1) });
          newRem--;
        }
        continue;
      }
      if (c === '\\') continue;
      // anything else ends the hunk early (truncated input)
      oldRem = newRem = 0;
    }
    if (line.startsWith('\\')) continue;
    flush();
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      cur = { oldPath: m ? m[1]! : null, newPath: m ? m[2]! : null, blocks: [] };
      files.push(cur);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!cur || cur.blocks.length > 0) {
        cur = { oldPath: null, newPath: null, blocks: [] };
        files.push(cur);
      }
      cur.oldPath = headerPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ') && cur) {
      cur.newPath = headerPath(line.slice(4));
      continue;
    }
    if (line.startsWith('new file mode') && cur) {
      cur.oldPath = null;
      continue;
    }
    if (line.startsWith('deleted file mode') && cur) {
      cur.newPath = null;
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h && cur) {
      const a = Number(h[1]);
      const b = h[2] === undefined ? 1 : Number(h[2]);
      const c = Number(h[3]);
      const d = h[4] === undefined ? 1 : Number(h[4]);
      oldLn = b === 0 ? a + 1 : a;
      newLn = d === 0 ? c + 1 : c;
      oldRem = b;
      newRem = d;
      ctx = h[5] ?? '';
    }
  }
  flush();
  return files;
}
