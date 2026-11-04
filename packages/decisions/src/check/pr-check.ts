// prCheck: which decision records govern a pull request's changed lines, who owns them, what broke there before, and ONE
// GitHub check-run payload built from those facts. Code only: git plumbing + the record files, no model, no network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { computeFlags } from '../flags.js';
import { loadGraph, MOLE_DIR } from '../graph.js';
import { checkRules } from '../rules/check.js';
import { reviewDraftsSummary } from '@mole/reviews';
import type { Flag, GraphNode, Problem } from '../types.js';
import { codeownersAt, parseCodeowners } from './codeowners.js';
import { parseGitDiff, type ChangedFile, type Hunk } from './diff.js';
import { contentAnchorsOf, exportConventionRanges, fileHasTitledResource, hasTitleTerm, isCommentOnlyHunk, isExportConventionTitle, isTestPath, isTfBareBlock, isTsSource, isVersionOnlyHunk, MAX_MATCH_LINE, titleTermsOf, type ContentAnchor } from './options.js';
import type { CheckAnnotation, CheckRunPayload, GovernedRecord, PrCheckOptions, PrCheckResult, PrQuestion, RecordChange, UnanchoredRecord } from './types.js';

export const CHECK_NAME = 'mole';
export const MAX_ANNOTATIONS = 50; // GitHub accepts at most 50 annotations per check-run request
/** statuses that never govern lines: their successor (or nothing) does */
const NOT_GOVERNING = new Set(['superseded', 'deprecated', 'rejected', 'retired']);

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
}
function gitOrNull(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** T49: cheap pre-check (one `git grep` at `head`, no checkout) so rules wiring costs nothing on the common case
 *  (no decision in this repo has a `rules:` item -- true of every M2 bench ADR, since none author rules items).
 *  Only when this is true do we pay for a worktree checkout + a real dependency-cruiser cruise below. */
function hasRuleRecords(root: string, head: string): boolean {
  try {
    const out = execFileSync('git', ['-C', root, 'grep', '-I', '-l', '-e', '^\\s*rules\\s*:', head, '--', MOLE_DIR], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false; // git grep exits 1 on "no match" (not an error) and on any other failure -- either way, skip
  }
}

/** T49: runs rules/check.ts's real dependency-cruiser + TS-AST engine against the repo AS IT IS AT `head` --
 *  checkRules reads real files off disk (dependency-cruiser's resolver needs a real module graph), so this uses a
 *  throwaway `git worktree` checkout rather than mutating the caller's own working tree. Never throws: a rules
 *  engine failure (git worktree unsupported, no decision records, syntax error in a rule) is additive and must
 *  never block the rest of prCheck. */
async function ruleViolationsAtHead(root: string, head: string, mergeBase: string, recordPaths: string[]): Promise<Map<string, Array<{ file: string; line: number; rule: string }>>> {
  const byDecision = new Map<string, Array<{ file: string; line: number; rule: string }>>();
  // the gate must look at the MERGE BASE too: gating on head alone let a PR skip the whole rules run by deleting the
  // record or stripping its rules: key in the same diff (T49 review FAIL, done-when 2)
  if (!hasRuleRecords(root, mergeBase) && !hasRuleRecords(root, head)) {
    return byDecision;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'mole-rules-head-'));
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', '-f', tmp, head], { stdio: 'ignore' });
    // review 1 P1-1 invariant, extended to rules: a PR must not be able to silence its own rules check by editing
    // or deleting the rule item in the SAME diff -- the records are the merge base's, same as every other anchor
    // kind in this file; only the SOURCE CODE being scanned for a violation is the PR's own head.
    for (const p of recordPaths) {
      try {
        rmSync(join(tmp, p), { recursive: true, force: true });
        const archive = execFileSync('git', ['-C', root, 'archive', mergeBase, '--', p]);
        execFileSync('tar', ['-x', '-C', tmp], { input: archive });
      } catch {
        // the path may not exist at the merge base (a record only added by this PR) -- leave head's copy, if any
      }
    }
    const result = await checkRules(realpathSync(tmp));
    for (const v of result.violations) {
      if (!byDecision.has(v.decision.id)) byDecision.set(v.decision.id, []);
      byDecision.get(v.decision.id)!.push({ file: v.file, line: v.line, rule: v.rule });
    }
  } catch {
    // additive: a broken rules engine run never blocks the content/scope-anchor governance below
  } finally {
    try {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', tmp]);
    } catch {
      // the worktree metadata is cleaned up by rmSync below either way
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  return byDecision;
}

type Range = [number, number];
const merge = (rs: Range[]): Range[] => {
  const s = [...rs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
};
const clip = (rs: Range[], lo: number, hi: number): Range[] => rs.map(([a, b]): Range => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => a <= b);

/** changed line ranges of a file: new side (added/modified lines) and old side (removed lines) */
function changedRanges(f: ChangedFile, skip?: (h: Hunk) => boolean): { added: Range[]; removed: Range[]; deletionPoints: number[] } {
  const added: Range[] = [];
  const removed: Range[] = [];
  const deletionPoints: number[] = [];
  for (const h of f.hunks) {
    if (skip?.(h)) continue;
    if (h.newLines > 0) added.push([h.newStart, h.newStart + h.newLines - 1]);
    if (h.oldLines > 0) removed.push([h.oldStart, h.oldStart + h.oldLines - 1]);
    if (h.newLines === 0) deletionPoints.push(Math.max(1, h.newStart));
  }
  return { added: merge(added), removed: merge(removed), deletionPoints };
}

type Anchor = { kind: 'file'; path: string } | { kind: 'folder'; path: string } | { kind: 'symbol'; path: string; tail: string };
function parseAnchor(target: string): Anchor {
  const t = target.trim().replace(/^\.\//, '');
  const i = t.indexOf('#');
  if (i > 0) return { kind: 'symbol', path: t.slice(0, i), tail: t.slice(i + 1) };
  if (t.endsWith('/')) return { kind: 'folder', path: t.replace(/\/+$/, '') };
  return { kind: 'file', path: t };
}
const under = (path: string, folder: string) => folder === '' || folder === '.' || path.startsWith(`${folder}/`);

/** symbol line ranges per (rev, path), parsed with the same extractor the notes use (T11) */
class Symbols {
  private cache = new Map<string, Map<string, Range> | null>();
  private mod: typeof import('@mole/memory') | null = null;
  constructor(private root: string) {}
  async range(rev: string, path: string, tail: string): Promise<Range | null> {
    const k = `${rev}:${path}`;
    if (!this.cache.has(k)) {
      const text = gitOrNull(this.root, ['show', `${rev}:${path}`]);
      if (text === null) this.cache.set(k, null);
      else {
        this.mod ??= await import('@mole/memory');
        const m = new Map<string, Range>();
        try {
          for (const s of this.mod.symbolsOfText(path, text)) if (!m.has(s.tail)) m.set(s.tail, [s.startLine, s.endLine]);
        } catch {
          // not parseable as code: no symbols
        }
        this.cache.set(k, m);
      }
    }
    return this.cache.get(k)?.get(tail) ?? null;
  }
}

function statusFlag(n: GraphNode): Flag {
  if (n.status === 'partly-superseded') return 'yellow';
  return n.status === 'accepted' ? 'green' : 'grey';
}

const levelOf = (flag: Flag): CheckAnnotation['annotation_level'] => (flag === 'green' ? 'notice' : 'warning');
const fmtRanges = (rs: Range[]) => rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');

export async function prCheck(opts: PrCheckOptions): Promise<PrCheckResult> {
  const cleanups: Array<() => void> = []; // merge-base worktree / head snapshot of the records, removed when the check is done
  try {
    return await prCheckIn(opts, cleanups);
  } finally {
    for (const c of cleanups.reverse()) c();
  }
}

const posixRel = (from: string, to: string) => relative(from, to).split(sep).join('/');

async function prCheckIn(opts: PrCheckOptions, cleanups: Array<() => void>): Promise<PrCheckResult> {
  const t0 = performance.now();
  const root = git(resolve(opts.root), ['rev-parse', '--show-toplevel']).trim();
  const head = git(root, ['rev-parse', '--verify', `${opts.head}^{commit}`]).trim();
  const base = git(root, ['rev-parse', '--verify', `${opts.base}^{commit}`]).trim();
  const mergeBase = (gitOrNull(root, ['merge-base', base, head]) ?? base).trim();
  const diffText = git(root, ['diff', '-M', '-U0', '--no-color', '--no-ext-diff', mergeBase, head]);
  const changed = parseGitDiff(diffText);
  const files = changed.map((f) => (f.newPath ?? f.oldPath)!).filter(Boolean);
  const existsAtHead = (path: string) => (gitOrNull(root, ['cat-file', '-e', `${head}:${path}`]) ?? null) !== null;

  // ---- records and their flags (review 1 P1-1): when the records root is inside the checked repository, the records (and
  // notes, .mole/notes) are read AT THE MERGE BASE from git objects (a temporary detached worktree, below), so a PR cannot
  // silence its own check by editing, superseding or deleting a record, and the result does not depend on what is checked
  // out. A records folder outside the repository (the M24 overlays) is read from disk as before.
  const recordsRootAbs = (() => {
    const p = resolve(opts.recordsRoot ?? root);
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  })();
  const recTop = gitOrNull(recordsRootAbs, ['rev-parse', '--show-toplevel'])?.trim();
  const inRepo = recTop === root;
  const sameRepo = inRepo && recordsRootAbs === root;
  const prefix = inRepo ? posixRel(root, recordsRootAbs) : '';
  const recordPaths = [join(prefix, MOLE_DIR), ...(opts.adrDirs ?? []).filter((d) => d && !isAbsolute(d)).map((d) => join(prefix, d))].map((p) => p.split(sep).join('/'));
  // the head side's records, only to list what the PR changes (blobs of the record folders; never governs)
  const snapshot = (rev: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mole-pr-records-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const p of recordPaths) {
      const ls = gitOrNull(root, ['ls-tree', '-r', '-z', '--full-tree', rev, '--', p]) ?? '';
      for (const entry of ls.split('\0')) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);
        if (!m) continue;
        const dest = join(dir, m[2]!);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, execFileSync('git', ['-C', root, 'cat-file', 'blob', m[1]!], { maxBuffer: 64 * 1024 * 1024 }));
      }
    }
    return join(dir, prefix);
  };
  // the merge base as a detached temporary worktree: records, notes AND the files their anchors name are the base's, and
  // its HEAD is the merge base, so the citator flags (anchor drift since the record was confirmed) are the base's too.
  // Hooks are off (core.hooksPath) so no repository script runs; the worktree is removed when the check is done.
  const baseTree = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mole-pr-base-')));
    cleanups.push(() => {
      gitOrNull(root, ['worktree', 'remove', '--force', dir]); // removes its admin entry too (no global `worktree prune`)
      rmSync(dir, { recursive: true, force: true });
    });
    git(root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', dir, mergeBase]);
    return prefix ? join(dir, prefix) : dir;
  };
  const recordsRoot = inRepo ? baseTree() : recordsRootAbs;
  const graph = loadGraph(recordsRoot, { adrDirs: opts.adrDirs });
  const flags = new Map<string, Flag>();
  if (sameRepo) for (const f of computeFlags(graph)) flags.set(f.id, f.flag);
  const symbols = new Symbols(root);

  // records the PR itself adds / edits / deletes: listed, never governing (their merge-base copy governs)
  const recordsChanged: RecordChange[] = [];
  if (inRepo) {
    const isRecord = (p: string | null) => p !== null && recordPaths.some((r) => p === r || p.startsWith(`${r}/`));
    const touched = changed.filter((f) => isRecord(f.oldPath) || isRecord(f.newPath));
    if (touched.length) {
      const headGraph = loadGraph(snapshot(head), { adrDirs: opts.adrDirs });
      const rel = (p: string | null) => (p === null ? null : prefix ? posixRel(prefix, p) : p);
      for (const f of touched) {
        const b = graph.nodes.find((n) => n.file === rel(f.oldPath));
        const h = headGraph.nodes.find((n) => n.file === rel(f.newPath));
        const n = h ?? b;
        if (!n) continue;
        recordsChanged.push({ id: n.id, title: n.title, file: n.file, change: !b ? 'added' : !h ? 'deleted' : 'edited', ...(b ? { statusBase: b.status } : {}), ...(h ? { statusHead: h.status } : {}) });
      }
      recordsChanged.sort((a, b) => a.id.localeCompare(b.id));
    }
  }
  const problems: Problem[] = [];
  const governed: GovernedRecord[] = [];
  const unanchored: UnanchoredRecord[] = [];
  const useContent = opts.contentAnchors !== false;
  const versionRule = opts.versionBumpRule === true; // off by default: it cost recall on both keys (options round, 2 insights)
  const titleGate = opts.titleBumpGate !== false && !versionRule; // option 3, on by default; versionRule (option 2) subsumes it
  const exportGate = opts.exportConventionGate !== false; // option 4 (options round 3), on by default
  const scopeNoise = opts.scopeNoiseFilter !== false; // option 5 (options round 3), on by default
  const tfGate = opts.tfBareBlockTitleGate !== false; // option 6 (options round 3), on by default
  const versionOnly = (h: Hunk) => isVersionOnlyHunk(h.del ?? [], h.add ?? []);
  const content = new Map<string, ContentAnchor[]>();
  // always computed (even when contentAnchors is off) so a record's AUTHORED match: data still counts as "has a
  // content anchor" for the export-convention fallback below (option 4 must never double up with option 1's data)
  for (const n of graph.nodes) if (n.kind === 'decision') content.set(n.id, contentAnchorsOf(recordsRoot, n, NOT_GOVERNING.has(n.status) ? undefined : problems));
  const fits = (s: string) => s.length <= MAX_MATCH_LINE; // review 1 P2-3: bound regex work per line
  // option 4: a scope:[] record with no content anchor but an export-convention title gets a generic AST content
  // anchor (exportConventionRanges) instead; cache each file's head/merge-base text once, not per record.
  const tsTextCache = new Map<string, { newText: string | null; oldText: string | null }>();
  const tsTexts = (path: string) => {
    let t = tsTextCache.get(path);
    if (!t) {
      t = { newText: gitOrNull(root, ['show', `${head}:${path}`]), oldText: gitOrNull(root, ['show', `${mergeBase}:${path}`]) };
      tsTextCache.set(path, t);
    }
    return t;
  };
  // T49 (verifier.md #1, "wire, don't rebuild"): rules/check.ts (dependency-cruiser import rules + Mole's own
  // TS-AST call-rule scan) is a complete, separately-invoked decision-matching engine that prCheck never called --
  // a decision whose ONLY rule items are `rules:` (no scope, no content anchor) could never govern a line even
  // though Mole can already detect the violation with a real dependency-cruiser cruise. Folded in here as a third,
  // crisp-by-construction hit kind (`rule:<name>`), same as a `match:` content anchor.
  const ruleViolationsByDecision = opts.rules !== false && sameRepo ? await ruleViolationsAtHead(root, head, mergeBase, recordPaths) : new Map<string, Array<{ file: string; line: number; rule: string }>>();
  const candidates = graph.nodes.filter(
    (n) =>
      n.kind === 'decision' &&
      !NOT_GOVERNING.has(n.status) &&
      (n.scope.length > 0 || (content.get(n.id)?.length ?? 0) > 0 || (exportGate && isExportConventionTitle(n.title)) || ruleViolationsByDecision.has(n.id)),
  );
  for (const n of candidates) {
    const hits: GovernedRecord['hits'] = [];
    const lost: UnanchoredRecord[] = [];
    // rules (T49): an import:/call: rule violation on a line THIS diff added governs it -- a pre-existing
    // violation elsewhere in the repo that the PR never touched is not something this diff introduced (review 1
    // P1-1 analog), so it is intersected against the diff's own added-line ranges, not reported bare.
    for (const rv of ruleViolationsByDecision.get(n.id) ?? []) {
      const cf = changed.find((f) => f.newPath === rv.file);
      if (!cf) continue;
      const { added } = changedRanges(cf);
      if (!added.some(([a, b]) => rv.line >= a && rv.line <= b)) continue;
      hits.push({ anchor: `rule:${rv.rule}`, path: rv.file, side: 'new', ranges: [[rv.line, rv.line]] });
    }
    // content anchors (option 1): added lines whose text matches, in files the glob covers
    if (useContent)
      for (const c of content.get(n.id) ?? [])
        for (const f of changed) {
          if (f.newPath === null || (c.inRe && !c.inRe.test(f.newPath))) continue;
          const rs: Range[] = [];
          for (const h of f.hunks) {
            const add = h.add ?? [];
            // a version-only hunk names its dependency in the enclosing block, not on the changed line (option 2)
            if (versionRule && h.newLines > 0 && fits(h.context ?? '') && c.re.test(h.context ?? '') && versionOnly(h)) {
              rs.push([h.newStart, h.newStart + h.newLines - 1]);
              continue;
            }
            add.forEach((line, i) => {
              if (fits(line) && c.re.test(line)) rs.push([h.newStart + i, h.newStart + i]);
            });
          }
          if (rs.length) hits.push({ anchor: `match:${c.pattern}`, path: f.newPath, side: 'new', ranges: merge(rs) });
        }
    // option 4: export-convention records (scope:[], no content anchor, title is itself about exports) govern a new
    // named export anywhere in a non-test TS/TSX file (AST-detected, see options.ts); never fires when scope or a
    // content anchor already exists for this record (both already more specific than this generic fallback).
    if (n.scope.length === 0 && (content.get(n.id)?.length ?? 0) === 0 && exportGate && isExportConventionTitle(n.title)) {
      for (const f of changed) {
        const path = f.newPath;
        if (!path || !isTsSource(path) || (scopeNoise && isTestPath(path))) continue;
        const { added } = changedRanges(f, (h) => scopeNoise && isCommentOnlyHunk(h.add ?? []));
        if (!added.length) continue;
        const { newText, oldText } = tsTexts(path);
        if (newText === null) continue;
        const ranges = exportConventionRanges(path, newText, oldText, added);
        if (ranges.length) hits.push({ anchor: 'export-convention', path, side: 'new', ranges });
      }
    }
    for (const a of n.scope) {
      const an = parseAnchor(a.target);
      const titleTerms = (titleGate || tfGate) && (an.kind === 'file' || an.kind === 'folder') ? titleTermsOf(n.title) : [];
      const tfFileCache = new Map<string, string | null>();
      const tfFileRelevant = (path: string): boolean => {
        if (!tfFileCache.has(path)) tfFileCache.set(path, gitOrNull(root, ['show', `${head}:${path}`]));
        const text = tfFileCache.get(path) ?? null;
        return !!text && fileHasTitledResource(text, titleTerms);
      };
      const perHunkSkip = (h: Hunk, path: string): boolean => {
        if (scopeNoise && isCommentOnlyHunk(h.add ?? [])) return true; // option 5: a comment/doc-only hunk is never governed
        if (versionRule) return versionOnly(h); // option 2: unconditional drop
        if (!titleTerms.length) return false;
        const vOnly = versionOnly(h);
        // option 6: a Terraform bare block (locals/variable/output, no resource-type signal) in a file that never
        // names the title's technology in any of its OWN resource blocks is gated the same way a version bump is;
        // a file that does (e.g. the helm_release sits beside a `locals` block in the same file) stays ungated.
        const bareBlock = !vOnly && tfGate && /\.tf$/.test(path) && isTfBareBlock(h.context ?? '') && !tfFileRelevant(path);
        if (vOnly ? !titleGate : !bareBlock) return false;
        const ctx = h.context ?? '';
        const add = (h.add ?? []).join('\n');
        const mentions = (fits(ctx) && hasTitleTerm(ctx, titleTerms)) || hasTitleTerm(add, titleTerms);
        return !mentions; // drop only when the hunk names none of the record's own title vocabulary
      };
      for (const f of changed) {
        // option 5: a scope anchor governs production code, not its own tests
        if (scopeNoise && ((f.newPath && isTestPath(f.newPath)) || (f.oldPath && isTestPath(f.oldPath)))) continue;
        const skip = (h: Hunk) => perHunkSkip(h, f.newPath ?? f.oldPath ?? '');
        const { added, removed, deletionPoints } = changedRanges(f, skip);
        if (versionRule && f.hunks.length > 0 && f.hunks.every(versionOnly)) continue; // only dependency bumps in this file
        const push = (side: 'new' | 'old', path: string, ranges: Range[]) => {
          if (ranges.length) hits.push({ anchor: a.target, path, side, ranges });
        };
        // a rename away from the anchored path: the anchor cannot re-attach (it never follows the file to a new name)
        const renamedAway = f.status === 'R' && f.oldPath !== null && (an.kind === 'folder' ? under(f.oldPath, an.path) && !under(f.newPath ?? '', an.path) : f.oldPath === an.path);
        if (renamedAway && an.kind !== 'folder' && !existsAtHead(an.path)) {
          lost.push({ id: n.id, title: n.title, flag: 'grey', anchor: a.target, path: f.oldPath!, renamedTo: f.newPath ?? undefined, reason: `${f.oldPath} was renamed to ${f.newPath}; the anchor ${a.target} no longer resolves at the head` });
          continue;
        }
        if (an.kind === 'file' || an.kind === 'folder') {
          const hitNew = f.newPath !== null && (an.kind === 'file' ? f.newPath === an.path || under(f.newPath, an.path) : under(f.newPath, an.path));
          const hitOld = f.oldPath !== null && (an.kind === 'file' ? f.oldPath === an.path || under(f.oldPath, an.path) : under(f.oldPath, an.path));
          if (hitNew) {
            push('new', f.newPath!, added.length ? added : deletionPoints.map((p): Range => [p, p]));
            if (!added.length && !deletionPoints.length && f.status === 'R') push('new', f.newPath!, [[1, 1]]); // pure rename into the scope
          } else if (hitOld) push('old', f.oldPath!, removed.length ? removed : [[1, 1]]);
          continue;
        }
        // symbol anchor: the symbol's lines at the head (added lines) and at the merge base (removed lines)
        if (f.newPath === an.path) {
          const r = await symbols.range(head, an.path, an.tail);
          if (r) push('new', an.path, clip(added, r[0], r[1]));
        }
        if (f.oldPath === an.path) {
          const r = await symbols.range(mergeBase, an.path, an.tail);
          if (r) {
            const gone = clip(removed, r[0], r[1]);
            if (gone.length && !hits.some((h) => h.anchor === a.target && h.side === 'new')) push('old', an.path, gone);
          }
        }
      }
    }
    if (hits.length) {
      governed.push({ id: n.id, title: n.title, status: n.status, flag: flags.get(n.id) ?? statusFlag(n), file: n.file, line: n.line, hits });
    } else if (lost.length) unanchored.push(lost[0]!);
  }
  governed.sort((a, b) => a.id.localeCompare(b.id));
  unanchored.sort((a, b) => a.id.localeCompare(b.id));

  // ---- owners: CODEOWNERS at the merge base, every changed path (both names of a rename)
  const co = codeownersAt(root, mergeBase);
  const owners = co ? parseCodeowners(co.text) : null;
  const ownersByFile: Record<string, string[]> = {};
  for (const f of changed) for (const p of [f.oldPath, f.newPath]) if (p && !(p in ownersByFile)) ownersByFile[p] = owners ? owners.ownersOf(p) : [];
  const allOwners = [...new Set(Object.values(ownersByFile).flat())].sort();

  const silent = governed.length === 0 && unanchored.length === 0 && recordsChanged.length === 0 && problems.length === 0;

  // ---- past fixes (T12) + questions (T14): only when something governs, so a silent check stays cheap and quiet
  let pastFixes: PrCheckResult['pastFixes'] = [];
  let questions: PrQuestion[] = [];
  if (!silent && opts.history !== false && changed.some((f) => f.hunks.length)) {
    const tmp = mkdtempSync(join(tmpdir(), 'mole-pr-check-'));
    try {
      const diffFile = join(tmp, 'pr.diff');
      writeFileSync(diffFile, git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase, head]));
      const q = await import('@mole/questions');
      const r = await q.questions(root, { diffFile, base: mergeBase }, { notesRoot: opts.notesRoot ? resolve(opts.notesRoot) : recordsRoot, ...(opts.fixRule ? { fixRule: opts.fixRule } : {}) });
      const seen = new Set<string>();
      for (const h of r.facts.hunks)
        for (const p of h.pastFixes)
          if (!seen.has(`${h.file}\0${p.sha}`)) {
            seen.add(`${h.file}\0${p.sha}`);
            pastFixes.push({ file: h.file, line: h.newStart > 0 ? h.newStart : 1, sha: p.sha, subject: p.subject });
          }
      questions = r.questions.slice(0, 3).map((x) => ({ rank: x.rank, kind: x.kind, text: x.text, source: x.source }));
    } catch {
      pastFixes = [];
      questions = [];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const checkRun = buildCheckRun({ head, governed, unanchored, owners: allOwners, ownersByFile, codeownersFile: co?.path ?? null, pastFixes, questions, recordsChanged, problems, silent, changed, reviewDrafts: silent ? [] : await reviewDraftsSummary(root).catch(() => []) });
  return { base, head, mergeBase, files, governed, unanchored, owners: allOwners, ownersByFile, codeownersFile: co?.path ?? null, pastFixes, questions, recordsChanged, problems, silent, checkRun, ms: Math.round(performance.now() - t0) };
}

