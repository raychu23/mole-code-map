// @mole/coupling: `mole coupling [--top N] [--json]` (T77, D69) — logical coupling from git co-change
// (code-maat's `coupling` analysis: degree = shared commits / average revisions, code-maat's own
// defaults for min revisions / min shared commits / max changeset size), mapped onto CODEOWNERS teams
// (GitHub CODEOWNERS syntax, last matching pattern wins), cross-team pairs surfaced first (Cataldo &
// Herbsleb socio-technical congruence: a technical coupling crossing a team boundary is the pair most
// likely under-coordinated). See (internal reference removed) log/prior-art.md for every number's source.
//
// Reuse (the project's shared instructions file "one source of truth"), not a second implementation of any of these:
//   - @mole/hotspots' `walkCommits` (T70's `git log --name-status -M` + rename-alias resolution,
//     factored out for this task) and `isRankableFile` (T70's source-file filter).
//   - @mole/decisions' `parseCodeowners`/`codeownersAt` (CODEOWNERS parsing, already built for
//     `mole pr-check`) and `loadGraph` (decision scope anchors, already built for T70's decision
//     volatility column).
import { walkCommits, isRankableFile } from '@mole/hotspots';
import { codeownersAt, parseCodeowners, loadGraph } from '@mole/decisions';

export interface CouplingOptions {
  /** max pairs to return, cross-team pairs first then by degree desc (default 10) */
  top?: number;
  /** restrict the git log to commits since this date (any `git log --since` value) */
  since?: string;
  /** code-maat `-n/--min-revs`: a file needs at least this many (post-filter) revisions to be
   * considered at all. Default 5 (code-maat's own default). */
  minRevs?: number;
  /** code-maat `-m/--min-shared-revs`: a pair needs at least this many shared commits. Default 5. */
  minSharedRevs?: number;
  /** code-maat `-i/--min-coupling`: minimum degree (%) to keep a pair. Default 30. */
  minCoupling?: number;
  /** code-maat `-x/--max-coupling`: maximum degree (%) to keep a pair. Default 100. */
  maxCoupling?: number;
  /** code-maat `-s/--max-changeset-size`: a commit touching more than this many rankable files is
   * dropped from both the revision counts and the pairing (avoids one mass-reformat commit
   * manufacturing coupling between everything it touched). Default 30. */
  maxChangesetSize?: number;
  /** include non-source files (same escape hatch as `mole hotspots --all`); lockfiles and generated
   * dirs stay excluded even with this on. Default false. */
  all?: boolean;
  /** max sample commit shas carried as evidence per pair. Default 5. */
  sampleShas?: number;
}

export interface CouplingDecision {
  id: string;
  title: string;
  file: string;
}

export interface CouplingPair {
  fileA: string;
  fileB: string;
  /** commits that touched both (after the changeset-size filter); never 0 (STOP clause: a pair is
   * only ever returned with its own evidence) */
  sharedRevs: number;
  revsA: number;
  revsB: number;
  /** ceil(average(revsA, revsB)), code-maat's own rounding -- the emitted column, NOT what degree
   * is computed from (code-maat computes degree from the raw, un-ceiled average). */
  averageRevs: number;
  /** percent, 100 * sharedRevs / (raw, un-ceiled average(revsA, revsB)), truncated toward zero --
   * code-maat's own `(int coupling)` emitted value (logical_coupling.clj `as-logical-coupling-measure`).
   * e.g. revsA=17 revsB=24 shared=12 -> raw 58.54%, emitted/stored here as 58, not ceil-average's 57. */
  degree: number;
  /** the untruncated raw percentage `degree` was truncated from (kept for callers that want the
   * exact value; code-maat itself never emits this, only the truncated int above). */
  degreeExact: number;
  /** up to `sampleShas` commit shas that touched both files, newest first -- the pair's evidence */
  sampleShas: string[];
  ownersA: string[];
  ownersB: string[];
  /** both sides owned, and the owner sets are disjoint (Cataldo & Herbsleb: a technical coupling
   * crossing a team boundary). false when either side is unowned -- never claimed without evidence. */
  crossTeam: boolean;
  /** decisions whose scope covers both fileA and fileB */
  decisions: CouplingDecision[];
}

