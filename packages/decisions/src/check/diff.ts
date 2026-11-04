// `git diff -M -U0` between the merge base and the PR head, parsed into files with old/new line ranges. Renames are kept
// as one entry (oldPath -> newPath) so an anchor on the old path can be reported as unanchored instead of re-attached.
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** text of the removed (old side) and added (new side) lines, without the -/+ marker */
  del: string[];
  add: string[];
  /** git's enclosing-block context from the @@ header (funcname), '' when none */
  context: string;
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R';
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
}

const unquote = (s: string): string => {
  if (!s.startsWith('"')) return s;
  try {
    return JSON.parse(s) as string;
  } catch {
    return s.slice(1, -1);
  }
};
const side = (s: string, prefix: 'a/' | 'b/'): string | null => {
  const p = unquote(s.trim());
  if (p === '/dev/null') return null;
  return p.startsWith(prefix) ? p.slice(2) : p;
};

export function parseGitDiff(text: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  let hunk: Hunk | null = null;
  for (const line of text.split('\n')) {
    if (hunk && cur && !line.startsWith('diff --git ') && !line.startsWith('@@')) {
      if (line.startsWith('-')) {
        hunk.del.push(line.slice(1));
        continue;
      }
      if (line.startsWith('+')) {
        hunk.add.push(line.slice(1));
        continue;
      }
      if (line.startsWith('\\')) continue; // \ No newline at end of file
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git ("?a\/.*?"?) ("?b\/.*"?)$/.exec(line);
      hunk = null;
      cur = { status: 'M', oldPath: m ? side(m[1]!, 'a/') : null, newPath: m ? side(m[2]!, 'b/') : null, hunks: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) {
      cur.status = 'R';
      cur.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      cur.status = 'R';
      cur.newPath = unquote(line.slice('rename to '.length));
    } else if (line.startsWith('--- ')) {
      if (cur.status !== 'R') cur.oldPath = side(line.slice(4), 'a/');
    } else if (line.startsWith('+++ ')) {
      if (cur.status !== 'R') cur.newPath = side(line.slice(4), 'b/');
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      hunk = m ? { oldStart: +m[1]!, oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3]!, newLines: m[4] === undefined ? 1 : +m[4], del: [], add: [], context: (m[5] ?? '').trim() } : null;
      if (hunk) cur.hunks.push(hunk);
    }
  }
  for (const f of out) {
    if (f.status === 'A') f.oldPath = null;
    if (f.status === 'D') f.newPath = null;
  }
  return out;
}
