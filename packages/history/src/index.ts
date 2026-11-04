// @mole/history: L2 "the why + what broke before" (T12).
// For a change (commit, diff file or working tree): per edited hunk, the past fix commits that last
// wrote those lines (git blame on the parent), with their reason, guarding tests and a clickable source.
// Deterministic git plumbing only: no model calls (modelCalls stays 0). Never writes to the repo.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDiff, type Block, type FileDiff } from './diff.js';
import { EMPTY_TREE, git, pool } from './git.js';
import { withSpan } from '@mole/telemetry';

export { parseDiff, type Block, type FileDiff } from './diff.js';

export type Change = { sha: string } | { diffFile: string; base?: string } | { worktree: true };

export interface CheckOptions {
  /** which commits count as fixes; default DEFAULT_FIX_RULE, else .mole/config.json {"fixRule"} */
  fixRule?: RegExp | string;
}

export interface ReasonSource {
  kind: 'commit' | 'comment' | 'task' | 'note';
  /** repo-relative path (comment: file in the fix commit; task/note: the file) */
  path?: string;
  line?: number;
  text: string;
}

export interface GuardTest {
  file: string;
  /** describe/it titles the fix added or edited next to */
  names?: string[];
  /** fix = the fix commit touched it; symbol = it references the edited symbol at the base */
  via?: 'fix' | 'symbol';
}

export interface PastFix {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  author: string;
  reason: string;
  reasonSources: ReasonSource[];
  tests: GuardTest[];
  /** clickable source: the fix commit and the line in its own version of the file */
  source: { sha: string; file: string; line: number };
  /** base-side line numbers of this hunk that the fix last wrote */
  lines: number[];
}

export interface Hunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  pastFixes: PastFix[];
}

export interface CheckResult {
  change: { kind: 'sha' | 'diff' | 'worktree'; ref: string; base: string };
  fixRule: string;
  hunks: Hunk[];
  noPastFixes: boolean;
  ms: number;
}

export const DEFAULT_FIX_RULE = '^(fix|revert)\\b|regression|review fixes';

/** counts model (LLM) calls made by this package: there are none, and the bench asserts 0 */
export const modelCalls = { count: 0 };

export const NO_PAST_FIXES = 'no past fixes on these lines';

const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const TRAILER = /^(signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|reported-by|change-id|cc|helped-by):/i;
const TITLE = /\b(?:describe|it|test|suite|context)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)+?)\1/g;
const SYMBOL_SKIP = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'describe', 'it', 'test', 'new', 'await', 'async', 'export', 'default']);

interface CommitInfo {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  body: string;
}

interface BlameLine {
  sha: string;
  origLine: number;
  origFile: string;
  boundary: boolean;
}

interface FixDetail {
  /** per file in the fix commit's version: lines it added */
  added: Map<string, Array<{ line: number; text: string }>>;
  tests: GuardTest[];
}

function compileRule(rule: RegExp | string): RegExp {
  if (rule instanceof RegExp) return new RegExp(rule.source, rule.flags.replace(/[gy]/g, ''));
  return new RegExp(rule, 'i');
}

function configRule(root: string): string | undefined {
  const p = join(root, '.mole', 'config.json');
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { fixRule?: unknown };
    return typeof j.fixRule === 'string' && j.fixRule ? j.fixRule : undefined;
  } catch {
    return undefined;
  }
}

async function commitInfos(root: string, shas: string[]): Promise<Map<string, CommitInfo>> {
  const out = new Map<string, CommitInfo>();
  for (let i = 0; i < shas.length; i += 500) {
    const chunk = shas.slice(i, i + 500);
    const raw = await git(root, ['log', '--no-walk=unsorted', '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%b%x1e', ...chunk]);
    for (const rec of raw.split('\x1e')) {
      const parts = rec.replace(/^\n/, '').split('\x1f');
      if (parts.length < 6) continue;
      const [sha, parents, author, date, subject, body] = parts as [string, string, string, string, string, string];
      out.set(sha, { sha, parents: parents.split(' ').filter(Boolean), author, date, subject, body });
    }
  }
  return out;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const s = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of s) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** one blame call per file with every -L range; base-side line -> who last wrote it */