export interface CouplingResult {
  pairs: CouplingPair[];
  /** commits read from `git log`, before the changeset-size filter */
  commitsConsidered: number;
  /** distinct rankable files touched by any commit that passed the changeset-size filter (min-revs is a pair
   * filter on the pair's average revisions, as in code-maat, so it no longer narrows this count) */
  filesConsidered: number;
  codeownersPath: string | null;
  minRevs: number;
  minSharedRevs: number;
  minCoupling: number;
  maxCoupling: number;
  maxChangesetSize: number;
  all: boolean;
  ms: number;
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** does a decision's scope anchor (file, `folder/`, or `file#Symbol`) cover `file`? Mirrors
 * @mole/decisions' check/pr-check.ts `parseAnchor`/`under` split (file / folder / symbol), not
 * exported from that module, so reimplemented minimally here rather than importing an unexported
 * internal (T77 prior-art.md source 4). */
function anchorCoversFile(target: string, file: string): boolean {
  const t = target.trim().replace(/^\.\//, '');
  const path = t.includes('#') ? t.slice(0, t.indexOf('#')) : t;
  if (path.endsWith('/')) {
    const folder = path.replace(/\/+$/, '');
    return folder === '' || file === folder || file.startsWith(`${folder}/`);
  }
  return file === path;
}

/** decisions whose scope covers BOTH files (not just either) */
function decisionsCoveringPair(graph: ReturnType<typeof loadGraph>, fileA: string, fileB: string): CouplingDecision[] {
  const out: CouplingDecision[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'decision') continue;
    const coversA = n.scope.some((a) => anchorCoversFile(a.target, fileA));
    const coversB = n.scope.some((a) => anchorCoversFile(a.target, fileB));
    if (coversA && coversB) out.push({ id: n.id, title: n.title, file: n.file });
  }
  return out;
}

export async function computeCoupling(root: string, opts: CouplingOptions = {}): Promise<CouplingResult> {
  const t0 = performance.now();
  const minRevs = opts.minRevs ?? 5;
  const minSharedRevs = opts.minSharedRevs ?? 5;
  const minCoupling = opts.minCoupling ?? 30;
  const maxCoupling = opts.maxCoupling ?? 100;
  const maxChangesetSize = opts.maxChangesetSize ?? 30;
  const all = opts.all ?? false;
  const sampleCap = opts.sampleShas ?? 5;

  const commits = await walkCommits(root, opts.since);

  // code-maat's `good_commits`: a commit whose (rankable) changeset size exceeds the cap is dropped
  // from BOTH the per-file revision counts and the pairwise shared-commit counts, not only pairing.
  const good = commits
    .map((c) => ({ ...c, files: c.files.filter((f) => isRankableFile(f, all)) }))
    .filter((c) => c.files.length >= 1 && c.files.length <= maxChangesetSize);

  const revs = new Map<string, number>();
  for (const c of good) for (const f of c.files) revs.set(f, (revs.get(f) ?? 0) + 1);

  // code-maat's `module-by-revs`/`coupling-frequencies` pair EVERY co-changing file in a (good)
  // commit, with no per-file min-revs pre-filter -- `min-revs` is checked only after pairing,
  // against the PAIR's own average-revs (`within-threshold?`'s `revs` arg is `average-revs`, not a
  // per-file count). Filtering files out before pairing (the old `eligible` set) silently dropped
  // pairs code-maat would keep, e.g. revsA=6/revsB=20/shared=6 at --min-revs 10: average-revs=13 >=
  // 10 passes code-maat's filter even though file A alone has only 6 revisions.
  const shared = new Map<string, { count: number; shas: string[] }>();
  for (const c of good) {
    const files = [...new Set(c.files)];
    if (files.length < 2) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const [a, b] = pairKey(files[i]!, files[j]!);
        const key = `${a}\u0000${b}`;
        const e = shared.get(key) ?? { count: 0, shas: [] };
        e.count += 1;
        if (e.shas.length < sampleCap) e.shas.push(c.sha);
        shared.set(key, e);
      }
    }
  }

  const co = codeownersAt(root, 'HEAD');
  const owners = co ? parseCodeowners(co.text) : null;
  const graph = loadGraph(root);

  const pairs: CouplingPair[] = [];
  for (const [key, e] of shared) {
    if (e.count < minSharedRevs) continue;
    const [fileA, fileB] = key.split('\u0000') as [string, string];
    const revsA = revs.get(fileA)!;
    const revsB = revs.get(fileB)!;
    // code-maat's `average-revs` inside `as-logical-coupling-measure` is the RAW average -- the
    // `-min-revs` threshold and the degree calculation both use this raw value; `(math/ceil
    // average-revs)` happens only when assembling the emitted `:average-revs` column (below).
    const averageRevsRaw = (revsA + revsB) / 2;
    if (averageRevsRaw < minRevs) continue;
    const averageRevs = Math.ceil(averageRevsRaw);
    const degreeExact = (100 * e.count) / averageRevsRaw;
    // code-maat's `within-threshold?`: `(>= coupling min-coupling)` against the RAW percentage, but
    // `(<= (math/floor coupling) max-coupling)` -- floored, not raw -- against max-coupling.
    if (degreeExact < minCoupling || Math.floor(degreeExact) > maxCoupling) continue;
    const degree = Math.trunc(degreeExact); // code-maat's own emitted `(int coupling)`
    const ownersA = owners ? owners.ownersOf(fileA) : [];
    const ownersB = owners ? owners.ownersOf(fileB) : [];
    const crossTeam = ownersA.length > 0 && ownersB.length > 0 && !ownersA.some((o) => ownersB.includes(o));
    pairs.push({
      fileA,
      fileB,
      sharedRevs: e.count,
      revsA,
      revsB,
      averageRevs,
      degree,
      degreeExact,
      sampleShas: e.shas,
      ownersA,
      ownersB,
      crossTeam,
      decisions: decisionsCoveringPair(graph, fileA, fileB),
    });
  }

  // Cross-team pairs first (Cataldo & Herbsleb: a technical coupling crossing a team boundary is the
  // one most likely under-coordinated), each group by degree desc (exact, pre-truncation, for a
  // finer-grained order than the truncated int column gives), ties by shared commits desc then path
  // for a deterministic order.
  pairs.sort((a, b) => Number(b.crossTeam) - Number(a.crossTeam) || b.degreeExact - a.degreeExact || b.sharedRevs - a.sharedRevs || a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB));

  return {
    pairs: pairs.slice(0, opts.top ?? 10),
    commitsConsidered: commits.length,
    filesConsidered: revs.size,
    codeownersPath: co?.path ?? null,
    minRevs,
    minSharedRevs,
    minCoupling,
    maxCoupling,
    maxChangesetSize,
    all,
    ms: Math.round(performance.now() - t0),
  };
}

