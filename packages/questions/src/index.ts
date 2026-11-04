// @mole/questions: L3 questions (T14). For a change, at most 3 questions aimed at your understanding, built from
// deterministic templates over facts other packages found: past fixes + guarding tests (@mole/history, T12),
// your notes (@mole/memory, T11) and, later, your seen history (T13, a typed hook only). A model may only reword
// a question's text behind a flag; it never decides which questions exist, their order or their sources.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check, parseDiff, type Block, type Change, type CheckOptions, type CheckResult, type FileDiff, type PastFix } from '@mole/history';
// @mole/memory loads the TypeScript compiler: imported only when there are notes to place (keeps `mole check` fast)

export type QuestionKind = 'past-fix' | 'note' | 'guard-test' | 'seen';

export interface Question {
  /** 1-based position after ranking (past fix > note > guard-test > seen; a guard-test edit always keeps a slot) */
  rank: number;
  kind: QuestionKind;
  text: string;
  /** the fact the question is about */
  cites: { sha?: string; note?: string; testFile?: string };
  /** clickable source: file:line (in commit `sha` when given, else at the base / the note file) */
  source: { file: string; line: number; sha?: string };
}

/** A note (T11) on a symbol the change edits. file is relative to the notes root ('.mole/notes/x.md'). */
export interface NoteFact {
  file: string;
  symbol: string;
  path: string;
  /** base-side line range of the symbol */
  startLine: number;
  endLine: number;
  /** fresh = the symbol's body at the base still has the note's hash */
  status: 'fresh' | 'stale';
  text: string;
  author: string;
  written: string;
  /** line of the note body in the note file */
  line: number;
}

/** A guarding test of a past fix that the change edits or deletes (read from the test diff). */
export interface GuardFact {
  testFile: string;
  /** describe/it titles the change edits or deletes that the fix named as its tests */
  names: string[];
  action: 'edits' | 'deletes';
  /** base-side first edited line */
  line: number;
  fix: { sha: string; shortSha: string; subject: string; date: string };
  /** blame = the fix last wrote the edited test lines; named = the fix added/edited (or sat in) a test with that title */
  via: 'blame' | 'named';
}

/** T13 hook (not built yet): something you looked at before, on a file/line this change touches. */
export interface SeenFact {
  file: string;
  line: number;
  when: string;
  what: string;
  sha?: string;
}

export interface QuestionsOptions extends CheckOptions {
  /** read .mole/notes from this directory instead of the repo root (e.g. for a read-only clone) */
  notesRoot?: string;
  /** T13 input (future): your seen history; ignored when absent */
  seen?: SeenFact[];
  /** reword the template text with a model; with no model configured this is a no-op plus a notice */
  reword?: boolean;
  /** the model hook used when reword is on; never consulted for which questions exist */
  model?: (text: string) => Promise<string>;
}

export interface QuestionsResult {
  questions: Question[];
  facts: CheckResult & { notes: NoteFact[]; guards: GuardFact[] };
  modelCalls: number;
  notices: string[];
}

export const MAX_QUESTIONS = 3;
export const NO_MODEL_NOTICE = 'reword: no model configured; questions are shown as written (deterministic templates)';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// same test-file and title patterns as @mole/history (T12), so "guarding test" means the same thing in both
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const TITLE = /\b(?:describe|it|test|suite|context)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)+?)\1/g;
/** an it()/test() call: the only block level a guard can be named at when the change edits inside it (review-1 P1-1) */
const IT_TITLE = /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)+?)\1/;
/** a snapshot is not a test you can name or that guards anything by itself (review-1 P2-1) */
const SNAPSHOT = /\.snap$|(^|\/)__snapshots__\//;
/** lines a fix wrote here can't "keep a fix working": docs, changelogs, lockfiles, snapshots (review-1 P2-4) */
const NON_CODE =
  /\.(md|mdx|markdown|txt|rst|adoc|lock|snap)$|(^|\/)(CHANGELOG|CHANGES|HISTORY|LICENSE|LICENCE|NOTICE|AUTHORS)[^/]*$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum)$/i;
const isTest = (f: string): boolean => TEST_FILE.test(f) && !SNAPSHOT.test(f);
/** at most this many fix commits per test file are read for their guarding-test names */
const MAX_FIXES_PER_TEST_FILE = 50;

