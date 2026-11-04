// T60: tenets reranked as priorities shift (launch → scale). Prior art: (internal reference removed) log/prior-art.md.
//
//   .mole/priorities.md    `## <phase> · from YYYY-MM-DD` headings, each followed by an ordered list of tenet ids
//                          (`1. tenet-x` or `- tenet-x`), most preferred first = a Bench-Capon audience
//   #tenet-x tag           on an argument's Argdown definition line = the value it promotes
//   evaluatePhase          the engine (@mole/reasoning evaluate) under that phase's audience; no phase = no audience
//   comparePhases          every argument whose label differs, with the attacks whose success flipped (both tenets,
//                          both ranks) or the changed attackers it moved through, plus decisions resting on them
// Read-only. Records are never written except by setPriorities (T73: a person's CLI act, never MCP).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { lock as lockFile } from 'proper-lockfile';
import { evaluate, type Label } from '@mole/reasoning';
import { argumentDefinitions } from './argdown/definitions.js';
import { argumentFramework } from './argdown/framework.js';
import { loadGraph } from './graph.js';
import type { DecisionGraph } from './types.js';

export class PrioritiesError extends Error {}

export interface Phase {
  name: string;
  from: string;
  /** tenet ids, most preferred first */
  order: string[];
  file: string;
  line: number;
}

const FILE = '.mole/priorities.md';
const HEADING = /^##\s+([A-Za-z0-9][\w.-]*)\s*(?:[·:\-–—]\s*)?from\s+(\S+)\s*$/i;
const ITEM = /^\s*(?:\d+[.)]|[-*])\s+(\S+)\s*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function tenetIds(graph: DecisionGraph): Set<string> {
  return new Set(graph.nodes.filter((n) => n.kind === 'tenet').map((n) => n.id));
}

