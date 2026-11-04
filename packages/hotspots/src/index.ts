// @mole/hotspots: rank code areas to pay down (T70, D68) by churn x complexity (Tornhill/code-maat's
// hotspot method), with decision volatility and incident/fix density reported as separate
// explanatory columns and optional sort keys -- never multiplied into the score (review-1 HIGH 1).
//
// Prior art ((internal reference removed) log/prior-art.md):
//   - hotspot = frequency-of-change x complexity (Tornhill, "Your Code as a Crime Scene"; code-maat
//     https://github.com/adamtornhill/code-maat)
//   - complexity = indentation-based ("whitespace") complexity, not a per-language AST walk
//     (Tornhill, same book p.25; Hindle/Godfrey/Holt ICPC 2008 "indentation as a proxy for complexity")
//   - churn = commits-per-file (code-maat's `revisions` analysis), renames merged (git-log(1) `-M`)
//   - normalize each input before combining (Nagappan & Ball ICSE 2005: relative churn measures beat
//     absolute ones as predictors)
//   - decision volatility and incident/fix density reuse Mole's own data: @mole/decisions'
//     loadGraph() (decision scope + overrides edges) and @mole/history's DEFAULT_FIX_RULE, rather than
//     a second implementation of either (the project's shared instructions file: one source of truth) -- reported, never gating
//   - rank source code only by default; lockfiles/*.json/*.md/*.yaml/generated dirs/binaries excluded
//     (CodeScene "Exclude Files from an Analysis" practice, code-maat's own noise exclusions)
//   - read every blob once via `git cat-file --batch`, not one `git show` per file (review-1 MED 3)
import { git } from '@mole/history/dist/src/git.js';
import { DEFAULT_FIX_RULE } from '@mole/history';
import { loadGraph } from '@mole/decisions';
import { indentComplexity, indentComplexityFromText } from './complexity.js';
import { catFileBatch } from './batch-git.js';
import { isRankableFile, looksBinary } from './filters.js';
import { walkCommits } from './commits.js';

export { indentComplexity, indentComplexityFromText } from './complexity.js';
export type { IndentComplexity } from './complexity.js';
export { isRankableFile, looksBinary, extOf } from './filters.js';
export { walkCommits } from './commits.js';
export type { CommitFiles } from './commits.js';

export interface HotspotInputs {
  /** commits touching this file, renames merged under the current name (code-maat `revisions`;
   * Nagappan & Ball: churn, un-normalized) */
  churn: number;
  /** sum of per-line logical-indent depth over the file's current content (Tornhill) */
  complexity: number;
  /** decisions whose `scope` touches this file, plus `overrides` edges among them (revisions of the
   * team's stance on this code) -- read from @mole/decisions' loadGraph(), not @mole/temporal
   * (INFERENCE, see prior-art.md "Decisions taken": temporal's Postgres/RLS store is out of T70's
   * boundary; .mole/decisions/*.md is the lighter, already-read-only equivalent). Explanatory column
   * / `--by volatility` sort key only -- review-1 HIGH 1: never multiplied into `score`. */
  volatility: number;
  /** commits touching this file (renames merged) whose subject matches the fix rule (@mole/history's
   * DEFAULT_FIX_RULE, the same rule `mole check`/`mole_check` use for "this commit is a fix").
   * Explanatory column / `--by fixes` sort key only -- review-1 HIGH 1: never multiplied into `score`. */
  incidents: number;
}

export interface HotspotRank extends HotspotInputs {
  file: string;
  /** each raw input divided by the max of that input across every ranked file (0 when the file has
   * none; a file with the single largest raw value in some input scores 1 on that input) */
  normalized: { churn: number; complexity: number; volatility: number; incidents: number };
  /** the hotspot score: product of normalized churn x normalized complexity only (Tornhill/code-maat's
   * method, Nagappan & Ball: normalize before combining). review-1 HIGH 1: decision volatility and
   * incident/fix density are reported alongside but never multiplied in -- a file with zero decisions
   * or zero fixes is still ranked purely on how often and how complex its changes are; `score` is 0
   * only when churn or complexity itself is 0 for that file, never because of the other two columns. */
  score: number;
}