function git(root: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      ['-C', root, '--no-optional-locks', '-c', 'core.quotePath=false', ...args],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => (err ? rej(new Error(`git ${args.slice(0, 2).join(' ')}: ${(stderr || err.message).trim().split('\n')[0]}`)) : res(stdout)),
    );
  });
}

/** clip to n chars on a word boundary (never mid-word), with an ellipsis when cut */
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n / 3 ? cut.slice(0, sp) : cut.slice(0, n - 1)).replace(/[\s,;:–—-]+$/, '')}…`;
};
const range = (start: number, n: number): string => (n <= 1 ? `${start}` : `${start}-${start + n - 1}`);
const titlesIn = (s: string): string[] => [...s.matchAll(TITLE)].map((m) => m[2]!);
const indentOf = (s: string): number => /^\s*/.exec(s)![0].replace(/\t/g, '  ').length;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** the change's diff text, the same way @mole/history resolved it */
async function changeDiff(root: string, r: CheckResult): Promise<string> {
  if (r.change.kind === 'sha') return git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', r.change.base, r.change.ref]);
  if (r.change.kind === 'diff') return readFileSync(r.change.ref, 'utf8');
  return git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']);
}

class BaseFiles {
  private cache = new Map<string, Promise<string[] | undefined>>();
  constructor(
    readonly root: string,
    readonly base: string,
  ) {}
  lines(path: string): Promise<string[] | undefined> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.base === EMPTY_TREE ? Promise.resolve(undefined) : git(this.root, ['show', `${this.base}:${path}`]).then((t) => t.split('\n'), () => undefined);
      this.cache.set(path, p);
    }
    return p;
  }
}

// ---------- notes (T11) ----------

async function noteFacts(notesRoot: string, files: FileDiff[], base: BaseFiles): Promise<Array<NoteFact & { order: number; hunk: { file: string; start: number; n: number } }>> {
  const dir = join(notesRoot, '.mole', 'notes');
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  if (!names.length || !files.some((f) => f.oldPath)) return [];
  const { parseNote, symbolsOfText } = await import('@mole/memory');
  const out: Array<NoteFact & { order: number; hunk: { file: string; start: number; n: number } }> = [];
  for (const n of names) {
    const file = `.mole/notes/${n}`;
    let content: string;
    try {
      content = readFileSync(join(dir, n), 'utf8');
    } catch {
      continue;
    }
    const { note } = parseNote(content, file);
    if (!note) continue; // invalid notes are `mole memory`'s business, not a question
    const fi = files.findIndex((f) => f.oldPath === note.path);
    if (fi < 0) continue;
    const lines = await base.lines(note.path);
    if (!lines) continue;
    const tail = note.symbol.slice(note.symbol.indexOf('#') + 1);
    const sym = symbolsOfText(note.path, lines.join('\n')).find((s) => s.tail === tail);
    if (!sym) continue; // moved / orphaned at the base: not asked (INFERENCE, see 2 insights.md)
    const f = files[fi]!;
    const bi = f.blocks.findIndex((b) =>
      b.oldLines > 0 ? b.oldStart <= sym.endLine && b.oldStart + b.oldLines - 1 >= sym.startLine : b.oldStart >= sym.startLine && b.oldStart < sym.endLine,
    );
    if (bi < 0) continue;
    const b = f.blocks[bi]!;
    const cl = content.split('\n');
    const close = cl.findIndex((l, i) => i > 0 && l.trim() === '---');
    let line = close + 2;
    while (line <= cl.length && !cl[line - 1]!.trim()) line++;
    out.push({
      file,
      symbol: note.symbol,
      path: note.path,
      startLine: sym.startLine,
      endLine: sym.endLine,
      status: sym.hash === note.hash ? 'fresh' : 'stale',
      text: note.text,
      author: note.author,
      written: note.written,
      line: Math.min(Math.max(line, 1), cl.length),
      order: fi * 100000 + bi,
      hunk: { file: f.newPath ?? f.oldPath ?? note.path, start: b.oldLines ? b.oldStart : b.newStart, n: b.oldLines || b.newLines },
    });
  }
  return out.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
}

// ---------- guarding tests (read from the test diff) ----------

interface FixNames {
  sha: string;
  subject: string;
  date: string;
  /** titles on lines the fix added (it wrote or edited that title line) */
  added: Set<string>;
  /** T12's names: added titles + the -U0 hunk-header context titles the fix "sat in" */
  names: Set<string>;
}

/** fix-rule commits that touched a test file before the base, each with the titles it added and T12's names */
async function fixesOfTestFile(root: string, base: string, file: string, rule: RegExp, shallow: boolean): Promise<FixNames[]> {
  const raw = await git(root, ['log', `-n${MAX_FIXES_PER_TEST_FILE * 4}`, '--format=%H%x1f%P%x1f%aI%x1f%s', base, '--', file]).catch(() => '');
  const fixes = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f') as [string, string, string, string])
    .filter(([, parents, , subject]) => rule.test(subject) && !(shallow && !parents.trim())) // shallow boundary "wrote" everything
    .slice(0, MAX_FIXES_PER_TEST_FILE);
  const out: FixNames[] = [];
  for (const [sha, parents, date, subject] of fixes) {
    const parent = parents.split(' ')[0] || EMPTY_TREE;
    const d = await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', parent, sha, '--', file]).catch(() => '');
    const added = new Set<string>();
    const names = new Set<string>();
    for (const f of parseDiff(d))
      for (const b of f.blocks) {
        for (const t of b.added.flatMap((a) => titlesIn(a.text))) added.add(t), names.add(t);
        for (const t of titlesIn(b.context)) names.add(t);
      }
    out.push({ sha, subject, date, added, names });
  }
  return out;
}

/** the innermost titled block (describe/it/...) enclosing base line `at` (by indentation, walking up) */
function innermostTitled(lines: string[], at: number): { title: string; it: boolean } | undefined {
  const start = lines[at - 1];
  let indent = start !== undefined && start.trim() ? indentOf(start) : Number.POSITIVE_INFINITY;
  for (let i = at - 2; i >= 0 && indent > 0; i--) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind >= indent) continue;
    const t = titlesIn(l);
    if (t.length) {
      const m = IT_TITLE.exec(l);
      return { title: m ? m[2]! : t[0]!, it: !!m };
    }
    indent = ind;
  }
  return undefined;
}

/** last base line of the block whose title is on base line `at` (its closing line at the same indent, if any) */
function blockEnd(lines: string[], at: number): number {
  const ind = indentOf(lines[at - 1] ?? '');
  for (let i = at; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() && indentOf(l) <= ind) return /^\s*[)}\]]/.test(l) ? i + 1 : i;
  }
  return lines.length;
}

/** titles of the innermost it/test blocks around the edited old lines, or on removed it/test title lines; never a
 *  describe the edit merely sits in (review-1 P1-1) */
function editedItTitles(lines: string[], b: Block): string[] {
  const out: string[] = [];
  for (const r of b.removed) {
    const m = IT_TITLE.exec(r.text);
    if (m) out.push(m[2]!);
    const e = innermostTitled(lines, r.line);
    if (e?.it) out.push(e.title);
  }
  return uniq(out);
}

/** titles of whole test blocks (title line through its end) the change deletes */
function deletedBlockTitles(lines: string[], b: Block): string[] {
  const gone = new Set(b.removed.map((r) => r.line));
  const out: string[] = [];
  for (const r of b.removed) {
    const t = titlesIn(r.text);
    if (!t.length) continue;
    const end = blockEnd(lines, r.line);
    let all = true;
    for (let i = r.line; i <= end && all; i++) if (lines[i - 1]?.trim() && !gone.has(i)) all = false;
    if (all) out.push(t[0]!);
  }
  return uniq(out);
}

async function guardFacts(root: string, r: CheckResult, files: FileDiff[], base: BaseFiles, rule: RegExp, shallow: boolean): Promise<GuardFact[]> {
  const out: GuardFact[] = [];
  for (const f of files) {
    const file = f.oldPath;
    if (!file || !isTest(file)) continue; // snapshots never guard (P2-1)
    const edits = f.blocks.filter((b) => b.oldLines > 0); // pure additions never edit a guarding test
    if (!edits.length) continue;
    const lines = (await base.lines(file)) ?? [];
    const deleted = !f.newPath;
    // (a) blame: a fix last wrote the edited test lines (T12 already found it on this hunk)
    const blamed = new Map<string, { fix: PastFix; n: number; line: number; names: string[] }>();
    for (const b of edits) {
      const h = r.hunks.find((x) => x.file === (f.newPath ?? f.oldPath) && x.oldStart === b.oldStart && x.oldLines === b.oldLines);
      for (const pf of h?.pastFixes ?? []) {
        // only fix-written lines inside a describe/it block count: an import or top-level helper the fix wrote is not
        // "a guarding test" (seen on excalidraw 4850bf3: blame guards on import lines)
        const inBlocks = pf.lines.map((l) => innermostTitled(lines, l)).filter((x): x is { title: string; it: boolean } => !!x);
        if (!inBlocks.length) continue;
        const e = blamed.get(pf.sha) ?? { fix: pf, n: 0, line: b.oldStart, names: [] };
        e.n += pf.lines.length;
        e.names.push(...deletedBlockTitles(lines, b), ...inBlocks.filter((x) => x.it).map((x) => x.title), ...editedItTitles(lines, b));
        blamed.set(pf.sha, e);
      }
    }
    const best = [...blamed.values()].sort((a, b) => b.n - a.n || b.fix.date.localeCompare(a.fix.date))[0];
    const action = (b: Block[]): 'edits' | 'deletes' => (deleted || b.every((x) => x.newLines === 0) ? 'deletes' : 'edits');
    if (best) {
      out.push({
        testFile: file,
        names: uniq(best.names),
        action: action(edits),
        line: best.line,
        fix: { sha: best.fix.sha, shortSha: best.fix.shortSha, subject: best.fix.subject, date: best.fix.date },
        via: 'blame',
      });
      continue;
    }
    // (b) named, two narrow forms only (review-1 P1-1):
    //   - the change edits/deletes old lines inside an it/test block whose title line the fix itself added;
    //   - the change deletes a whole test block (title line to its end) that T12 names as the fix's guarding test
    //     (T12's names include the fix's hunk-header context: the M4 key's G1/G2 cases rest on that, see insights).
    // A describe an edit merely sits in, or a hunk-header title, never makes an EDIT a guard edit.
    const fixes = await fixesOfTestFile(root, r.change.base, file, rule, shallow);
    if (!fixes.length) continue;
    let found: GuardFact | undefined;
    for (const b of edits) {
      const inIt = editedItTitles(lines, b);
      const whole = deletedBlockTitles(lines, b);
      for (const fx of fixes) {
        const names = uniq([...whole.filter((t) => fx.names.has(t)), ...inIt.filter((t) => fx.added.has(t))]);
        if (!names.length) continue;
        found = { testFile: file, names, action: action([b]), line: b.oldStart, fix: { sha: fx.sha, shortSha: fx.sha.slice(0, 7), subject: fx.subject, date: fx.date }, via: 'named' };
        break; // newest matching fix first (git log order)
      }
      if (found) break;
    }
    if (found) out.push(found);
  }
  return out;
}

// ---------- templates ----------

/** first sentence of the fix's commit body; a squash bullet list or a repeat of the subject is no reason (P2-2) */
function bodySentence(f: PastFix): string | undefined {
  if (!f.reason.startsWith(`${f.subject} — `)) return undefined;
  const body = f.reason.slice(f.subject.length + 3).split(' | ')[0]!.trim();
  if (!body || /^([*•+]|-(?!-)|\d+[.)])\s/.test(body)) return undefined;
  const first = (/^(.+?[.!?])(\s|$)/.exec(body)?.[1] ?? body).trim();
  if (first.length < 12 || first.toLowerCase() === f.subject.toLowerCase()) return undefined;
  return first;
}

/** the fix's reason: its body's first sentence; else a comment the fix added inside the blamed lines; else a task line */
function why(f: PastFix): string | undefined {
  const body = bodySentence(f);
  if (body) return body;
  const span = f.lines.length ? Math.max(...f.lines) - Math.min(...f.lines) : 0;
  const comment = f.reasonSources.find(
    (s) => s.kind === 'comment' && s.path === f.source.file && s.line !== undefined && s.line >= f.source.line - 3 && s.line <= f.source.line + span + 1,
  );
  // T12 keeps one line of a comment: mark it as cut when it stops mid-sentence
  if (comment) return /[.!?:)]$/.test(comment.text.trim()) ? comment.text : `${comment.text.trim()}…`;
  return f.reasonSources.find((s) => s.kind === 'task')?.text;
}

function pastFixText(f: PastFix, where: string, guard?: GuardFact): string {
  const w = why(f);
  const real = f.tests.filter((x) => !SNAPSHOT.test(x.file)); // a snapshot is not a test you can name (P2-1)
  const t = real.find((x) => x.via === 'fix' && x.names?.length) ?? real.find((x) => x.via === 'fix') ?? real[0];
  const test = t
    ? t.via === 'symbol'
      ? ` A test that references this code: ${t.file}.`
      : ` Its guarding test: ${t.file}${t.names?.length ? ` » "${t.names[0]}"` : ''}.`
    : ' No test was added with that fix.';
  // a guard-test fact on the same fix is merged here instead of taking a slot (review-1 P1-1)
  const g = guard
    ? ` This change also ${guard.action} ${guard.testFile}${guard.names.length ? ` » "${guard.names[0]}"` : ''} (line ${guard.line}), a test guarding it: if that fix breaks again, what will catch it?`
    : '';
  return (
    `You edit ${where}, lines ${f.shortSha} "${clip(f.subject, 90)}" wrote as a fix${w ? ` (why: ${clip(w, 140)})` : ''}. ` +
    `Does your change keep that fix working?${test}${g} (source: ${f.shortSha} ${f.source.file}:${f.source.line})`
  );
}

function noteText(n: NoteFact & { hunk: { file: string; start: number; n: number } }): string {
  return (
    `Your note on ${n.symbol}${n.status === 'stale' ? ' (written before the code last changed)' : ''} says: "${clip(n.text, 200)}". ` +
    `This change edits ${n.hunk.file}:${range(n.hunk.start, n.hunk.n)} inside it; does the note still hold, or should it change with the code? (source: ${n.file}:${n.line})`
  );
}

function guardText(g: GuardFact, base: string): string {
  const what = g.names.length ? `${g.testFile} » "${g.names[0]}"` : g.testFile;
  return (
    `This change ${g.action} ${what}, a test guarding ${g.fix.shortSha} "${clip(g.fix.subject, 90)}". ` +
    `If that fix breaks again, what will catch it? (source: ${g.testFile}:${g.line} at ${base.slice(0, 10)}; fix ${g.fix.shortSha})`
  );
}

function seenText(s: SeenFact): string {
  return `You looked at ${s.file}:${s.line} ${s.when} (${clip(s.what, 120)}); this change edits it. Is what you understood then still true? (source: ${s.file}:${s.line})`;
}

// ---------- main ----------

type Draft = Omit<Question, 'rank'>;

/**
 * Contract ranking past fix > note > guard-test > seen, cap 3 (review-1 P1-1). A guard-test fact:
 *  - takes a free slot when fewer than 3 higher-ranked questions exist (M4 key G2 asks past fix + guard separately);
 *  - cap full and its fix already has a past-fix question: merged into that question's text, takes no slot;
 *  - else (cap full, its fix not asked): an edited/deleted guard of an UNASKED fix is the one thing the past-fix
 *    questions can't cover (done-when 3), so it replaces the lowest note, or, with no note in the cap, the 3rd past
 *    fix; only one guard may do this. Decision recorded in (internal reference removed) insights.md.
 * Seen questions only fill free slots.
 */
function rank(pastFix: Draft[], notes: Draft[], guards: Array<Draft & { guard: GuardFact }>, seen: Draft[], merge: (sha: string, g: GuardFact) => string): Draft[] {
  const picked: Draft[] = [...pastFix, ...notes].slice(0, MAX_QUESTIONS);
  const merged = new Set<string>();
  let replaced = false;
  for (const { guard: g, ...q } of guards) {
    if (picked.length < MAX_QUESTIONS) {
      picked.push(q); // a free slot: the guard is its own question (M4 key G2: past fix + its deleted guard)
      continue;
    }
    const asked = picked.find((p) => p.kind === 'past-fix' && p.cites.sha === g.fix.sha);
    if (asked) {
      if (!merged.has(g.fix.sha)) asked.text = merge(g.fix.sha, g);
      merged.add(g.fix.sha);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    const noteAt = picked.map((p) => p.kind).lastIndexOf('note');
    picked.splice(noteAt >= 0 ? noteAt : MAX_QUESTIONS - 1, 1);
    picked.push(q);
  }
  for (const q of seen) if (picked.length < MAX_QUESTIONS) picked.push(q);
  return picked;
}

export async function questions(repoRoot: string, change: Change, opts: QuestionsOptions = {}): Promise<QuestionsResult> {
  const root = (await git(resolve(repoRoot), ['rev-parse', '--show-toplevel'])).trim();
  const r = await check(root, change, opts.fixRule !== undefined ? { fixRule: opts.fixRule } : {});
  const rule = new RegExp(r.fixRule, 'i');
  const shallow = (await git(root, ['rev-parse', '--is-shallow-repository']).catch(() => 'false')).trim() === 'true';
  const files = parseDiff(await changeDiff(root, r)).filter((f) => f.blocks.length > 0);
  const base = new BaseFiles(root, r.change.base);
  const notes = await noteFacts(resolve(opts.notesRoot ?? root), files, base);
  const guards = await guardFacts(root, r, files, base, rule, shallow);

  // past fixes on code (non-test) hunks: one question per sha, most lines first
  const bySha = new Map<string, { fix: PastFix; n: number; hunk: { file: string; oldStart: number; oldLines: number }; best: number }>();
  for (const h of r.hunks) {
    if (TEST_FILE.test(h.file)) continue; // a fix on test lines is asked as a guard-test question
    if (NON_CODE.test(h.file)) continue; // docs/changelog/lockfile lines stay in T12's facts, never a question (P2-4)
    for (const f of h.pastFixes) {
      const e = bySha.get(f.sha);
      if (!e) bySha.set(f.sha, { fix: f, n: f.lines.length, hunk: h, best: f.lines.length });
      else {
        e.n += f.lines.length;
        if (f.lines.length > e.best) Object.assign(e, { fix: f, hunk: h, best: f.lines.length });
      }
    }
  }
  const pastFixFacts = [...bySha.values()].sort((a, b) => b.n - a.n || b.fix.date.localeCompare(a.fix.date));
  const where = (h: { file: string; oldStart: number; oldLines: number }) => `${h.file}:${range(h.oldStart, h.oldLines)}`;
  const pastFix: Draft[] = pastFixFacts.map(({ fix, hunk }) => ({
    kind: 'past-fix',
    text: pastFixText(fix, where(hunk)),
    cites: { sha: fix.sha },
    source: { file: fix.source.file, line: fix.source.line, sha: fix.sha },
  }));
  const noteQs: Draft[] = notes.map((n) => ({ kind: 'note', text: noteText(n), cites: { note: n.file }, source: { file: n.file, line: n.line } }));
  const guardQs: Array<Draft & { guard: GuardFact }> = guards.map((g) => ({
    guard: g,
    kind: 'guard-test',
    text: guardText(g, r.change.base),
    cites: { testFile: g.testFile, sha: g.fix.sha },
    source: { file: g.testFile, line: g.line, sha: r.change.base },
  }));
  const seenQs: Draft[] = (opts.seen ?? [])
    .filter((s) => files.some((f) => f.oldPath === s.file && f.blocks.some((b) => b.oldLines > 0 && s.line >= b.oldStart && s.line < b.oldStart + b.oldLines)))
    .map((s) => ({ kind: 'seen', text: seenText(s), cites: s.sha ? { sha: s.sha } : {}, source: { file: s.file, line: s.line, ...(s.sha ? { sha: s.sha } : {}) } }));

  const picked = rank(pastFix, noteQs, guardQs, seenQs, (sha, g) => {
    const e = pastFixFacts.find((x) => x.fix.sha === sha)!;
    return pastFixText(e.fix, where(e.hunk), g);
  });

  const notices: string[] = [];
  let modelCalls = 0;
  if (opts.reword && picked.length) {
    if (!opts.model) notices.push(NO_MODEL_NOTICE);
    else {
      for (const q of picked) {
        modelCalls++;
        let reply = '';
        try {
          reply = (await opts.model(q.text)).trim();
        } catch {
          reply = '';
        }
        // a reworded question must keep its clickable source and the sha it cites, or the template text stays
        const keeps = reply.includes(`${q.source.file}:${q.source.line}`) && (!q.cites.sha || reply.includes(q.cites.sha.slice(0, 7)));
        if (reply && keeps) q.text = reply;
      }
    }
  }

  return {
    questions: picked.map((q, i) => ({ rank: i + 1, ...q })),
    facts: { ...r, notes: notes.map(({ order: _o, hunk: _h, ...n }) => n), guards },
    modelCalls,
    notices,
  };
}

export function formatQuestions(qs: Question[]): string {
  if (!qs.length) return '';
  const out = [`questions (${qs.length}):`];
  for (const q of qs) {
    out.push(`  ${q.rank}. [${q.kind}] ${q.text}`);
    out.push(`     source: ${q.source.sha ? `${q.source.sha.slice(0, 10)} ` : ''}${q.source.file}:${q.source.line}`);
  }
  return out.join('\n');
}