export function readPriorities(root: string, graph: DecisionGraph = loadGraph(root)): Phase[] {
  const path = join(root, FILE);
  if (!existsSync(path)) return [];
  const tenets = tenetIds(graph);
  const phases: Phase[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let cur: Phase | undefined;
  lines.forEach((l, i) => {
    const at = `${FILE}:${i + 1}`;
    const h = /^##\s/.test(l) ? HEADING.exec(l) : null;
    if (/^##\s/.test(l)) {
      if (!h) throw new PrioritiesError(`phase heading must be '## <name> · from YYYY-MM-DD' (${at})`);
      const [, name, from] = h as unknown as [string, string, string];
      // review 1 LOW: Date.parse rolls 2026-02-30 over to March; round-trip the date to catch impossible days
      if (!DATE.test(from) || new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from) throw new PrioritiesError(`phase ${name}: '${from}' is not a YYYY-MM-DD date (${at})`);
      const prev = phases[phases.length - 1];
      if (prev && from <= prev.from) throw new PrioritiesError(`phase ${name} must start after ${prev.name} (${prev.from}) (${at})`);
      if (phases.some((p) => p.name === name)) throw new PrioritiesError(`phase ${name} is defined twice (${at})`);
      cur = { name, from, order: [], file: FILE, line: i + 1 };
      phases.push(cur);
      return;
    }
    const m = ITEM.exec(l);
    if (!m || !cur) return;
    const t = m[1]!;
    if (!tenets.has(t)) throw new PrioritiesError(`phase ${cur.name}: ${t} is not a tenet in .mole/tenets.md (${at})`);
    if (cur.order.includes(t)) throw new PrioritiesError(`phase ${cur.name}: ${t} is ranked twice (${at})`);
    cur.order.push(t);
  });
  return phases;
}

/** The phase in force on `date`: the latest one whose `from` is on or before it. */
export function phaseAt(phases: Phase[], date: string): Phase {
  if (!DATE.test(date)) throw new PrioritiesError(`'${date}' is not a YYYY-MM-DD date`);
  const p = [...phases].reverse().find((x) => x.from <= date);
  if (!p) throw new PrioritiesError(phases.length ? `${date} is before the first phase (${phases[0]!.name} from ${phases[0]!.from})` : `no phases in ${FILE}`);
  return p;
}

/** argument id -> the tenet its DEFINITION line tags (#tenet-x; review 1: not node.line, which may be an earlier bare
 *  reference). Unknown tenet, or two definitions with different tenet tags, refused with file:line.
 *  T68: exported so packages/decisions/src/incidents/revive.ts and @mole/proposals can apply the same phase's
 *  audience to their own evaluations (one source of truth, the project's shared instructions file #5), instead of a second tag reader. */
export function tenetValues(graph: DecisionGraph): Map<string, string> {
  const tenets = tenetIds(graph);
  const out = new Map<string, string>();
  for (const [id, defs] of argumentDefinitions(graph)) {
    const tagged = defs.map((d) => ({ d, t: d.tags.filter((x) => x.startsWith('tenet-')).pop() })).filter((x) => x.t);
    if (tagged.length === 0) continue;
    const distinct = [...new Set(tagged.map((x) => x.t))];
    if (distinct.length > 1) throw new PrioritiesError(`argument ${id} is tagged with different tenets: ${tagged.map((x) => `#${x.t} (${x.d.file}:${x.d.line})`).join(', ')}`);
    const { d, t } = tagged[0]!;
    if (!tenets.has(t!)) throw new PrioritiesError(`argument ${id} is tagged #${t}, which is not a tenet (${d.file}:${d.line})`);
    out.set(id, t!);
  }
  return out;
}

export type DecisionState = 'holds' | 'contested' | 'defeated' | 'uncited';

export interface PhaseEvaluation {
  phase?: string;
  audience?: string[];
  labels: Record<string, Label>;
  decisions: Array<{ id: string; title: string; state: DecisionState; cites: string[]; file: string; line: number }>;
}

function decisionStates(graph: DecisionGraph, labels: Record<string, Label>): PhaseEvaluation['decisions'] {
  const args = new Set(Object.keys(labels));
  return graph.nodes
    .filter((n) => n.kind === 'decision')
    .map((d) => {
      const cites = [...new Set(graph.edges.filter((e) => e.type === 'cites' && e.from === d.id && args.has(e.to)).map((e) => e.to))].sort();
      const ls = cites.map((c) => labels[c]!);
      const state: DecisionState = ls.length === 0 ? 'uncited' : ls.includes('out') ? 'defeated' : ls.includes('undecided') ? 'contested' : 'holds';
      return { id: d.id, title: d.title, state, cites, file: d.file, line: d.line };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface Loaded {
  graph: DecisionGraph;
  phases: Phase[];
  values: Map<string, string>;
  attacks: [string, string][];
  args: string[];
}

function load(root: string): Loaded {
  const graph = loadGraph(root);
  const phases = readPriorities(root, graph);
  const values = tenetValues(graph);
  const { framework } = argumentFramework(graph);
  return { graph, phases, values, attacks: framework.attacks, args: framework.args.map((a) => a.id) };
}

function run(l: Loaded, phase?: Phase): PhaseEvaluation {
  const labels = evaluate({ args: l.args.map((id) => ({ id, ...(l.values.has(id) ? { value: l.values.get(id)! } : {}) })), attacks: l.attacks }, phase?.order).labels;
  return { ...(phase ? { phase: phase.name, audience: phase.order } : {}), labels, decisions: decisionStates(l.graph, labels) };
}

/** Resolve a `{ phase, at }` selector against an explicit phase list (no graph/file I/O): `phase` by name,
 *  `at` = the phase in force on that date, neither = no audience. T68: exported so incident/proposals callers
 *  that already loaded their own `Phase[]` do not re-implement this resolution rule. */
export function selectPhase(phases: Phase[], sel: { phase?: string; at?: string }): Phase | undefined {
  if (sel.phase !== undefined) {
    const p = phases.find((x) => x.name === sel.phase);
    if (!p) throw new PrioritiesError(`no phase '${sel.phase}' in ${FILE} (have: ${phases.map((x) => x.name).join(', ') || 'none'})`);
    return p;
  }
  if (sel.at !== undefined) return phaseAt(phases, sel.at);
  return undefined;
}

function pick(l: Loaded, sel: { phase?: string; at?: string }): Phase | undefined {
  return selectPhase(l.phases, sel);
}

/** Labels + decision states under one phase's tenet order (`phase` name or the phase in force `at` a date); neither = no audience.
 *  Unchanged T60 behaviour: with neither `phase` nor `at`, this is plain Dung (no audience) -- `mole priorities`'s own default.
 *  T68's incident/proposals tools use `phaseInForce` below instead, whose default is the phase in force today. */
export function evaluatePhase(root: string, sel: { phase?: string; at?: string } = {}): PhaseEvaluation {
  const l = load(root);
  return run(l, pick(l, sel));
}

export const today = (): string => new Date().toISOString().slice(0, 10);

/** T68 D93: the phase selector for incident suggest / proposals compare and their MCP tools. Explicit `phase` or
 *  `at` wins; absent both, the phase in force TODAY (matching mole_priorities's own pre-existing doc comment,
 *  reasoning-tools.ts, which `evaluatePhase`'s own default never implemented); no `.mole/priorities.md` = no
 *  audience, same fallback T60 already uses. Each caller resolves against its OWN root's phases (its own file),
 *  so a proposal/baseline pair with different priorities.md files is still compared fairly, one side at a time. */
export function phaseInForce(root: string, sel: { phase?: string; at?: string } = {}, graph?: DecisionGraph): Phase | undefined {
  const phases = readPriorities(root, graph);
  if (sel.phase !== undefined || sel.at !== undefined) return selectPhase(phases, sel);
  return phases.length ? phaseAt(phases, today()) : undefined;
}

export interface FlippedAttack {
  from: string;
  to: string;
  fromValue: string;
  toValue: string;
  before: { succeeds: boolean; ranks: [number, number] };
  after: { succeeds: boolean; ranks: [number, number] };
}

export interface PhaseComparison {
  from: string;
  to: string;
  arguments: Array<{ id: string; before: Label; after: Label; flipped: FlippedAttack[]; via: string[] }>;
  decisions: Array<{ id: string; title: string; before: DecisionState; after: DecisionState; because: string[]; file: string; line: number }>;
}

/** Bench-Capon rule, same as engine.ts attackSucceeds: fails only if both values ranked and the target's is preferred */
function succeeds(order: string[], va?: string, vb?: string): boolean {
  if (va === undefined || vb === undefined) return true;
  const ia = order.indexOf(va);
  const ib = order.indexOf(vb);
  return ia === -1 || ib === -1 || !(ib < ia);
}

export function comparePhases(root: string, a: string, b: string): PhaseComparison {
  const l = load(root);
  const pa = pick(l, { phase: a })!;
  const pb = pick(l, { phase: b })!;
  return diffPhases(l, pa, pb);
}

/** Shared by comparePhases (two named phases) and compareWithOrder (T73: a what-if order, never a named phase). */
function diffPhases(l: Loaded, pa: { name: string; order: string[] }, pb: { name: string; order: string[] }): PhaseComparison {
  const ea = run(l, pa as Phase);
  const eb = run(l, pb as Phase);
  const changed = l.args.filter((id) => ea.labels[id] !== eb.labels[id]).sort();
  const changedSet = new Set(changed);
  const rank = (order: string[], v: string) => order.indexOf(v) + 1; // 1-based, 0 = unranked
  const argumentsChanged = changed.map((id) => {
    const incoming = l.attacks.filter(([, t]) => t === id);
    const flipped: FlippedAttack[] = [];
    for (const [f, t] of incoming) {
      const vf = l.values.get(f);
      const vt = l.values.get(t);
      const sa = succeeds(pa.order, vf, vt);
      const sb = succeeds(pb.order, vf, vt);
      if (sa === sb || vf === undefined || vt === undefined) continue;
      flipped.push({ from: f, to: t, fromValue: vf, toValue: vt, before: { succeeds: sa, ranks: [rank(pa.order, vf), rank(pa.order, vt)] }, after: { succeeds: sb, ranks: [rank(pb.order, vf), rank(pb.order, vt)] } });
    }
    // no flipped attack of its own: it moved because an attacker's label changed
    const via = flipped.length ? [] : [...new Set(incoming.map(([f]) => f).filter((f) => changedSet.has(f)))].sort();
    return { id, before: ea.labels[id]!, after: eb.labels[id]!, flipped, via };
  });
  const decisions = ea.decisions
    .map((d) => ({ d, e: eb.decisions.find((x) => x.id === d.id)! }))
    .filter(({ d, e }) => d.state !== e.state)
    .map(({ d, e }) => ({ id: d.id, title: d.title, before: d.state, after: e.state, because: d.cites.filter((c) => changedSet.has(c)), file: d.file, line: d.line }));
  return { from: pa.name, to: pb.name, arguments: argumentsChanged, decisions };
}

// review 2 HIGH: the hand-rolled O_EXCL mutex never refreshed its own mtime while held (a live holder doing
// slow work, e.g. MOLE_PRIORITIES_TEST_DELAY_MS, looked "abandoned" after LOCK_STALE_MS and got its lock
// reclaimed out from under it -- mutual exclusion lost), its wait bound (5s) was SHORTER than its own stale
// bound (10s, spurious "crashed holder" timeouts for a holder that was merely slow), and its release had no
// ownership token (unlinkSync by PATH, not by holder identity) so a confused old holder's `finally` could
// delete a DIFFERENT process's current lock. `proper-lockfile` (moxystudio, npm) fixes exactly these: it
// creates the mutex with `mkdir` (a lock DIRECTORY, atomic on any filesystem), periodically refreshes the
// directory's mtime via a background timer while the lock is held (`update`), and detects a lock whose mtime
// it can no longer refresh (`onCompromised`) instead of silently letting a second holder in. T73 review 1's
// stale bound (10s) is kept as the production default; `MOLE_PRIORITIES_TEST_STALE_MS` is a test-only seam
// stale bound (unset in production). proper-lockfile itself enforces floors (`stale` >= 2000ms, `update` >=
// 1000ms), so a test override still has to clear those floors. Read fresh on every `acquireLock` call (never
// cached at module load) so a single test process can flip the env var between calls, same as
// MOLE_PRIORITIES_TEST_DELAY_MS already does.
function lockStaleMs(): number {
  return Number(process.env.MOLE_PRIORITIES_TEST_STALE_MS) || 10_000;
}

/** Retry budget whose WORST-CASE total wait exceeds `staleMs` (review 2 HIGH: the old 5s wait bound was
 *  shorter than the 10s stale bound, so a holder merely slow -- not crashed -- could trigger a spurious
 *  "crashed holder" timeout in a waiting process before the real holder even reached its own stale bound).
 *  Scaled off `staleMs` so the test-only stale override above still gets a wait bound longer than itself. */
function lockRetries(staleMs: number): { retries: number; factor: number; minTimeout: number; maxTimeout: number } {
  const minTimeout = Math.max(20, Math.round(staleMs / 50));
  const maxTimeout = Math.max(300, Math.round(staleMs / 2));
  return { retries: 25, factor: 1.4, minTimeout, maxTimeout };
}

/** review 2 HIGH: acquire the lock via proper-lockfile instead of a hand-rolled O_EXCL loop (see the comment
 *  above `LOCK_STALE_MS`). `realpath: false` because the locked file (`.mole/priorities.md`) may not exist yet
 *  (a brand-new repo's first `priorities set` creates it) -- proper-lockfile's own `realpath` resolution
 *  requires the target to already exist. Returns an async release function (always call in `finally`). */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const stale = lockStaleMs();
  const { retries, factor, minTimeout, maxTimeout } = lockRetries(stale);
  try {
    return await lockFile(path, {
      stale,
      update: Math.round(stale / 4), // proper-lockfile clamps this into [1000, stale/2] itself
      retries: { retries, factor, minTimeout, maxTimeout },
      realpath: false,
      onCompromised: (err) => { throw new PrioritiesError(`lock on ${path} was compromised (its mtime could no longer be refreshed): ${err.message}`); },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new PrioritiesError(`timed out waiting for the lock on ${path} (another 'priorities set' is running or crashed holding it)`);
    }
    throw err;
  }
}

/** review 2 MED: a crash-orphaned `<file>.lock` must never show up as an untracked file in a REPO THIS RUNS
 *  AGAINST (Mole's own .gitignore only protects Mole's own checkout). Mirrors the per-folder .gitignore
 *  @mole/memory already writes for `.mole/local` (T13, appendSeen): written once, the first time setPriorities
 *  runs in a repo that doesn't already ignore it; never overwritten or duplicated after. */
function ensureLockIgnored(root: string): void {
  const dir = join(root, '.mole');
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
  const ignorePath = join(dir, '.gitignore');
  let text = '';
  try { text = readFileSync(ignorePath, 'utf8'); } catch { /* no .mole/.gitignore yet */ }
  if (text.split(/\r?\n/).some((l) => l.trim() === '*.lock')) return;
  const prefix = text && !text.endsWith('\n') ? `${text}\n` : text;
  writeFileSync(ignorePath, `${prefix}${prefix ? '' : '# Mole: process lock files, never committed\n'}*.lock\n`);
}

/** Write-then-rename (same directory, same filesystem): a reader never observes a half-written file, and a
 *  process crashing mid-write leaves only an orphaned `.tmp` file, never a corrupt `priorities.md`. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** review 1 HIGH 1: rewrite ONLY the numbered tenet-list lines inside a phase's body (from just after its
 *  heading to just before the next heading or EOF); every other line -- HTML comments, prose, blank lines --
 *  is kept in place, in order. New items are spliced in at the position of the FIRST existing item line (any
 *  non-item lines between old item lines, e.g. a comment interleaved with the list, stay exactly where they
 *  were). If the phase has no list yet, the new items are inserted immediately after the heading. */
function rewritePhaseList(body: string[], items: string[]): string[] {
  const itemIdxs: number[] = [];
  body.forEach((l, i) => { if (ITEM.test(l)) itemIdxs.push(i); });
  if (itemIdxs.length === 0) return [...items, ...body];
  const first = itemIdxs[0]!;
  const itemSet = new Set(itemIdxs);
  const out: string[] = [];
  body.forEach((l, i) => {
    if (i === first) out.push(...items);
    else if (!itemSet.has(i)) out.push(l);
    // else: an old item line other than the first -- dropped, replaced as a block at `first`
  });
  return out;
}

/** T73: `mole priorities set --phase P --order a,b,c` -- a person's act (never over MCP, which stays read-only,
 *  T61). Updates an existing phase's order in place (same `from` date, same position in the file, every other
 *  line in that phase untouched -- review 1 HIGH 1) or, for a phase name not yet in the file, appends a new
 *  phase dated today, after the latest one (same ordering invariant readPriorities already enforces). Every
 *  tenet must exist and be ranked once, like readPriorities. Guarded by a file lock (review 1 HIGH 2: concurrent
 *  `set` on different -- or the same -- phase used to be a lost-update read-modify-write race) and written via
 *  a temp-file + rename so a reader never sees a half-written file. Re-reads the written file through
 *  readPriorities before returning, so a malformed write is caught HERE (round trip, T73 done-when 3), not by
 *  the next CLI call. */
export async function setPriorities(root: string, phase: string, order: string[], graph: DecisionGraph = loadGraph(root)): Promise<Phase[]> {
  if (order.length === 0) throw new PrioritiesError('order must list at least one tenet');
  const tenets = tenetIds(graph);
  const seen = new Set<string>();
  for (const t of order) {
    if (!tenets.has(t)) throw new PrioritiesError(`${t} is not a tenet in .mole/tenets.md`);
    if (seen.has(t)) throw new PrioritiesError(`${t} is ranked twice`);
    seen.add(t);
  }
  const path = join(root, FILE);
  ensureLockIgnored(root); // review 2 MED: arrange the ignore rule before the lock dir can ever exist
  const release = await acquireLock(path);
  try {
    // review 2 LOW: validate the EXISTING file with readPriorities' own rules -- unconditionally, not just on
    // the new-phase branch below -- before splicing ANY phase. A malformed OTHER phase (unknown tenet,
    // duplicate rank, bad date, two stray tenet lists) used to be silently collapsed by the rewrite instead of
    // refused with file:line, same as every other setPriorities/readPriorities validation failure.
    const existing = readPriorities(root, graph);
    // review 1 HIGH 2: re-read AFTER the lock is held, never before -- a read taken before acquiring the lock
    // could already be stale by the time this process gets its turn to write.
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '# Priorities\n';
    // review 1 HIGH 2 test seam: widen the critical section on demand so a concurrency test can force a real
    // interleave deterministically. Inert unless MOLE_PRIORITIES_TEST_DELAY_MS is set (test/priorities-lock-worker.ts).
    // review 2 HIGH: this MUST be a non-blocking await, never a synchronous/Atomics.wait sleep -- proper-lockfile
    // refreshes the lock's mtime on a background timer (`update`) while the lock is held, and a blocked event
    // loop would starve that timer, reintroducing the exact "live holder looks abandoned" bug being fixed here.
    const testDelayMs = Number(process.env.MOLE_PRIORITIES_TEST_DELAY_MS ?? 0);
    if (testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testDelayMs));
    const eol = text.includes('\r\n') ? '\r\n' : '\n'; // review 1 HIGH 1: preserve the file's own line ending
    const lines = text.split(/\r?\n/);
    const items = order.map((t, i) => `${i + 1}. ${t}`);
    const headingIdx = lines.findIndex((l) => { const h = /^##\s/.test(l) ? HEADING.exec(l) : null; return !!h && h[1] === phase; });
    if (headingIdx !== -1) {
      let nextHeadingIdx = lines.length;
      for (let i = headingIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i]!)) { nextHeadingIdx = i; break; }
      }
      const body = rewritePhaseList(lines.slice(headingIdx + 1, nextHeadingIdx), items);
      const out = [...lines.slice(0, headingIdx + 1), ...body, ...lines.slice(nextHeadingIdx)];
      writeFileAtomic(path, out.join(eol));
    } else {
      const last = existing[existing.length - 1];
      const from = today();
      if (last && from <= last.from) throw new PrioritiesError(`a new phase must start after ${last.name} (${last.from}); today (${from}) is not after it`);
      const out = [text.replace(/\s+$/, ''), '', `## ${phase} · from ${from}`, '', ...items, ''];
      writeFileAtomic(path, out.join(eol));
    }
  } finally {
    await release();
  }
  return readPriorities(root, graph); // round trip: the write this function just made, re-parsed
}

/** T73: the panel's/CLI's \"compare with order X\" what-if -- the engine judged under an arbitrary tenet order
 *  that is NEVER read from or written to .mole/priorities.md (STOP clause: a what-if never writes). `name`
 *  labels the result (default 'what-if'); every tenet in `order` must exist, like a stored phase's order. */
export function evaluateOrder(root: string, order: string[], name = 'what-if'): PhaseEvaluation {
  const l = load(root);
  const tenets = tenetIds(l.graph);
  for (const t of order) if (!tenets.has(t)) throw new PrioritiesError(`${t} is not a tenet in .mole/tenets.md`);
  return run(l, { name, from: '', order, file: FILE, line: 0 });
}

/** T73: the phase in force (or a named/`--at` phase, same selector evaluatePhase/phaseInForce use) compared
 *  against a what-if order -- never read from or written to .mole/priorities.md. No phase in force (or no
 *  priorities file) compares against plain Dung (empty order), T60's existing no-audience fallback. */
export function compareWithOrder(root: string, order: string[], sel: { phase?: string; at?: string } = {}): PhaseComparison {
  const l = load(root);
  const tenets = tenetIds(l.graph);
  for (const t of order) if (!tenets.has(t)) throw new PrioritiesError(`${t} is not a tenet in .mole/tenets.md`);
  const current = pick(l, sel);
  const a = current ? { name: current.name, order: current.order } : { name: 'no phase', order: [] };
  return diffPhases(l, a, { name: 'what-if', order });
}
