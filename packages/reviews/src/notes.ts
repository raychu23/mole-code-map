// T40 capture: parse sparse human notes. Only a line starting with DECIDED:/AGREED:/DECISION: (after a leading
// markdown bullet marker) is a flagged decision; everything else is read context, never a draft (Granola model).
const FLAG_RE = /^\s*[-*]\s*(DECIDED|AGREED|DECISION)\s*:\s*(.+)$/i;

export interface FlaggedLine {
  line: number; // 1-based
  text: string; // the decision text, marker stripped
}

export function flaggedLinesOf(noteText: string): FlaggedLine[] {
  const out: FlaggedLine[] = [];
  const lines = noteText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = FLAG_RE.exec(lines[i]!);
    if (m) out.push({ line: i + 1, text: m[2]!.trim() });
  }
  return out;
}

/** Candidate code references inside a flagged line's text: backtick-wrapped identifiers/paths, the only
 *  notation these fixtures (and real review notes referencing code) use -- a free-text word is never a
 *  candidate, so prose like "we should be more careful" never accidentally resolves to a symbol. */
export function candidatesOf(text: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let c = m[1]!.trim();
    if (c.endsWith('()')) c = c.slice(0, -2);
    if (c) out.push(c);
  }
  return out;
}