export type HotspotSortKey = 'hotspot' | 'volatility' | 'fixes';

export interface HotspotsOptions {
  /** max files to return, ranked by score desc (default 10, per T70's done-when) */
  top?: number;
  /** restrict churn/incident history to commits since this date (ISO or any `git log --since` value) */
  since?: string;
  /** override @mole/history's DEFAULT_FIX_RULE */
  fixRule?: RegExp | string;
  /** spaces counted as one logical indent (Tornhill's indent-complexity-proxy default is 4; Mole's
   * own source is 2-space indented, so 2 is this package's default -- configurable, not hardcoded) */
  spacesPerIndent?: number;
  /** sort key (review-1 HIGH 1): 'hotspot' (default, churn x complexity), 'volatility' (raw decision
   * volatility desc) or 'fixes' (raw incident count desc) -- the four raw/normalized inputs are
   * always returned on every rank regardless of sort key, only the order changes */
  by?: HotspotSortKey;
  /** review-1 HIGH 2: include non-source files (lockfiles, *.json/*.md/*.yaml, generated dirs,
   * binaries) that are excluded by default. Generated dirs, lockfiles and binary blobs stay excluded
   * even with `all: true` -- they are never source to pay down. Default false. */
  all?: boolean;
}

export interface HotspotsResult {
  ranked: HotspotRank[];
  /** every rankable file considered (tracked, not excluded, not binary, with >=1 commit), before
   * truncating to `top` */
  filesConsidered: number;
  fixRule: string;
  by: HotspotSortKey;
  all: boolean;
  ms: number;
}

function compileFixRule(rule: RegExp | string): RegExp {
  if (rule instanceof RegExp) return new RegExp(rule.source, rule.flags.replace(/[gy]/g, ''));
  return new RegExp(rule, 'i');
}

/** per file: commit count (churn) and fix-commit count (incidents), from one shared `walkCommits`
 * walk (T77: factored out so @mole/coupling's co-change counting reuses the exact same `git log
 * --name-status -M` parse + rename-alias resolution, not a second implementation). review-1 MED 3:
 * a file renamed partway through its history is counted once, under its current name. */
async function churnAndIncidents(root: string, since: string | undefined, fixRule: RegExp): Promise<Map<string, { churn: number; incidents: number }>> {
  const commits = await walkCommits(root, since);
  const out = new Map<string, { churn: number; incidents: number }>();
  for (const c of commits) {
    const isFix = fixRule.test(c.subject);
    for (const file of c.files) {
      const e = out.get(file) ?? { churn: 0, incidents: 0 };
      e.churn += 1;
      if (isFix) e.incidents += 1;
      out.set(file, e);
    }
  }
  return out;
}

/** decision volatility per file: decisions whose scope touches the file, plus `overrides` edges
 * between decisions that both touch it (each such edge is one recorded revision of the team's
 * stance on that code) */
function decisionVolatility(root: string): Map<string, number> {
  const graph = loadGraph(root);
  const decisionsByFile = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    if (n.kind !== 'decision') continue;
    for (const a of n.scope) {
      const file = a.target.split('#')[0]!.replace(/\/$/, '');
      (decisionsByFile.get(file) ?? decisionsByFile.set(file, new Set()).get(file)!).add(n.id);
    }
  }
  const out = new Map<string, number>();
  for (const [file, ids] of decisionsByFile) out.set(file, ids.size);
  for (const e of graph.edges) {
    if (e.type !== 'overrides') continue;
    for (const [file, ids] of decisionsByFile) {
      if (ids.has(e.from) && ids.has(e.to)) out.set(file, (out.get(file) ?? 0) + 1);
    }
  }
  return out;
}

/** every file git currently tracks (HEAD's tree) with its blob sha: what the batch cat-file read
 * needs, and what `isRankableFile`/`looksBinary` filter down to */
async function trackedFiles(root: string): Promise<Array<{ file: string; sha: string }>> {
  const raw = await git(root, ['ls-tree', '-r', 'HEAD']).catch(() => '');
  const out: Array<{ file: string; sha: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // "<mode> <type> <sha>\t<path>"
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(' ');
    const sha = meta[2];
    const type = meta[1];
    if (type !== 'blob' || !sha) continue;
    out.push({ file: line.slice(tab + 1), sha });
  }
  return out;
}

