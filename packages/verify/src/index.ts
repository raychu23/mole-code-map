// @mole/verify (T22): at hand-back, run only the tests that matter for a change, and report pass/fail beside the
// past-fix lines. Selection is deterministic (the model never decides):
//   1) fix lineage: the guarding tests of every past fix whose lines the change edits (@mole/history check, T12)
//   2) call graph: the nearest tests that reach each edited function (reverse `calls` edges of @mole/indexer's
//      TypeScript Compiler API graph, test files included), mapped from the call line to its it()/test() block
// Then runs exactly those test cases with the repo's runner (vitest, by file:line) and reads its JSON report.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { check, type Change, type CheckResult } from '@mole/history';
import { callersOf, declarations, enclosing, hasNode, importersOf, openGraph, RUNNER_TEST, SOURCE, usersInFile, type Decl } from './graph.js';
import { helperUsers, testMap, testsAtLine, type TestMap } from './testmap.js';

export type { Change } from '@mole/history';
export { testMap, testsAtLine, type TestCase, type TestMap } from './testmap.js';

export interface SelectOptions {
  /** which commits count as fixes (passed to @mole/history check) */
  fixRule?: string;
  /** SQLite file for the call graph; reused while its recorded commit equals HEAD, else rebuilt. Default: in memory */
  graphDb?: string;
  /** max reverse call-graph depth searched for tests (default 8) */
  maxDepth?: number;
}

export interface EditedSymbol {
  /** @mole/indexer node id, e.g. function:src/math.ts#add */
  id: string;
  file: string;
  name: string;
  line: number;
}

export type Via = 'fix' | 'graph' | 'edited';

export interface SelectedTest {
  file: string;
  /** full name as the runner reports it: describe titles + test title joined by ' > ' */
  name: string;
  /** describe titles + test title, unjoined; the runner's name filter is built from these (a title may contain ' > ') */
  titles?: string[];
  /** 1-based line of the test call (the runner's location filter) */
  line: number;
  via: Via[];
  /** call-graph distance from an edited symbol (graph only) */
  depth?: number;
  /** short sha of the past fix this test guards (fix only) */
  fix?: string;
  /** edited symbol ids this test reaches (graph) */
  targets?: string[];
  /** the test file skips this test on purpose (it.skip / it.todo / describe.skip / skipIf / runIf / ctx.skip()) */
  skip?: 'skip' | 'todo' | 'if';
  /** indexes of non-literal titles: the file runs without a name filter (review-2 P2-A) */
  wild?: number[];
  reason: string;
}

export interface Selection {
  root: string;
  check: CheckResult;
  edited: EditedSymbol[];
  tests: SelectedTest[];
  /** test cases the call graph reaches at any depth <= maxDepth (diagnostic; the selection takes the nearest) */
  reachable: number;
  noTestReaches: boolean;
  /** the change edits no code file (docs, config, clean worktree) and selects no test (review-2 P2-B) */
  noCodeChange?: boolean;
  /** when no test reaches the change: the nearest guarding test to look at */
  nearest?: { file: string; name?: string; line?: number; why: string };
  /** guarding test files of past fixes that name no test the selection could run */
  unrunGuards: Array<{ file: string; fix: string }>;
  graph: { built: boolean; ms: number };
  ms: number;
}

export interface TestOutcome {
  file: string;
  name: string;
  /** ancestor titles + title as the runner reports them */
  titles?: string[];
  line: number | null;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
}

export interface RunResult {
  runner: 'vitest';
  command: string[];
  outcomes: TestOutcome[];
  passed: number;
  failed: number;
  /** selected tests the runner reported no pass/fail for: an error (exit 1), never a silent skip */
  notRun: SelectedTest[];
  /** selected tests the test file skips on purpose and the runner reported skipped/todo: shown, not an error (review-2 P1-A) */
  skippedByFile: SelectedTest[];
  ms: number;
  error?: string;
}

export const NO_TEST_REACHES = 'no test reaches this change';
export const DEFAULT_MAX_DEPTH = 8;

/** model (LLM) calls made by this package: none; the model never decides which tests run */
export const modelCalls = { count: 0 };

function gitText(root: string, args: string[]): string | undefined {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : undefined;
}