function buildCheckRun(r: {
  head: string;
  governed: GovernedRecord[];
  unanchored: UnanchoredRecord[];
  owners: string[];
  ownersByFile: Record<string, string[]>;
  codeownersFile: string | null;
  pastFixes: PrCheckResult['pastFixes'];
  questions: PrQuestion[];
  recordsChanged: RecordChange[];
  problems: Problem[];
  silent: boolean;
  changed: ChangedFile[];
  /** T40: design review / meeting note drafts awaiting a person's approval (Granola model, D38), surfaced on
   *  this SAME check-run (one rewritten-in-place payload per push) instead of a second PR comment. */
  reviewDrafts: string[];
}): CheckRunPayload {
  if (r.silent) return { name: CHECK_NAME, head_sha: r.head, status: 'completed', conclusion: 'neutral', output: { title: 'mole: nothing governed these lines', summary: 'nothing governed', annotations: [] } };
  const annotations: CheckAnnotation[] = [];
  const add = (a: CheckAnnotation) => {
    if (annotations.length < MAX_ANNOTATIONS) annotations.push(a);
  };
  const atHead = new Set(r.changed.map((f) => f.newPath).filter((p): p is string => !!p));
  const deletionPoint = (path: string) => r.changed.find((f) => f.oldPath === path && f.newPath)?.hunks.find((h) => h.newLines === 0)?.newStart ?? 1;
  for (const g of r.governed)
    for (const h of g.hits) {
      const own = r.ownersByFile[h.path] ?? [];
      const message = `${g.title}\n${g.id} (${g.status}, flag ${g.flag}) governs these lines through scope ${h.anchor}; record ${g.file}:${g.line}${own.length ? `\nowners: ${own.join(' ')}` : ''}`;
      if (h.side === 'new') for (const [a, b] of h.ranges) add({ path: h.path, start_line: a, end_line: b, annotation_level: levelOf(g.flag), title: `${g.id} ${g.flag}: ${g.title}`.slice(0, 255), message });
      else if (atHead.has(h.path)) {
        const p = Math.max(1, deletionPoint(h.path));
        add({ path: h.path, start_line: p, end_line: p, annotation_level: levelOf(g.flag), title: `${g.id} ${g.flag}: ${g.title}`.slice(0, 255), message: `${message}\n(removed lines ${fmtRanges(h.ranges)} at the base)` });
      }
    }
  for (const u of r.unanchored)
    if (u.renamedTo) add({ path: u.renamedTo, start_line: 1, end_line: 1, annotation_level: 'notice', title: `${u.id} grey: unanchored`, message: `${u.title}\n${u.reason}. Re-anchor the record (scope) to keep it attached; it is not applied to the new file.` });
  for (const p of r.pastFixes.slice(0, 10))
    if (atHead.has(p.file)) add({ path: p.file, start_line: Math.max(1, p.line), end_line: Math.max(1, p.line), annotation_level: 'notice', title: `past fix ${p.sha.slice(0, 7)}`, message: p.subject });

  const s: string[] = [];
  if (r.governed.length) {
    s.push(`### Decisions that govern these lines (${r.governed.length})`);
    for (const g of r.governed) s.push(`- **${g.id}** (${g.flag}) ${g.title} · ${g.file}:${g.line} · ${g.hits.map((h) => `${h.path}:${fmtRanges(h.ranges)}${h.side === 'old' ? ' (removed)' : ''}`).join('; ')}`);
  }
  if (r.unanchored.length) {
    s.push(`### Unanchored (${r.unanchored.length}, grey)`);
    for (const u of r.unanchored) s.push(`- **${u.id}** ${u.title}: ${u.reason}`);
  }
  if (r.recordsChanged.length) {
    s.push(`### Records this PR changes (${r.recordsChanged.length})`, '_this check applies the records as they are at the merge base; these edits take effect after merge_');
    for (const c of r.recordsChanged) s.push(`- **${c.id}** ${c.title} · ${c.file}: ${c.change}${c.change === 'edited' && c.statusBase !== c.statusHead ? `, ${c.statusBase} → ${c.statusHead}` : c.change === 'added' ? ` (${c.statusHead})` : ''}`);
  }
  if (r.problems.length) {
    s.push(`### Record problems (${r.problems.length})`);
    for (const p of r.problems) s.push(`- ${p.file}:${p.line} ${p.message}`);
  }
  s.push(`### Owners`, r.codeownersFile ? (r.owners.length ? r.owners.join(' ') : `no owners in ${r.codeownersFile} for these files`) : 'no CODEOWNERS file');
  if (r.pastFixes.length) {
    s.push(`### Past fixes on these lines (${r.pastFixes.length})`);
    for (const p of r.pastFixes.slice(0, 5)) s.push(`- ${p.sha.slice(0, 7)} ${p.subject} · ${p.file}`);
  }
  if (r.questions.length) {
    s.push(`### Questions for the author (${r.questions.length})`);
    for (const q of r.questions) s.push(`${q.rank}. ${q.text}`);
  }
  if (r.reviewDrafts.length) {
    s.push(`### Draft decisions from recent reviews/meetings (${r.reviewDrafts.length})`, '_drafted from sparse notes (Granola model); a person must approve each one before it becomes a record (D38)_');
    for (const d of r.reviewDrafts.slice(0, 10)) s.push(`- ${d}`);
  }
  const parts = [`${r.governed.length} decision${r.governed.length === 1 ? '' : 's'} govern these lines`];
  if (r.unanchored.length) parts.push(`${r.unanchored.length} unanchored`);
  if (r.recordsChanged.length) parts.push(`${r.recordsChanged.length} record${r.recordsChanged.length === 1 ? '' : 's'} changed by this PR`);
  if (r.problems.length) parts.push(`${r.problems.length} record problem${r.problems.length === 1 ? '' : 's'}`);
  return { name: CHECK_NAME, head_sha: r.head, status: 'completed', conclusion: 'neutral', output: { title: `mole: ${parts.join(', ')}`, summary: s.join('\n').slice(0, 65000), annotations } };
}

export function formatPrCheck(r: PrCheckResult): string {
  const out: string[] = [`mole pr-check ${r.mergeBase.slice(0, 7)}..${r.head.slice(0, 7)}: ${r.files.length} files · ${r.checkRun.output.title}`];
  if (r.silent) return out.join('\n');
  out.push(r.checkRun.output.summary);
  out.push(`(${r.checkRun.output.annotations.length} annotations, ${r.ms} ms)`);
  return out.join('\n');
}
