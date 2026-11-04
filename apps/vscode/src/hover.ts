// T15: hover + gutter mark on the lines a working-tree change touched. No vscode import, so it is unit-testable.
// Data: `mole check --worktree --json` (T12 past fixes per hunk + T14 questions) and your T11 notes on the touched symbols.
import type { CheckResult, Hunk, PastFix } from '@mole/history';
import type { Question } from '@mole/questions';

/** What `mole check --worktree --json` prints: T12's CheckResult + T14's questions. */
export type CheckJson = Omit<CheckResult, 'ms'> & { ms?: number; questions: Question[] };

/** A T11 note (from `mole memory --json`) placed on the current file: startLine/endLine are 1-based, inclusive. */
export interface HoverNote {
  file: string;
  symbol: string;
  path: string;
  status: string;
  changed?: boolean;
  text: string;
  startLine: number;
  endLine?: number;
}

/** A T39 agent-session intent (`mole agent-intent file#Symbol --json`) placed on the current file: what an
 * external agent-session tool (Entire, git-ai, Agent Trace) recorded, re-checked like a note. */
export interface HoverAgentIntent {
  file: string;
  tail: string;
  startLine: number;
  endLine: number;
  source: string; // 'entire' | 'git-ai' | 'agent-trace'
  sessionId: string;
  status: string; // 'fresh' | 'stale'
  model?: string;
  prompt?: string;
}

/** A hunk's NEW-side lines (1-based, inclusive) that get a gutter mark and a hover. */
export interface TouchedRange {
  file: string;
  startLine: number;
  endLine: number;
  hunk: Hunk;
}

/** The only commands a Mole hover may link to (MarkdownString.isTrusted.enabledCommands). */
export const HOVER_COMMANDS = ['mole.showCommit', 'mole.openAt'] as const;

/** New-side lines of a hunk; a pure deletion (newLines 0, newStart = the line before the gap) marks the lines on both sides. */
function newSide(h: Hunk): [number, number] {
  if (h.newLines > 0) return [h.newStart, h.newStart + h.newLines - 1];
  const a = Math.max(1, h.newStart);
  return [a, h.newStart + 1];
}

/** Base-side lines of a hunk (an insertion has none: use the line it follows). */
function oldSide(h: Hunk): [number, number] {
  return h.oldLines > 0 ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.oldStart, h.oldStart];
}

const overlaps = (a: [number, number], b: [number, number]): boolean => a[0] <= b[1] && b[0] <= a[1];

function notesOn(notes: HoverNote[], file: string, range: [number, number]): HoverNote[] {
  return notes.filter((n) => n.path === file && overlaps([n.startLine, n.endLine ?? n.startLine], range));
}

function agentIntentsOn(intents: HoverAgentIntent[], file: string, range: [number, number]): HoverAgentIntent[] {
  return intents.filter((a) => a.file === file && overlaps([a.startLine, a.endLine], range));
}

/** The change's questions that are about this hunk: they cite one of its past fixes, one of its notes, or its base lines. */
function questionsOn(check: CheckJson, h: Hunk, notes: HoverNote[]): Question[] {
  const shas = new Set(h.pastFixes.map((f) => f.sha));
  const noteFiles = new Set(notes.map((n) => n.file));
  const old = oldSide(h);
  return (check.questions ?? []).filter(
    (q) =>
      (q.cites.sha !== undefined && shas.has(q.cites.sha)) ||
      (q.cites.note !== undefined && [...noteFiles].some((f) => f === q.cites.note || f.endsWith(`/${q.cites.note}`) || (q.cites.note ?? '').endsWith(f))) ||
      (q.source.file === h.file && q.source.line >= old[0] && q.source.line <= old[1]),
  );
}