async function blame(root: string, rev: string, file: string, ranges: Array<[number, number]>): Promise<Map<number, BlameLine>> {
  const out = new Map<number, BlameLine>();
  const args = ['blame', '--porcelain'];
  for (const [a, b] of mergeRanges(ranges)) args.push('-L', `${a},${b}`);
  args.push(rev, '--', file);
  let raw: string;
  try {
    raw = await git(root, args);
  } catch {
    return out; // file missing at the base, or ranges past its end (a diff that does not apply to the base)
  }
  const fileOf = new Map<string, string>();
  const boundaryOf = new Set<string>();
  let cur: { sha: string; orig: number; final: number } | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\t')) {
      if (cur) out.set(cur.final, { sha: cur.sha, origLine: cur.orig, origFile: fileOf.get(cur.sha) ?? file, boundary: boundaryOf.has(cur.sha) });
      cur = undefined;
      continue;
    }
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (h) {
      cur = { sha: h[1]!, orig: Number(h[2]), final: Number(h[3]) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('filename ')) fileOf.set(cur.sha, line.slice(9));
    else if (line === 'boundary') boundaryOf.add(cur.sha);
  }
  return out;
}

function cleanBody(body: string): string {
  return body
    .split('\n')
    .filter((l) => !TRAILER.test(l.trim()) && !/^-{3,}\s*$/.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function commentText(text: string, file: string): string | undefined {
  const t = text.trim();
  const js = /^(\/\/+|\/\*+|\*(?!\/))\s*/;
  if (js.test(t)) {
    const c = t.replace(js, '').replace(/\*+\/\s*$/, '').trim();
    return c.length >= 8 ? c : undefined;
  }
  if (t.startsWith('#') && !/\.[cm]?[jt]sx?$/.test(file)) {
    const c = t.replace(/^#+\s*/, '').trim();
    return c.length >= 8 && !c.startsWith('!') ? c : undefined;
  }
  return undefined;
}

function symbolOf(context: string): string | undefined {
  const decl = /\b(?:function\*?|class|interface|enum|type|const|let|var|def|func|fn)\s+([A-Za-z_$][\w$]*)/.exec(context);
  if (decl) return decl[1];
  for (const m of context.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?)?\(/g)) if (!SYMBOL_SKIP.has(m[1]!)) return m[1];
  return undefined;
}

class Run {
  private infos = new Map<string, CommitInfo>();
  private details = new Map<string, Promise<FixDetail>>();
  private tasks?: Promise<string[]>;
  private notes?: Array<{ path: string; lines: string[] }>;
  private symbolTests = new Map<string, Promise<string[]>>();

  constructor(
    readonly root: string,
    readonly base: string,
    readonly rule: RegExp,
    readonly shallow: boolean,
  ) {}

  async loadInfos(shas: string[]): Promise<void> {
    const missing = shas.filter((s) => !this.infos.has(s));
    if (missing.length) for (const [k, v] of await commitInfos(this.root, missing)) this.infos.set(k, v);
  }

  isFix(sha: string): boolean {
    const c = this.infos.get(sha);
    // subject only: a feature commit whose body mentions "regression tests" is not a fix (T12 review P2-1; B2's rule is subject-based too)
    return !!c && this.rule.test(c.subject);
  }

  info(sha: string): CommitInfo | undefined {
    return this.infos.get(sha);
  }

  detail(sha: string): Promise<FixDetail> {
    let p = this.details.get(sha);
    if (!p) {
      p = this.loadDetail(sha);
      this.details.set(sha, p);
    }
    return p;
  }

  private async loadDetail(sha: string): Promise<FixDetail> {
    const parent = this.infos.get(sha)?.parents[0] ?? EMPTY_TREE;
    const raw = await git(this.root, ['diff', '-U0', '--no-color', '--no-ext-diff', parent, sha]).catch(() => '');
    const added = new Map<string, Array<{ line: number; text: string }>>();
    const tests: GuardTest[] = [];
    for (const f of parseDiff(raw)) {
      const path = f.newPath ?? f.oldPath;
      if (!path) continue;
      if (f.newPath) added.set(f.newPath, f.blocks.flatMap((b) => b.added));
      if (TEST_FILE.test(path)) {
        const names: string[] = [];
        const push = (s: string) => {
          for (const m of s.matchAll(TITLE)) if (!names.includes(m[2]!)) names.push(m[2]!);
        };
        for (const b of f.blocks) push(b.context);
        for (const b of f.blocks) for (const a of b.added) push(a.text);
        tests.push({ file: path, names: names.slice(0, 12), via: 'fix' });
      }
    }
    return { added, tests };
  }

  /** task folders ((internal reference removed)) at the base, read from git objects */
  taskDirs(): Promise<string[]> {
    this.tasks ??= git(this.root, ['ls-tree', '-d', '--name-only', this.base, '(internal reference removed)'])
      .then((o) => o.split('\n').filter(Boolean))
      .catch(() => []);
    return this.tasks;
  }

  async taskReason(subject: string): Promise<ReasonSource[]> {
    const tags = [...new Set([...subject.matchAll(/\b(T\d+)\b/g)].map((m) => m[1]!))];
    if (!tags.length) return [];
    const dirs = await this.taskDirs();
    const out: ReasonSource[] = [];
    for (const tag of tags) {
      const dir = dirs.find((d) => d.startsWith(`(internal reference removed)`));
      if (!dir) continue;
      const path = `${dir}/0 start.md`;
      const text = await git(this.root, ['show', `${this.base}:${path}`]).catch(() => '');
      const lines = text.split('\n');
      const i = lines.findIndex((l) => /^\s*goal\s{2,}/.test(l));
      out.push({ kind: 'task', path, line: i >= 0 ? i + 1 : 1, text: i >= 0 ? lines[i]!.replace(/^\s*goal\s+/, '').trim() : dir.slice('(internal reference removed)'.length) });
    }
    return out;
  }

  noteReason(sha: string): ReasonSource[] {
    if (!this.notes) {
      this.notes = [];
      const dir = join(this.root, '.mole', 'notes');
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
          try {
            this.notes.push({ path: `.mole/notes/${f}`, lines: readFileSync(join(dir, f), 'utf8').split('\n') });
          } catch {
            /* unreadable note: skip */
          }
        }
      }
    }
    const short = sha.slice(0, 7);
    const out: ReasonSource[] = [];
    for (const n of this.notes) n.lines.forEach((l, i) => l.includes(short) && out.push({ kind: 'note', path: n.path, line: i + 1, text: l.trim() }));
    return out;
  }

  /** test files at the base that reference the symbol (word match) */
  testsReferencing(symbol: string): Promise<string[]> {
    let p = this.symbolTests.get(symbol);
    if (!p) {
      const spec = [':(glob)**/*.test.*', ':(glob)**/*.spec.*', ':(glob)**/test/**', ':(glob)**/tests/**', ':(glob)**/__tests__/**'];
      p = git(this.root, ['grep', '-l', '-w', '-F', '-e', symbol, this.base, '--', ...spec])
        .then((o) => o.split('\n').filter(Boolean).map((l) => l.slice(this.base.length + 1)))
        .catch(() => []);
      this.symbolTests.set(symbol, p);
    }
    return p;
  }
}

