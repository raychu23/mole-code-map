// T56 (D67 first slice): what-if branches of the decision records.
//
// A proposal is a git branch + linked worktree created from one pinned baseline commit (git worktree,
// prior-art.md). Evaluating it loads the decision graph twice -- the baseline commit's records and the
// proposal worktree's records -- runs the same grounded reasoning engine on both (@mole/reasoning via
// @mole/decisions' argumentFramework), and reports which arguments and which decisions resting on them
// change. Nothing here approves, commits, merges or touches the approved checkout. Files a proposal
// changes that are not structured records are listed as notEvaluated, never interpreted.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { argumentDefinitions, argumentFramework, loadGraph, phaseInForce, tenetValues, type DecisionGraph, type GraphNode } from '@mole/decisions';
import { evaluate, type Label } from '@mole/reasoning';

export class ProposalError extends Error {}

export interface ProposalMeta {
  schema: 1;
  name: string;
  branch: string;
  baselineRevision: string;
  repo: string;
  createdAt: string;
}

export type ArgState = Label | 'absent';
/** uncited = the record exists but cites no argument (so the engine cannot judge it); absent = no record */
export type DecisionState = 'holds' | 'contested' | 'defeated' | 'uncited' | 'absent';

export interface ArgumentChange {
  id: string;
  /** the statement's text from its Argdown definition line ('<id>: text'), '' when only referenced */
  text: string;
  before: ArgState;
  after: ArgState;
  source: { file: string; line: number };
}

export interface DecisionChange {
  id: string;
  title: string;
  source?: string;
  record: { file: string; line: number };
  before: DecisionState;
  after: DecisionState;
  /** cited arguments whose label changed */
  because: string[];
}

export interface ProposalReport {
  name: string;
  branch: string;
  path: string;
  baselineRevision: string;
  /** T68: the phase-resolved reading (same shape T56 always returned) -- the phase in force today, or `sel`'s
   *  explicit `phase`/`at`, resolved independently against EACH side's own `.mole/priorities.md`; no file on a
   *  side = no audience for that side (T60's existing fallback), so with neither side carrying one this equals
   *  `plainDung` exactly. */
  changes: { arguments: ArgumentChange[]; decisions: DecisionChange[] };
  /** T68: ALWAYS the plain-Dung reading (no audience), shown beside `changes` so a phase-driven reading is never
   *  silently substituted for it (STOP clause: show both, never pick silently). */
  plainDung: { arguments: ArgumentChange[]; decisions: DecisionChange[] };
  /** T68: which phase (if any) `changes` was resolved under, per side; absent = no audience on that side. */
  phase: { before?: string; after?: string };
  notEvaluated: string[];
  problems: Array<{ file: string; line: number; message: string }>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const META_FILE = 'mole-proposal.json';
const RECORD_DIRS = ['.mole/arguments/', '.mole/decisions/', '.mole/tenets.md', '.mole/intent/', '.mole/incidents/'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }).status === 0;
}

function topLevel(dir: string): string {
  if (!existsSync(dir) || !gitOk(dir, ['rev-parse', '--show-toplevel'])) throw new ProposalError(`not a git repository: ${dir}`);
  return git(dir, ['rev-parse', '--show-toplevel']);
}

/** Per-worktree git dir path for the metadata: outside the tree, never committed, removed with the worktree. */
function metaPath(worktree: string): string {
  return resolve(worktree, git(worktree, ['rev-parse', '--git-path', META_FILE]));
}

export function readMeta(path: string): ProposalMeta {
  let meta: ProposalMeta | undefined;
  try {
    topLevel(path);
    const p = metaPath(path);
    if (existsSync(p)) meta = JSON.parse(readFileSync(p, 'utf8')) as ProposalMeta;
  } catch {
    meta = undefined;
  }
  if (!meta || meta.schema !== 1 || !/^[0-9a-f]{40}$/.test(meta.baselineRevision ?? '')) {
    throw new ProposalError(`not a Mole proposal worktree (no ${META_FILE}): ${path} -- create one with: mole-proposals create`);
  }
  return meta;
}