export async function computeHotspots(root: string, opts: HotspotsOptions = {}): Promise<HotspotsResult> {
  const t0 = performance.now();
  const fixRule = compileFixRule(opts.fixRule ?? DEFAULT_FIX_RULE);
  const spacesPerIndent = opts.spacesPerIndent ?? 2;
  const by = opts.by ?? 'hotspot';
  const all = opts.all ?? false;

  const [ci, volatility, tracked] = await Promise.all([churnAndIncidents(root, opts.since, fixRule), Promise.resolve(decisionVolatility(root)), trackedFiles(root)]);

  // review-1 HIGH 2: rank source code only by default (lockfiles/*.json/*.md/*.yaml/generated dirs
  // excluded unless `all`); review-1 MED 3: read every surviving blob in ONE `git cat-file --batch`
  // call instead of one `git show` per file.
  const rankable = tracked.filter((t) => ci.has(t.file) && isRankableFile(t.file, all));
  const blobs = await catFileBatch(root, rankable.map((t) => t.sha));

  const rows: Array<{ file: string } & HotspotInputs> = [];
  for (const { file, sha } of rankable) {
    const content = blobs.get(sha);
    if (!content || looksBinary(content)) continue; // review-1 HIGH 2: binary files never ranked
    const churnRow = ci.get(file)!;
    const complexity = indentComplexityFromText(content.toString('utf8'), spacesPerIndent);
    rows.push({ file, churn: churnRow.churn, complexity, volatility: volatility.get(file) ?? 0, incidents: churnRow.incidents });
  }

  const maxOf = (k: keyof HotspotInputs) => Math.max(1, ...rows.map((r) => r[k]));
  const maxChurn = maxOf('churn');
  const maxComplexity = maxOf('complexity');
  const maxVolatility = maxOf('volatility');
  const maxIncidents = maxOf('incidents');

  const scored: HotspotRank[] = rows.map((r) => {
    const normalized = { churn: r.churn / maxChurn, complexity: r.complexity / maxComplexity, volatility: r.volatility / maxVolatility, incidents: r.incidents / maxIncidents };
    // review-1 HIGH 1: score = churn x complexity ONLY (Tornhill/code-maat's hotspot method).
    // volatility and incidents are reported above but never multiplied in -- no any-zero->0 gate.
    const score = normalized.churn * normalized.complexity;
    return { ...r, normalized, score };
  });

  const sortKey: Record<HotspotSortKey, (r: HotspotRank) => number> = {
    hotspot: (r) => r.score,
    volatility: (r) => r.volatility,
    fixes: (r) => r.incidents,
  };
  const keyFn = sortKey[by];
  const ranked = scored.sort((a, b) => keyFn(b) - keyFn(a) || b.score - a.score || b.churn - a.churn || a.file.localeCompare(b.file));

  return { ranked: ranked.slice(0, opts.top ?? 10), filesConsidered: rows.length, fixRule: fixRule.source, by, all, ms: Math.round(performance.now() - t0) };
}

export function formatHotspots(r: HotspotsResult): string {
  if (r.ranked.length === 0) return `mole hotspots: no source file has any commit history (${r.filesConsidered} file(s) considered, --by ${r.by}${r.all ? ', --all' : ''})`;
  const out = [`mole hotspots (fix rule /${r.fixRule}/i, --by ${r.by}${r.all ? ' --all' : ''}, ${r.filesConsidered} file(s) considered)`];
  r.ranked.forEach((h, i) => {
    out.push(`${i + 1}. ${h.file}  score=${h.score.toFixed(3)}  (churn x complexity, normalized)`);
    out.push(`   churn=${h.churn} (${h.normalized.churn.toFixed(2)})  complexity=${h.complexity} (${h.normalized.complexity.toFixed(2)})  |  decision volatility=${h.volatility} (${h.normalized.volatility.toFixed(2)})  fix commits=${h.incidents} (${h.normalized.incidents.toFixed(2)})`);
  });
  return out.join('\n');
}