/** Hunks of `file` with something to say (a past fix, a question or one of your notes), as gutter ranges. */
export function touchedRanges(check: CheckJson | undefined, notes: HoverNote[], file: string): TouchedRange[] {
  if (!check) return [];
  const out: TouchedRange[] = [];
  for (const h of check.hunks) {
    if (h.file !== file) continue;
    const [startLine, endLine] = newSide(h);
    const ns = notesOn(notes, file, [startLine, endLine]);
    if (h.pastFixes.length === 0 && ns.length === 0 && questionsOn(check, h, ns).length === 0) continue;
    out.push({ file, startLine, endLine, hunk: h });
  }
  return out;
}

/**
 * Markdown text from commits, comments and notes: no links, no HTML, no emphasis can come from it. Brackets become
 * entities (a link needs a literal `](`), so parentheses can stay readable: "idle shutdown (T9)".
 */
export function md(s: string): string {
  return s
    .replace(/[\\`*_{}#+!|~]/g, (c) => `\\${c}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\r?\n/g, ' ');
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `command:` URI for a trusted Mole command; parentheses are encoded so a path cannot end the markdown link. */
export function commandUri(cmd: (typeof HOVER_COMMANDS)[number], args: unknown[]): string {
  return `command:${cmd}?${encodeURIComponent(JSON.stringify(args)).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** The fix's own words first: a comment it wrote near these lines, else any comment/note/task source, else its subject. */
function why(f: PastFix, file: string): string {
  const src = f.reasonSources ?? [];
  const pick = src.find((s) => s.kind === 'comment' && s.path === file) ?? src.find((s) => s.kind === 'comment') ?? src.find((s) => s.kind === 'note') ?? src.find((s) => s.kind === 'task');
  return pick?.text ?? f.reason ?? f.subject;
}

function fixBlock(f: PastFix, file: string): string {
  const lines: string[] = [];
  lines.push(`**past fix** [${md(f.shortSha)}](${commandUri('mole.showCommit', [f.sha])}) ${md(clip(f.subject, 140))}`);
  lines.push(`- why: ${md(clip(why(f, file), 220))}`);
  for (const t of (f.tests ?? []).slice(0, 2)) {
    const names = t.names ?? [];
    lines.push(`- test: ${md(t.file)}${names.length ? ` » ${md(clip(names[0] as string, 120))}${names.length > 1 ? ` (+${names.length - 1})` : ''}` : ''}`);
  }
  if ((f.tests ?? []).length === 0) lines.push('- test: none found');
  lines.push(`- source: [${md(`${f.source.file}:${f.source.line}`)} @ ${md(f.shortSha)}](${commandUri('mole.openAt', [f.source.file, f.source.line, f.source.sha])})`);
  return lines.join('\n');
}

function noteBlock(n: HoverNote): string {
  const stale = n.status === 'stale' || n.status === 'orphaned' || (n.status === 'moved' && n.changed === true);
  const tail = n.symbol.includes('#') ? n.symbol.slice(n.symbol.indexOf('#') + 1) : n.symbol;
  return `- ${stale ? `⚠ **${md(n.status === 'moved' ? 'moved, body changed' : n.status)}**` : md(n.status)} · ${md(tail)}: ${md(clip(n.text.split('\n')[0] ?? '', 200))}`;
}

function agentIntentBlock(a: HoverAgentIntent): string {
  const stale = a.status === 'stale';
  const who = [a.model, a.prompt ? `"${clip(a.prompt, 80)}"` : undefined].filter(Boolean).join(' · ');
  return `- ${stale ? '⚠ **stale**' : 'fresh'} · ${md(a.source)} session ${md(a.sessionId)}${who ? `: ${md(who)}` : ''}`;
}

/** Hover markdown for `file:line` (1-based), or undefined when no marked hunk covers the line. */
export function buildHover(check: CheckJson | undefined, notes: HoverNote[], file: string, line: number, agentIntents: HoverAgentIntent[] = []): string | undefined {
  const hits = touchedRanges(check, notes, file).filter((r) => r.startLine <= line && line <= r.endLine);
  if (!check || hits.length === 0) return undefined;
  const parts: string[] = ['**Mole** · this change edits lines with history'];
  const seenSha = new Set<string>();
  const qs: Question[] = [];
  const ns: HoverNote[] = [];
  const ai: HoverAgentIntent[] = [];
  for (const r of hits) {
    for (const f of r.hunk.pastFixes) {
      if (seenSha.has(f.sha)) continue;
      seenSha.add(f.sha);
      parts.push(fixBlock(f, file));
    }
    const hn = notesOn(notes, file, [r.startLine, r.endLine]);
    for (const n of hn) if (!ns.includes(n)) ns.push(n);
    for (const q of questionsOn(check, r.hunk, hn)) if (!qs.includes(q)) qs.push(q);
    for (const a of agentIntentsOn(agentIntents, file, [r.startLine, r.endLine])) if (!ai.includes(a)) ai.push(a);
  }
  if (qs.length) parts.push(['**questions**', ...qs.slice(0, 3).map((q, i) => `${i + 1}. ${md(clip(q.text, 400))}`)].join('\n'));
  if (ns.length) parts.push(['**your notes**', ...ns.map(noteBlock)].join('\n'));
  if (ai.length) parts.push(['**agent intent** (Entire / git-ai / Agent Trace, T39)', ...ai.map(agentIntentBlock)].join('\n'));
  return parts.join('\n\n');
}

export interface TouchedDeps {
  /** is the repo's Mole daemon answering? (ping on its socket) */
  daemonUp(): Promise<boolean>;
  check(): Promise<CheckJson>;
  notes(file: string): Promise<HoverNote[]>;
  agentIntent?(file: string): Promise<HoverAgentIntent[]>; // T39, optional: absent sources mean no block, never an error
  log?(m: string): void;
}

/**
 * Cache of the working-tree check. Everything is empty while the daemon is down (done-when 6): the hover asks the daemon
 * first and answers nothing when it is not running, and a refresh with the daemon down clears the marks. Never throws.
 */
export class Touched {
  private check?: CheckJson;
  private notes = new Map<string, HoverNote[]>();
  private agentIntents = new Map<string, HoverAgentIntent[]>();

  constructor(private readonly deps: TouchedDeps) {}

  private async up(): Promise<boolean> {
    try {
      return await this.deps.daemonUp();
    } catch {
      return false;
    }
  }

  /** Reload the check (and the notes + agent intent of the files it touches). Returns whether data is loaded. */
  async refresh(): Promise<boolean> {
    if (!(await this.up())) {
      this.clear();
      return false;
    }
    try {
      const check = await this.deps.check();
      const notes = new Map<string, HoverNote[]>();
      const agentIntents = new Map<string, HoverAgentIntent[]>();
      for (const file of new Set(check.hunks.map((h) => h.file))) {
        try {
          notes.set(file, await this.deps.notes(file));
        } catch (e) {
          this.deps.log?.(`notes for ${file}: ${(e as Error).message}`);
        }
        if (this.deps.agentIntent) {
          try {
            agentIntents.set(file, await this.deps.agentIntent(file));
          } catch (e) {
            this.deps.log?.(`agent intent for ${file}: ${(e as Error).message}`);
          }
        }
      }
      this.check = check;
      this.notes = notes;
      this.agentIntents = agentIntents;
      return true;
    } catch (e) {
      this.deps.log?.(`mole check failed: ${(e as Error).message}`);
      this.clear();
      return false;
    }
  }

  clear(): void {
    this.check = undefined;
    this.notes = new Map();
    this.agentIntents = new Map();
  }

  /** Files the loaded check touches. */
  files(): string[] {
    return [...new Set((this.check?.hunks ?? []).map((h) => h.file))];
  }

  ranges(file: string): TouchedRange[] {
    return touchedRanges(this.check, this.notes.get(file) ?? [], file);
  }

  async hover(file: string, line: number): Promise<string | undefined> {
    if (!(await this.up())) return undefined;
    try {
      return buildHover(this.check, this.notes.get(file) ?? [], file, line, this.agentIntents.get(file) ?? []);
    } catch (e) {
      this.deps.log?.(`hover: ${(e as Error).message}`);
      return undefined;
    }
  }
}