/** realpath of the nearest existing ancestor + the not-yet-existing remainder */
function realExisting(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

export interface CreateOptions {
  repo: string;
  name: string;
  path: string;
  /** baseline revision, default HEAD; resolved to a full commit hash before anything is written */
  base?: string;
}

export function createProposal(opts: CreateOptions): ProposalMeta {
  const repo = topLevel(opts.repo);
  if (!NAME.test(opts.name) || opts.name.includes('..')) {
    throw new ProposalError(`invalid proposal name '${opts.name}': use lowercase letters, digits, '.', '_' or '-' (max 63)`);
  }
  if (!isAbsolute(opts.path)) throw new ProposalError(`proposal path must be absolute: ${opts.path}`);
  if (existsSync(opts.path)) throw new ProposalError(`proposal path already exists: ${opts.path}`);
  // review 1 MEDIUM: never nest a worktree inside the repository's git directory (prior-art.md safety rule)
  // compare real paths: /var vs /private/var (macOS) or a symlinked parent must not slip past the check
  const common = realpathSync(resolve(repo, git(repo, ['rev-parse', '--git-common-dir'])));
  const target = realExisting(resolve(opts.path));
  if (target === common || target.startsWith(common + sep)) throw new ProposalError(`proposal path is inside the repository git directory: ${opts.path}`);
  const branch = `mole/proposal/${opts.name}`;
  if (!gitOk(repo, ['check-ref-format', '--branch', branch])) throw new ProposalError(`invalid proposal name '${opts.name}' (git rejects branch ${branch})`);
  if (gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) throw new ProposalError(`proposal branch already exists: ${branch}`);
  const base = opts.base ?? 'HEAD';
  if (!gitOk(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`])) throw new ProposalError(`baseline is not a commit: ${base}`);
  const baselineRevision = git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);

  // every check above runs before the first write; past this point a failure undoes only what this call made
  let added = false;
  try {
    git(repo, ['worktree', 'add', '--quiet', '-b', branch, opts.path, baselineRevision]);
    added = true;
    const meta: ProposalMeta = { schema: 1, name: opts.name, branch, baselineRevision, repo, createdAt: new Date().toISOString() };
    writeFileSync(metaPath(opts.path), JSON.stringify(meta, null, 2) + '\n');
    return meta;
  } catch (e) {
    if (added) gitOk(repo, ['worktree', 'remove', '--force', opts.path]);
    if (gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) gitOk(repo, ['branch', '-D', branch]);
    if (e instanceof ProposalError) throw e;
    throw new ProposalError(`could not create proposal: ${(e as Error).message}`);
  }
}

/** The baseline commit's .mole records, extracted to a temp dir (git archive), so the approved checkout is never read or changed. */
export function baselineSnapshot(worktree: string, rev: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mole-proposal-base-'));
  if (gitOk(worktree, ['cat-file', '-e', `${rev}:.mole`])) {
    const tar = execFileSync('git', ['-C', worktree, 'archive', '--format=tar', rev, '--', '.mole'], { maxBuffer: 1 << 30 });
    const x = spawnSync('tar', ['-x', '-C', dir], { input: tar });
    if (x.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new ProposalError(`could not read baseline records at ${rev}: ${x.stderr?.toString() ?? ''}`);
    }
  }
  return dir;
}

interface Evaluated {
  graph: DecisionGraph;
  /** plain Dung (no audience) -- always computed, shown as `plainDung` */
  plainLabels: Record<string, Label>;
  /** T68: phase-resolved labels (identical to plainLabels when no phase applies to this side) */
  labels: Record<string, Label>;
  /** T68: the phase name `labels` was resolved under on this side; undefined = no audience */
  phase?: string;
}

export interface PhaseSelector {
  phase?: string;
  at?: string;
  /** T73: a what-if tenet order -- NEVER read from or written to .mole/priorities.md; overrides phase/at
   *  when given (the panel's/CLI's "compare with order X"). */
  order?: string[];
}

/** T68: `sel` ({ phase, at }) is resolved against THIS root's own `.mole/priorities.md` (phaseInForce,
 * @mole/decisions) -- absent both, the phase in force today, same selector incident suggest uses (D93); no
 * file on this side = no audience, T60's existing fallback. T73: `sel.order`, when given, wins over phase/at
 * and is never read from or written to priorities.md on either side (the what-if). */
function evaluateRecords(root: string, sel: PhaseSelector = {}): Evaluated {
  const graph = loadGraph(root);
  const { framework } = argumentFramework(graph);
  const plainLabels = evaluate(framework).labels;
  if (sel.order) {
    const values = tenetValues(graph);
    const args = framework.args.map((a) => ({ ...a, ...(values.has(a.id) ? { value: values.get(a.id)! } : {}) }));
    const labels = evaluate({ args, attacks: framework.attacks }, sel.order).labels;
    return { graph, plainLabels, labels, phase: 'what-if' };
  }
  const phase = phaseInForce(root, sel, graph);
  if (!phase) return { graph, plainLabels, labels: plainLabels };
  const values = tenetValues(graph);
  const args = framework.args.map((a) => ({ ...a, ...(values.has(a.id) ? { value: values.get(a.id)! } : {}) }));
  const labels = evaluate({ args, attacks: framework.attacks }, phase.order).labels;
  return { graph, plainLabels, labels, phase: phase.name };
}

/** '<id>: text' / '[id]: text' on the record's own line -> 'text' (the Argdown parser keys items by title only). */
/** the argument's own definition text (not node.line, which may be an earlier bare reference: T60 review 1) */
function statementText(graph: DecisionGraph, id: string): string {
  return argumentDefinitions(graph).get(id)?.[0]?.text ?? '';
}

function decisionState(cited: string[], labels: Record<string, Label>): DecisionState {
  const ls = cited.map((id) => labels[id]).filter((l): l is Label => l !== undefined);
  if (ls.length === 0) return 'uncited'; // review 1 HIGH: 'absent' here hid deleting an uncited record
  if (ls.includes('out')) return 'defeated';
  if (ls.includes('undecided')) return 'contested';
  return 'holds';
}

function citedArguments(graph: DecisionGraph, decisionId: string): string[] {
  const args = new Set(graph.nodes.filter((n) => n.kind === 'argument').map((n) => n.id));
  return [...new Set(graph.edges.filter((e) => e.type === 'cites' && e.from === decisionId && args.has(e.to)).map((e) => e.to))].sort();
}

/** Diff two label sets (before/after, each already resolved under whichever audience the caller wants) into the
 *  same `{ arguments, decisions }` shape, reused for both the phase-resolved `changes` and the always-plain
 *  `plainDung` reading (T68: one diff implementation, called twice -- not a second copy of the diff rule). */
function diffLabels(before: { graph: DecisionGraph; labels: Record<string, Label> }, after: { graph: DecisionGraph; labels: Record<string, Label> }): { arguments: ArgumentChange[]; decisions: DecisionChange[] } {
  const nodeById = (g: DecisionGraph) => new Map(g.nodes.map((n) => [n.id, n] as [string, GraphNode]));
  const bNodes = nodeById(before.graph);
  const aNodes = nodeById(after.graph);

  const argIds = new Set([...Object.keys(before.labels), ...Object.keys(after.labels)]);
  const argumentsChanged: ArgumentChange[] = [];
  for (const id of [...argIds].sort()) {
    const b: ArgState = before.labels[id] ?? 'absent';
    const a: ArgState = after.labels[id] ?? 'absent';
    if (a === b) continue;
    const inAfter = aNodes.has(id);
    const n = (inAfter ? aNodes.get(id) : bNodes.get(id))!;
    const text = statementText(inAfter ? after.graph : before.graph, id);
    argumentsChanged.push({ id, text, before: b, after: a, source: { file: n.file, line: n.line } });
  }
  const changedArgs = new Set(argumentsChanged.map((c) => c.id));

  const decIds = new Set([...before.graph.nodes, ...after.graph.nodes].filter((n) => n.kind === 'decision').map((n) => n.id));
  const decisionsChanged: DecisionChange[] = [];
  for (const id of [...decIds].sort()) {
    const bn = bNodes.get(id);
    const an = aNodes.get(id);
    const bCited = bn ? citedArguments(before.graph, id) : [];
    const aCited = an ? citedArguments(after.graph, id) : [];
    const bs = bn ? decisionState(bCited, before.labels) : 'absent';
    const as = an ? decisionState(aCited, after.labels) : 'absent';
    if (bs === as) continue;
    const n = (an ?? bn)!;
    const because = [...new Set([...bCited, ...aCited])].filter((x) => changedArgs.has(x)).sort();
    decisionsChanged.push({ id, title: n.title, ...(n.source ? { source: n.source } : {}), record: { file: n.file, line: n.line }, before: bs, after: as, because });
  }
  return { arguments: argumentsChanged, decisions: decisionsChanged };
}

function changedFiles(worktree: string, rev: string): string[] {
  const tracked = git(worktree, ['diff', '--name-only', rev, '--']).split('\n');
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

/** `sel` picks the phase (T60) each side (baseline snapshot, worktree) is independently evaluated under; absent
 *  both, the phase in force TODAY (D93). `changes` is that phase-resolved reading; `plainDung` is ALWAYS plain
 *  Dung, so a proposal that "looks real" without an audience but changes nothing under the phase in force (the
 *  T61 replay case: already defeated) is never silently reported as the same thing (STOP clause). */
export function evaluateProposal(path: string, sel: PhaseSelector = {}): ProposalReport {
  const meta = readMeta(path);
  const worktree = topLevel(path);
  // review 1 LOW: a hand-edited or pruned baseline must fail as a clean error, not a git stack trace
  if (!gitOk(worktree, ['cat-file', '-e', `${meta.baselineRevision}^{commit}`])) {
    throw new ProposalError(`baseline commit not found: ${meta.baselineRevision} (proposal ${meta.name})`);
  }
  const baseDir = baselineSnapshot(worktree, meta.baselineRevision);
  try {
    const before = evaluateRecords(baseDir, sel);
    const after = evaluateRecords(worktree, sel);
    const plainDung = diffLabels({ graph: before.graph, labels: before.plainLabels }, { graph: after.graph, labels: after.plainLabels });
    const changes = diffLabels(before, after);

    const notEvaluated = changedFiles(worktree, meta.baselineRevision).filter((f) => !RECORD_DIRS.some((d) => f === d || f.startsWith(d)));
    return {
      name: meta.name,
      branch: meta.branch,
      path: worktree,
      baselineRevision: meta.baselineRevision,
      changes,
      plainDung,
      phase: { ...(before.phase ? { before: before.phase } : {}), ...(after.phase ? { after: after.phase } : {}) },
      notEvaluated,
      problems: after.graph.problems.map((p) => ({ file: p.file, line: p.line, message: p.message })),
    };
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

export interface Comparison {
  baselineRevision: string;
  proposals: ProposalReport[];
}

export function compareProposals(paths: string[], sel: PhaseSelector = {}): Comparison {
  if (paths.length < 2) throw new ProposalError('compare needs at least two proposal paths');
  const metas = paths.map(readMeta);
  const bases = new Set(metas.map((m) => m.baselineRevision));
  if (bases.size !== 1) {
    throw new ProposalError(`proposals were made from different baselines (${[...bases].map((b) => b.slice(0, 12)).join(', ')}); compare only proposals from the same baseline`);
  }
  return { baselineRevision: metas[0]!.baselineRevision, proposals: paths.map((p) => evaluateProposal(p, sel)) };
}