/** the edited (new-side) text of a file: the commit's version in sha mode, else the file on disk */
function newText(root: string, change: Change, file: string): string | undefined {
  if ('sha' in change) return gitText(root, ['show', `${change.sha}:${file}`]);
  const p = join(root, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

class Maps {
  private cache = new Map<string, TestMap | undefined>();
  constructor(private root: string) {}
  get(file: string): TestMap | undefined {
    if (!this.cache.has(file)) {
      const p = join(this.root, file);
      this.cache.set(file, existsSync(p) ? testMap(file, readFileSync(p, 'utf8')) : undefined);
    }
    return this.cache.get(file);
  }
}

export async function selectTests(rootIn: string, change: Change, opts: SelectOptions = {}): Promise<Selection> {
  const t0 = performance.now();
  const root = (gitText(resolve(rootIn), ['rev-parse', '--show-toplevel']) ?? resolve(rootIn)).trim();
  const facts = await check(root, change, opts.fixRule ? { fixRule: opts.fixRule } : {});
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maps = new Maps(root);
  const picked = new Map<string, SelectedTest>();
  const add = (file: string, t: { name: string; titles?: string[]; line: number; skip?: SelectedTest['skip']; wild?: number[] }, via: Via, extra: Partial<SelectedTest> & { reason: string }): void => {
    const k = `${file}\0${t.line}\0${t.name}`;
    const cur = picked.get(k);
    if (!cur) {
      picked.set(k, {
        file, name: t.name, titles: t.titles ? [...t.titles] : undefined, line: t.line, via: [via], ...extra, targets: extra.targets ? [...extra.targets] : undefined,
        ...(t.skip ? { skip: t.skip } : {}), ...(t.wild?.length ? { wild: [...t.wild] } : {}),
      });
      return;
    }
    if (!cur.via.includes(via)) cur.via.push(via);
    if (extra.fix && !cur.fix) cur.fix = extra.fix;
    if (extra.depth !== undefined && (cur.depth === undefined || extra.depth < cur.depth)) cur.depth = extra.depth;
    for (const tg of extra.targets ?? []) if (!(cur.targets ??= []).includes(tg)) cur.targets.push(tg);
    if (via === 'fix') cur.reason = `${extra.reason}; ${cur.reason}`;
  };

  // edited symbols (new side), and edited test cases when a test file itself changed
  const edited: EditedSymbol[] = [];
  const seeds = new Map<string, { decl: Decl; file: string }>();
  const fileSeeds = new Set<string>();
  const textCache = new Map<string, string | undefined>();
  for (const h of facts.hunks) {
    if (!SOURCE.test(h.file) && !/\.[cm]?jsx?$/.test(h.file)) continue;
    if (!textCache.has(h.file)) textCache.set(h.file, newText(root, change, h.file));
    const text = textCache.get(h.file);
    if (text === undefined) continue; // deleted file
    const lines = h.newLines > 0 ? Array.from({ length: h.newLines }, (_, i) => h.newStart + i) : [h.newStart, h.newStart + 1];
    if (RUNNER_TEST.test(h.file)) {
      const m = testMap(h.file, text);
      for (const l of lines) {
        const own = m.tests.filter((x) => x.start <= l && l <= x.end);
        for (const t of own) add(h.file, t, 'edited', { reason: 'the change edits this test' });
        if (own.length) continue;
        // review-2 P2-D: an edit outside any test. In a helper function of the file: the file's tests that use it; else
        // (hook, describe body, imports) the tests of the innermost describe holding the line, or the whole file
        const { helpers, tests: users } = helperUsers(h.file, text, m, l);
        if (users.length) for (const t of users) add(h.file, t, 'edited', { reason: `uses ${helpers.join(', ')}, edited in this test file` });
        else for (const t of testsAtLine(m, l)) add(h.file, t, 'edited', { reason: 'the change edits this test file outside any test' });
      }
      continue;
    }
    const decls = declarations(h.file, text);
    const inner = enclosing(decls, lines);
    if (!inner.length) fileSeeds.add(h.file);
    for (const d of inner) {
      if (!edited.some((e) => e.id === d.id)) edited.push({ id: d.id, file: h.file, name: d.name, line: d.line });
      if (d.kind === 'function' || d.kind === 'method' || d.kind === 'class') seeds.set(d.id, { decl: d, file: h.file });
      else {
        // a constant or type: the functions in its file that use it stand in for it
        const users = usersInFile(decls, text, d.name.slice(d.name.lastIndexOf('::') + 1), d.id);
        if (users.length) for (const u of users) seeds.set(u.id, { decl: u, file: h.file });
        else fileSeeds.add(h.file);
      }
    }
  }

  // 1) fix lineage: guarding tests of the past fixes on the edited lines
  const unrunGuards: Array<{ file: string; fix: string }> = [];
  for (const h of facts.hunks) {
    for (const f of h.pastFixes) {
      for (const g of f.tests) {
        if (!RUNNER_TEST.test(g.file)) continue;
        const m = maps.get(g.file);
        if (!m) continue;
        const names = g.names ?? [];
        let hit = m.tests.filter((t) => names.includes(t.title));
        if (!hit.length) {
          const suites = m.suites.map((s, i) => ({ s, i })).filter(({ s }) => names.some((n) => s.name === n || s.name.endsWith(` > ${n}`)));
          hit = m.tests.filter((t) => suites.some(({ i }) => t.suites.includes(i)));
        }
        if (!hit.length && g.via === 'symbol') {
          // T12 found this file by the edited symbol's name: the tests whose body mentions an edited symbol
          const text = readFileSync(join(root, g.file), 'utf8').split('\n');
          const words = edited.map((e) => e.name.slice(e.name.lastIndexOf('.') + 1)).filter((w) => w.length > 2);
          hit = m.tests.filter((t) => words.some((w) => new RegExp(`\\b${w.replace(/[$]/g, '\\$')}\\b`).test(text.slice(t.start - 1, t.end).join('\n'))));
        }
        if (!hit.length) {
          if (!unrunGuards.some((u) => u.file === g.file && u.fix === f.shortSha)) unrunGuards.push({ file: g.file, fix: f.shortSha });
          continue;
        }
        for (const t of hit) add(g.file, t, 'fix', { fix: f.shortSha, reason: `guards past fix ${f.shortSha} (${g.via === 'symbol' ? 'references the edited symbol' : 'added or edited by the fix'})` });
      }
    }
  }

  // 2) call graph: per edited symbol, the nearest test cases that reach it (reverse calls edges)
  const graph = seeds.size || fileSeeds.size ? openGraph(root, opts.graphDb) : undefined;
  let reachable = 0;
  let importNearest: Selection['nearest'];
  if (graph) {
    const reachAll = new Set<string>();
    // per edited symbol, per BRANCH (each direct caller, and the tests calling it directly): the nearest tests of that
    // branch. A regression shows through some caller's behaviour; each caller's own nearest tests check that use of it.
    const hitsFor = (startIds: string[], target: string): void => {
      const depth = new Map<string, number>(startIds.map((i) => [i, 0]));
      const branchOf = new Map<string, string>();
      let frontier = startIds;
      const found: Array<{ file: string; line: number; d: number; branch: string }> = [];
      for (let d = 1; d <= maxDepth && frontier.length; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const c of callersOf(graph.db, id)) {
            const inTest = RUNNER_TEST.test(c.path);
            const branch = d === 1 ? (c.from.startsWith('file:') ? 'direct' : c.from) : branchOf.get(id)!;
            // a call from test code outside any top-level helper: the call line names the test(s)
            if (inTest && c.from.startsWith('file:')) found.push({ file: c.path, line: c.line, d, branch });
            if (!c.from.startsWith('file:') && !depth.has(c.from)) {
              depth.set(c.from, d);
              branchOf.set(c.from, branch);
              next.push(c.from);
            }
          }
        }
        frontier = next;
      }
      const tests = found.flatMap((f) => {
        const m = maps.get(f.file);
        return m ? testsAtLine(m, f.line).map((t) => ({ file: f.file, t, d: f.d, branch: f.branch })) : [];
      });
      for (const x of tests) reachAll.add(`${x.file}\0${x.t.line}\0${x.t.name}`);
      const nearest = new Map<string, number>();
      for (const x of tests) nearest.set(x.branch, Math.min(nearest.get(x.branch) ?? Infinity, x.d));
      for (const x of tests.filter((y) => y.d === nearest.get(y.branch))) {
        const via = x.branch === 'direct' ? '' : ` via ${x.branch.slice(x.branch.indexOf('#') + 1)}`;
        add(x.file, x.t, 'graph', { depth: x.d, targets: [target], reason: `calls ${target.slice(target.indexOf('#') + 1)}${via} (depth ${x.d})` });
      }
    };
    for (const [id] of seeds) if (hasNode(graph.db, id)) hitsFor([id], id);
    for (const file of fileSeeds) {
      // an edit outside any function: the nearest test files that import the file (module-level code runs on import)
      const seen = new Set<string>([file]);
      let frontier = [file];
      for (let d = 1; d <= maxDepth && frontier.length; d++) {
        const next: string[] = [];
        const testFiles: string[] = [];
        for (const f of frontier) {
          for (const imp of importersOf(graph.db, f)) {
            if (seen.has(imp.path)) continue;
            seen.add(imp.path);
            if (RUNNER_TEST.test(imp.path)) testFiles.push(imp.path);
            else next.push(imp.path);
          }
        }
        if (testFiles.length) {
          for (const tf of testFiles) for (const t of maps.get(tf)?.tests ?? []) add(tf, t, 'graph', { depth: d, targets: [`file:${file}`], reason: `imports ${file} (depth ${d})` });
          break;
        }
        frontier = next;
      }
    }
    reachable = reachAll.size;
    if (!picked.size) {
      // nothing calls the edit: the nearest guarding test is a test file that imports the edited file (fewest import hops)
      const start = [...new Set(facts.hunks.map((h) => h.file).filter((f) => SOURCE.test(f) && !RUNNER_TEST.test(f)))];
      const origin = new Map<string, string>(start.map((f) => [f, f]));
      let frontier = start;
      for (let d = 1; d <= maxDepth && frontier.length && !importNearest; d++) {
        const next: string[] = [];
        const hits: Array<{ test: string; of: string }> = [];
        for (const f of frontier) {
          for (const imp of importersOf(graph.db, f)) {
            if (origin.has(imp.path)) continue;
            origin.set(imp.path, origin.get(f)!);
            if (RUNNER_TEST.test(imp.path)) hits.push({ test: imp.path, of: origin.get(f)! });
            else next.push(imp.path);
          }
        }
        hits.sort((a, b) => a.test.localeCompare(b.test));
        if (hits[0]) importNearest = { file: hits[0].test, why: `imports ${hits[0].of}${d > 1 ? ` (${d} import hops)` : ''}, but no test calls the edited code` };
        frontier = next;
      }
    }
    graph.close();
  }

  const noCode = !facts.hunks.some((h) => SOURCE.test(h.file) || /\.[cm]?jsx?$/.test(h.file));
  const tests = [...picked.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const sel: Selection = {
    root,
    check: facts,
    edited,
    tests,
    reachable: Math.max(reachable, tests.length),
    noTestReaches: tests.length === 0 && !noCode,
    ...(tests.length === 0 && noCode ? { noCodeChange: true } : {}),
    unrunGuards,
    graph: { built: graph !== undefined, ms: 0 },
    ms: 0,
  };
  if (sel.noTestReaches) sel.nearest = nearestTest(root, facts, edited, unrunGuards, importNearest);
  sel.ms = performance.now() - t0;
  return sel;
}

/** the nearest guarding test when nothing reaches the change: a past fix's test file, else a test file importing an edited
 *  file (closest by import, review-1 P2-3), else a test naming an edited symbol, else the longest shared path prefix */
function nearestTest(root: string, facts: CheckResult, edited: EditedSymbol[], unrun: Array<{ file: string; fix: string }>, byImport?: Selection['nearest']): Selection['nearest'] {
  if (unrun[0]) return { file: unrun[0].file, why: `guarding test of past fix ${unrun[0].fix}` };
  if (byImport) return byImport;
  const all = (gitText(root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter((f) => RUNNER_TEST.test(f));
  if (!all.length) return undefined;
  for (const e of edited) {
    const w = e.name.slice(e.name.lastIndexOf('.') + 1);
    const hit = (gitText(root, ['grep', '-l', '-w', '-F', '-e', w, '--', ...all]) ?? '').split('\n').filter(Boolean)[0];
    if (hit) return { file: hit, why: `mentions ${w} but does not call it (no static call path)` };
  }
  const files = facts.hunks.map((h) => h.file);
  const common = (a: string, b: string): number => {
    const x = a.split('/');
    const y = b.split('/');
    let i = 0;
    while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++;
    return i;
  };
  const scored = all.map((t) => ({ t, s: Math.max(0, ...files.map((f) => common(f, t))) })).sort((a, b) => b.s - a.s || a.t.localeCompare(b.t));
  return { file: scored[0]!.t, why: scored[0]!.s > 0 ? 'closest test file by path' : 'first test file in the repo (none shares a folder with the change)' };
}

/** vitest's CLI entry for this repo: its own install first, then any install up the tree, then Mole's */
function vitestEntry(root: string): string | undefined {
  for (let d = root; ; d = dirname(d)) {
    const p = join(d, 'node_modules/vitest/vitest.mjs');
    if (existsSync(p)) return p;
    if (dirname(d) === d) break;
  }
  try {
    return join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  } catch {
    return undefined;
  }
}

const CONFIG_NAMES = ['vitest.config', 'vite.config', 'vitest.workspace'].flatMap((n) => ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((e) => `${n}.${e}`));

/** the repo's own vitest/vite config; without one, a minimal config so vitest does not pick up a parent folder's */
function vitestConfig(root: string): string {
  for (const n of CONFIG_NAMES) if (existsSync(join(root, n)) && !n.startsWith('vitest.workspace')) return join(root, n);
  const dir = join(root, '.mole/local/verify');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'vitest.config.mjs');
  writeFileSync(file, `export default { test: { root: ${JSON.stringify(root)}, include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'], exclude: ['**/node_modules/**', '**/dist/**', '**/.*/**'] } };\n`);
  return file;
}

/** regex source for one title: literal text; it.each placeholders (%s %d %i %f %j %o %O %p %#, $field, template ${...})
 *  match anything */
function titlePattern(part: string): string {
  return part
    .split(/(%[sdifjoOp#%]|\$\{[^}]*\}|\$[A-Za-z_][\w.]*)/)
    .map((seg, i) => (i % 2 === 1 ? (seg === '%%' ? '%' : '.*') : seg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
    .join('');
}

/** regex source for a test's full name as vitest matches it (titles joined by a space). Pass the title array: a full-name
 *  string is split on ' > ', which breaks a title that itself contains ' > ' (review-1 P1-1); strings stay for old callers */
export function namePattern(name: string | string[]): string {
  return (Array.isArray(name) ? name : name.split(' > ')).map(titlePattern).join(' ');
}

const titlesOf = (t: { name: string; titles?: string[] }): string[] => t.titles ?? t.name.split(' > ');

/** does a runner outcome belong to this selected test (same file, same titles or an it.each row of them) */
export function sameTest(t: { file: string; name: string; titles?: string[]; wild?: number[] }, o: { file: string; name: string; titles?: string[] }): boolean {
  if (t.file !== o.file) return false;
  if (t.titles && o.titles) {
    if (t.titles.length !== o.titles.length) return false;
    // a non-literal title (review-2 P2-A) matches any runner title at its position
    return t.titles.every((x, i) => t.wild?.includes(i) || x === o.titles![i] || new RegExp(`^${titlePattern(x)}$`).test(o.titles![i]!));
  }
  if (t.name === o.name) return true;
  return new RegExp(`^${namePattern(titlesOf(t))}$`).test(titlesOf(o).join(' '));
}

interface VitestJson {
  testResults: Array<{ name: string; message?: string; status?: string; assertionResults: Array<{ ancestorTitles: string[]; title: string; status: string; location?: { line: number }; failureMessages?: string[] }> }>;
}

export async function runTests(root: string, sel: Selection, opts: { vitest?: string } = {}): Promise<RunResult> {
  const t0 = performance.now();
  const entry = opts.vitest ?? vitestEntry(root);
  // by name, not by `file:line`: vitest places it.each/test.each rows on another line than the call, and one location it
  // cannot match fails the whole file. The pattern is anchored at the end and only loose before the outermost title.
  // review-2 P2-A: a file holding a selected test with a non-literal title runs whole (no name filter can match the title)
  const whole = [...new Set(sel.tests.filter((t) => t.wild?.length).map((t) => t.file))];
  const targets = [...new Set(sel.tests.map((t) => t.file))].filter((f) => !whole.includes(f));
  const pattern = `(?:^|\\s)(?:${[...new Set(sel.tests.filter((t) => targets.includes(t.file)).map((t) => namePattern(titlesOf(t))))].join('|')})$`;
  const out = mkdtempSync(join(tmpdir(), 'mole-verify-'));
  const base = (report: string): string[] => ['--root', root, '--config', vitestConfig(root), '--reporter=json', `--outputFile=${report}`];
  const runs: Array<{ report: string; command: string[] }> = [];
  if (targets.length) runs.push({ report: join(out, 'filtered.json'), command: [] });
  if (whole.length) runs.push({ report: join(out, 'whole.json'), command: [] });
  for (const r of runs) {
    const files = r.report.endsWith('whole.json') ? whole : targets;
    r.command = [process.execPath, entry ?? 'vitest', 'run', ...files, ...(files === targets ? ['--testNamePattern', pattern] : []), ...base(r.report)];
  }
  const command = runs.length === 1 ? runs[0]!.command : runs.flatMap((r, i) => (i ? ['&&', ...r.command] : r.command));
  const result: RunResult = { runner: 'vitest', command, outcomes: [], passed: 0, failed: 0, notRun: [], skippedByFile: [], ms: 0 };
  try {
    if (!entry) throw new Error('vitest not found (node_modules/vitest)');
    if (!runs.length) return result;
    for (const { report, command: cmd } of runs) {
      const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, CI: '1' } });
      if (!existsSync(report)) throw new Error(`vitest wrote no report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-800)}`);
      const j = JSON.parse(readFileSync(report, 'utf8')) as VitestJson;
      for (const f of j.testResults) {
        const file = relative(root, f.name).split('\\').join('/');
        for (const a of f.assertionResults) {
          const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
          result.outcomes.push({ file, name: [...a.ancestorTitles, a.title].join(' > '), titles: [...a.ancestorTitles, a.title], line: a.location?.line ?? null, status, message: a.failureMessages?.[0]?.split('\n')[0] });
        }
        if (f.assertionResults.length === 0 && f.status === 'failed') result.outcomes.push({ file, name: '(file failed to load)', line: null, status: 'failed', message: f.message?.split('\n')[0] });
      }
    }
    result.passed = result.outcomes.filter((o) => o.status === 'passed').length;
    result.failed = result.outcomes.filter((o) => o.status === 'failed').length;
    // a selected test with no pass/fail outcome did not run. If the test file skips it on purpose (it.skip, it.todo,
    // describe.skip, skipIf/runIf, ctx.skip()) and the runner reported it skipped/todo, that is the file's choice: shown,
    // not an error (review-2 P1-A). Anything else (name filter missed it, file failed to collect, no such test) is an error
    for (const t of sel.tests) {
      const os = result.outcomes.filter((o) => sameTest(t, o));
      if (os.some((o) => o.status !== 'skipped')) continue;
      // .skip/.todo (own or a describe's) never runs, even when the runner names it under other titles (a describe built
      // by a helper called from another describe); a run-time condition (skipIf/runIf/ctx.skip) needs the runner's skip
      if ((t.skip === 'skip' || t.skip === 'todo') || (t.skip && os.length)) result.skippedByFile.push(t);
      else result.notRun.push(t);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    rmSync(out, { recursive: true, force: true });
    result.ms = performance.now() - t0;
  }
  return result;
}

const MARK: Record<string, string> = { passed: '✓ pass', failed: '✗ FAIL', skipped: '- skip' };
export const NO_CODE_CHANGE = 'no code change to test';
export const SKIPPED_BY_FILE = '- skipped by the test file';

export function formatVerify(sel: Selection, run?: RunResult): string {
  const status = (t: SelectedTest): string => {
    if (!run) return '·';
    const os = run.outcomes.filter((x) => sameTest(t, x));
    const n = os.length > 1 ? ` ×${os.length}` : '';
    if (os.some((x) => x.status === 'failed')) return MARK.failed! + n;
    if (os.some((x) => x.status === 'passed')) return MARK.passed! + n;
    if (run.skippedByFile.includes(t)) return `${SKIPPED_BY_FILE} (${t.skip === 'todo' ? 'todo' : t.skip === 'if' ? 'skipIf/runIf' : '.skip'})`;
    return '✗ NOT RUN'; // selected but the runner gave no pass/fail: an error, counted in the header and the exit code
  };
  const line = (t: SelectedTest): string => `${status(t)}  ${t.file}:${t.line}  ${t.name}  [${t.reason}]`;
  const out: string[] = [];
  if (sel.noCodeChange) {
    const files = [...new Set(sel.check.hunks.map((h) => h.file))];
    out.push(`mole check --run-tests: ${NO_CODE_CHANGE} (${files.length ? `changed: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}; none is code` : 'no changed file'})`);
    return out.join('\n');
  }
  if (sel.noTestReaches) {
    out.push(`mole check --run-tests: ${NO_TEST_REACHES} (no guarding test of a past fix, no test calls the edited code within ${DEFAULT_MAX_DEPTH} calls)`);
    if (sel.edited.length) out.push(`edited: ${sel.edited.map((e) => `${e.file}#${e.name}:${e.line}`).join(', ')}`);
    out.push(sel.nearest ? `nearest guarding test: ${sel.nearest.file}${sel.nearest.name ? ` > ${sel.nearest.name}` : ''} (${sel.nearest.why})` : 'nearest guarding test: none (the repo has no test files)');
    return out.join('\n');
  }
  const head = run
    ? `${run.error ? `runner error: ${run.error}` : `vitest: ${run.failed} failed, ${run.passed} passed${run.skippedByFile.length ? `, ${run.skippedByFile.length} skipped by the test file` : ''}${run.notRun.length ? `, ${run.notRun.length} selected not run (error)` : ''}`} (${(run.ms / 1000).toFixed(1)} s)`
    : 'not run';
  out.push(`mole check --run-tests: ${sel.tests.length} test${sel.tests.length === 1 ? '' : 's'} selected (past-fix lineage + call graph; ${sel.reachable} reachable) · ${head}`);
  const shown = new Set<SelectedTest>();
  for (const h of sel.check.hunks) {
    const range = h.newLines > 1 ? `${h.newStart}-${h.newStart + h.newLines - 1}` : `${h.newStart}`;
    const syms = sel.edited.filter((e) => e.file === h.file);
    const mine = sel.tests.filter((t) => !shown.has(t) && ((t.via.includes('graph') && t.targets?.some((id) => syms.some((s) => s.id === id || id === `file:${h.file}`))) || (t.via.includes('edited') && t.file === h.file)));
    const fixTests = h.pastFixes.map((f) => ({ f, tests: sel.tests.filter((t) => t.via.includes('fix') && t.fix === f.shortSha) }));
    if (!mine.length && !fixTests.some((x) => x.tests.length) && !h.pastFixes.length) continue;
    out.push(`${h.file}:${range}${syms.length ? `  (${syms.map((s) => s.name).join(', ')})` : ''}`);
    for (const { f, tests } of fixTests) {
      out.push(`  past fix ${f.shortSha} ${f.subject} (lines ${f.lines.length > 1 ? `${f.lines[0]}-${f.lines.at(-1)}` : f.lines[0]})`);
      for (const t of tests) {
        out.push(`    ${line(t)}`);
        shown.add(t);
      }
      if (!tests.length) out.push(`    (no guarding test found${sel.unrunGuards.some((u) => u.fix === f.shortSha) ? `: ${sel.unrunGuards.filter((u) => u.fix === f.shortSha).map((u) => u.file).join(', ')} names none` : ''})`);
    }
    for (const t of mine.filter((x) => !shown.has(x))) {
      out.push(`  ${line(t)}`);
      shown.add(t);
    }
  }
  for (const t of sel.tests.filter((x) => !shown.has(x))) out.push(`  ${line(t)}`);
  const failing = run?.outcomes.filter((o) => o.status === 'failed' && !sel.tests.some((t) => sameTest(t, o))) ?? [];
  for (const o of failing) out.push(`  ✗ FAIL  ${o.file}${o.line ? `:${o.line}` : ''}  ${o.name}`);
  return out.join('\n');
}

/** `mole check <sha | --diff FILE [--base SHA] | --worktree> --run-tests [--json] [--fix-rule RE] [--graph-db FILE]` */
export async function verifyCli(pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
  const sha = pos[0];
  const diffFile = str(flags.diff);
  const change: Change = diffFile !== undefined ? { diffFile: resolve(diffFile), base: str(flags.base) } : sha !== undefined ? { sha } : { worktree: true };
  const top = (gitText(root, ['rev-parse', '--show-toplevel']) ?? root).trim();
  const graphDb = str(flags['graph-db']) ?? join(top, '.mole/local/verify/graph.sqlite');
  const sel = await selectTests(top, change, { fixRule: str(flags['fix-rule']), graphDb });
  const run = sel.tests.length ? await runTests(top, sel) : undefined;
  if (flags.json) console.log(JSON.stringify({ selection: { ...sel, check: undefined, hunks: sel.check.hunks }, run: run ?? null }, null, 2));
  else console.log(formatVerify(sel, run));
  return run && (run.failed > 0 || run.error || run.notRun.length) ? 1 : 0;
}