export function formatCoupling(r: CouplingResult): string {
  if (r.pairs.length === 0) return `mole coupling: no pair meets min-shared-revs=${r.minSharedRevs}/min-coupling=${r.minCoupling}% (${r.filesConsidered} file(s) considered, ${r.commitsConsidered} commit(s) read)${r.codeownersPath ? '' : ' -- no CODEOWNERS file found'}`;
  const out = [`mole coupling (min-revs=${r.minRevs} min-shared-revs=${r.minSharedRevs} min-coupling=${r.minCoupling}% max-coupling=${r.maxCoupling}% max-changeset-size=${r.maxChangesetSize}, ${r.filesConsidered} file(s) considered)${r.codeownersPath ? ` -- CODEOWNERS: ${r.codeownersPath}` : ' -- no CODEOWNERS file found'}`];
  r.pairs.forEach((p, i) => {
    out.push(`${i + 1}. ${p.fileA} <-> ${p.fileB}  degree=${p.degree}%  shared=${p.sharedRevs} (avg-revs=${p.averageRevs})${p.crossTeam ? '  [cross-team]' : ''}`);
    out.push(`   owners: ${p.ownersA.join(',') || '(none)'} / ${p.ownersB.join(',') || '(none)'}  sample shas: ${p.sampleShas.map((s) => s.slice(0, 7)).join(', ')}`);
    if (p.decisions.length) out.push(`   decisions: ${p.decisions.map((d) => `${d.id} ${d.title}`).join('; ')}`);
  });
  return out.join('\n');
}