async function resolveChange(root: string, change: Change): Promise<{ kind: CheckResult['change']['kind']; ref: string; base: string; diff: string }> {
  if ('sha' in change) {
    const sha = (await git(root, ['rev-parse', '--verify', `${change.sha}^{commit}`])).trim();
    const parents = (await git(root, ['log', '-1', '--format=%P', sha])).trim().split(' ').filter(Boolean);
    const base = parents[0] ?? EMPTY_TREE;
    const diff = await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', base, sha]);
    return { kind: 'sha', ref: sha, base, diff };
  }
  if ('diffFile' in change) {
    const base = (await git(root, ['rev-parse', '--verify', `${change.base ?? 'HEAD'}^{commit}`])).trim();
    return { kind: 'diff', ref: resolve(change.diffFile), base, diff: readFileSync(change.diffFile, 'utf8') };
  }
  const base = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  return { kind: 'worktree', ref: 'working tree', base, diff: await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']) };
}

// spans (T16): no-ops unless MOLE_OTEL=1 started @mole/telemetry in this process
export function check(repoRoot: string, change: Change, opts: CheckOptions = {}): Promise<CheckResult> {
  return withSpan('mole.history.check', {}, async (set) => {
    const r = await checkInner(repoRoot, change, opts);
    set({ 'mole.change.kind': r.change.kind, 'mole.hunks': r.hunks.length, 'mole.past_fixes': r.hunks.reduce((n, h) => n + h.pastFixes.length, 0) });
    return r;
  });
}

async function checkInner(repoRoot: string, change: Change, opts: CheckOptions): Promise<CheckResult> {
  const t0 = performance.now();
  const root = (await git(resolve(repoRoot), ['rev-parse', '--show-toplevel'])).trim();
  const ruleSrc = opts.fixRule ?? configRule(root) ?? DEFAULT_FIX_RULE;
  const rule = compileRule(ruleSrc);
  const c = await withSpan('mole.git.resolve_change', {}, () => resolveChange(root, change));
  const shallow = (await git(root, ['rev-parse', '--is-shallow-repository']).catch(() => 'false')).trim() === 'true';
  const run = new Run(root, c.base, rule, shallow);
  const files = parseDiff(c.diff).filter((f) => f.blocks.length > 0);

  // 1) blame the old side of every block, one call per file
  const blamed = await withSpan('mole.git.blame', { 'mole.files': files.length }, () =>
    pool(files, 8, async (f) => {
      const ranges = f.blocks.filter((b) => b.oldLines > 0).map((b): [number, number] => [b.oldStart, b.oldStart + b.oldLines - 1]);
      if (!f.oldPath || !ranges.length || c.base === EMPTY_TREE) return new Map<number, BlameLine>();
      return blame(root, c.base, f.oldPath, ranges);
    }),
  );
  const shas = new Set<string>();
  for (const m of blamed) for (const b of m.values()) if (!(b.boundary && shallow)) shas.add(b.sha);
  // fix lookup: commit info (subject vs fix rule) for every blamed sha
  await withSpan('mole.history.fix_lookup', { 'mole.commits': shas.size }, () => run.loadInfos([...shas]));

  // 2) per block: fix commits among the blamed lines
  const hunks: Hunk[] = [];
  const pending: Array<{ hunk: Hunk; block: Block; groups: Map<string, BlameLine[]>; finals: Map<string, number[]> }> = [];
  files.forEach((f, i) => {
    const bl = blamed[i]!;
    for (const block of f.blocks) {
      const hunk: Hunk = { file: f.newPath ?? f.oldPath ?? '', oldStart: block.oldStart, oldLines: block.oldLines, newStart: block.newStart, newLines: block.newLines, pastFixes: [] };
      hunks.push(hunk);
      const groups = new Map<string, BlameLine[]>();
      const finals = new Map<string, number[]>();
      for (let n = block.oldStart; n < block.oldStart + block.oldLines; n++) {
        const b = bl.get(n);
        if (!b || (b.boundary && shallow) || !run.isFix(b.sha)) continue;
        (groups.get(b.sha) ?? groups.set(b.sha, []).get(b.sha)!).push(b);
        (finals.get(b.sha) ?? finals.set(b.sha, []).get(b.sha)!).push(n);
      }
      if (groups.size) pending.push({ hunk, block, groups, finals });
    }
  });

  // 3) reasons, tests and sources (fix details cached per sha); span = symbol resolution (enclosing symbol -> tests at the base)
  await withSpan('mole.history.symbol_resolution', { 'mole.fix_hunks': pending.length }, () => pool(pending, 8, async ({ hunk, block, groups, finals }) => {
    const symbol = symbolOf(block.context);
    const symTests = symbol ? await run.testsReferencing(symbol) : [];
    for (const [sha, lines] of groups) {
      const info = run.info(sha)!;
      const d = await run.detail(sha);
      const file = lines[0]!.origFile;
      const origLines = lines.filter((l) => l.origFile === file).map((l) => l.origLine);
      const line = Math.min(...origLines);
      const reasonSources: ReasonSource[] = [{ kind: 'commit', text: info.subject }];
      // comments the fix added in this file: nearest to the blamed lines first, at most 3
      const comments = (d.added.get(file) ?? [])
        .map((a) => ({ ...a, c: commentText(a.text, file), dist: Math.min(...origLines.map((o) => Math.abs(o - a.line))) }))
        .filter((a) => a.c !== undefined)
        .sort((a, b) => a.dist - b.dist || a.line - b.line);
      const near = comments.filter((a) => a.dist <= 20);
      const picked = (near.length >= 2 ? near : [...near, ...comments.filter((a) => a.dist > 20)]).slice(0, 3);
      for (const a of picked) reasonSources.push({ kind: 'comment', path: file, line: a.line, text: a.c! });
      reasonSources.push(...(await run.taskReason(info.subject)), ...run.noteReason(sha));
      const body = cleanBody(info.body);
      const reason = [
        body ? `${info.subject} — ${clip(body, 600)}` : info.subject,
        ...reasonSources.filter((s) => s.kind !== 'commit').map((s) => `${s.kind === 'comment' ? `comment ${s.path}:${s.line}` : `${s.kind} ${s.path}:${s.line}`}: ${clip(s.text, 300)}`),
      ].join(' | ');
      const tests: GuardTest[] = d.tests.map((t) => ({ ...t, names: [...(t.names ?? [])] }));
      for (const t of symTests.slice(0, 5)) if (!tests.some((x) => x.file === t)) tests.push({ file: t, via: 'symbol' });
      hunk.pastFixes.push({
        sha,
        shortSha: sha.slice(0, 7),
        subject: info.subject,
        date: info.date,
        author: info.author,
        reason,
        reasonSources,
        tests,
        source: { sha, file, line },
        lines: finals.get(sha)!,
      });
    }
    hunk.pastFixes.sort((a, b) => b.lines.length - a.lines.length || b.date.localeCompare(a.date));
  }));

  return {
    change: { kind: c.kind, ref: c.ref, base: c.base },
    fixRule: rule.source,
    hunks,
    noPastFixes: hunks.every((h) => h.pastFixes.length === 0),
    ms: Math.round(performance.now() - t0),
  };
}

const range = (start: number, n: number) => (n <= 1 ? `${start}` : `${start}-${start + n - 1}`);

export function formatCheck(r: CheckResult): string {
  const head = `mole check ${r.change.kind === 'sha' ? r.change.ref.slice(0, 10) : r.change.ref} (base ${r.change.base.slice(0, 10)}, fix rule /${r.fixRule}/i)`;
  if (r.noPastFixes) return `${head}\n${r.hunks.length} hunk${r.hunks.length === 1 ? '' : 's'}: ${NO_PAST_FIXES}`;
  const out = [head];
  for (const h of r.hunks) {
    if (!h.pastFixes.length) continue;
    out.push(`${h.file}:${h.oldLines ? range(h.oldStart, h.oldLines) : `+${h.newStart}`}`);
    for (const f of h.pastFixes) {
      out.push(`  ${f.shortSha} ${f.subject}`);
      out.push(`    why: ${f.reason}`);
      const tests = f.tests.map((t) => `${t.file}${t.names?.length ? ` (${t.names.slice(0, 4).join('; ')})` : ''}${t.via === 'symbol' ? ' [references the symbol]' : ''}`);
      out.push(`    tests: ${tests.length ? tests.join(', ') : 'none found'}`);
      out.push(`    source: ${f.sha} ${f.source.file}:${f.source.line}`);
    }
  }
  const quiet = r.hunks.filter((h) => !h.pastFixes.length).length;
  if (quiet) out.push(`(${quiet} other hunk${quiet === 1 ? '' : 's'}: ${NO_PAST_FIXES})`);
  return out.join('\n');
}
