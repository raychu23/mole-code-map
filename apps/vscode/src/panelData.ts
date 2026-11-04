// T34 one-panel: pure data layer for the Mole sidebar view. No `vscode` import here (unit-testable without
// the editor), mirroring webview/render.ts and src/hover.ts's split. Each of the 8 sections below is built
// from its own runner call, wrapped independently (failure case b: one bad source degrades only its own
// section). Every caption says what the section is for the center of everything (D31): the decisions
// behind the code (tenets -> decisions -> exceptions -> code, tests, incidents, people).
// T31: one import, used only for the FolderGroup[] shape this section's runner returns (ask/prep/read-back,
// grouped by folder, never by person -- @mole/oneonone, M23 code half).
import type { FolderGroup } from '@mole/oneonone';
import type { Phase, PhaseComparison, PhaseEvaluation } from '@mole/decisions';
import type { IncidentEntry, ProposalSummary, ReasoningData } from '../webview/reasoning.js';

export type SectionId = 'decisions' | 'pastFixes' | 'notes' | 'since' | 'questions' | 'tests' | 'agents' | 'blastRadius' | 'oneonone' | 'reviewNotes' | 'reasoning';

export const SECTION_IDS: readonly SectionId[] = ['decisions', 'pastFixes', 'notes', 'since', 'questions', 'tests', 'agents', 'blastRadius', 'oneonone', 'reviewNotes', 'reasoning'];

export type SectionStatus = 'ok' | 'empty' | 'unavailable' | 'error';

export interface Section<T> {
  status: SectionStatus;
  /** one line tying this section back to D31 (the center of everything) */
  caption: string;
  data?: T;
  /** set when status is not 'ok': a single line, never a stack trace, the user can act on */
  message?: string;
}

export interface PanelModel {
  file: string;
  line: number;
  symbol?: string;
  generatedAt: number;
  cacheHit: boolean;
  sections: Record<SectionId, Section<unknown>>;
}

/** Every external call the panel needs. Real implementations run the Mole CLI (child_process, off the UI
 *  thread) or call @mole/verify's pure testsAtLine directly; tests inject stubs per-call so one failing
 *  source can be exercised without touching the others. */
export interface Runners {
  map(target: string): Promise<unknown>;
  impact(target: string): Promise<unknown>;
  flows(target: string): Promise<unknown>;
  noteList(file: string): Promise<unknown[]>;
  since(): Promise<unknown>;
  check(): Promise<unknown>; // past fixes (T12)
  questions(): Promise<unknown>; // T14, built on the same `check`
  decisions(): Promise<unknown>;
  rules(): Promise<unknown>;
  testsAtLine(file: string, line: number): unknown[] | Promise<unknown[]>;
  claims(run?: string): Promise<unknown>;
  collisions(): Promise<unknown>;
  tried(target: string): Promise<unknown>;
  agentIntent(target: string): Promise<unknown>; // T39: Entire/git-ai/Agent Trace intent, re-checked like a note
  /** T31: logged questions (hover 'Ask'), grouped by folder with the record that already answers each one,
   *  plus the folder's read-back state -- the '1:1 prep' and 'Read-back' sections. */
  oneonone(): Promise<unknown>;
  /** T40: design review / meeting note drafts + the file-tree delta diagram (@mole/reviews) */
  reviewNotes(): Promise<unknown>;
  /** T62 Reasoning section: `mole priorities list` / `mole priorities` / `mole priorities compare A B` (T60) */
  prioritiesList(): Promise<Phase[]>;
  priorities(): Promise<PhaseEvaluation>;
  prioritiesCompare(a: string, b: string): Promise<PhaseComparison>;
  /** T73: compares the phase in force against an arbitrary order (a what-if) -- never writes .mole/priorities.md */
  prioritiesWhatIf(order: string[]): Promise<PhaseComparison>;
  /** `mole incident list` (T58 suggestions, read-only) */
  incidents(): Promise<IncidentEntry[]>;
  /** `mole proposals` (T56, same JSON as the MCP tool) */
  proposals(): Promise<ProposalSummary>;
}

export interface BuildTarget {
  root: string;
  file: string;
  line: number;
  symbol?: string;
}

const CAPTIONS: Record<SectionId, string> = {
  decisions: 'Decisions: the record that governs this code and why it was made (@mole/decisions, T29).',
  pastFixes:
    'Past fixes: the decision that changed these lines before, its reason, and the test that still guards it (@mole/history PastFix, T12).',
  notes: 'Your notes: what you decided about this code, kept beside the decisions it belongs to (@mole/memory note/memory, T11).',
  since: 'Since you last looked: what changed in the decisions and code you already read, so stale understanding never passes for current (@mole/memory SinceResult, T13).',
  questions: 'Questions: up to 3 aimed at the understanding a change to this code assumes, from the decisions and fixes above (@mole/questions, T14).',
  tests: 'Tests that guard it: the record proving a decision still holds, with a button to re-check it now (@mole/verify testsAtLine/testMap, T22).',
  agents: 'Agents: who touched this code and its governing decisions, what they already tried, whether two agents collided here, and the intent recorded by Entire/git-ai/Agent Trace, re-checked like a note (@mole/agentstate, T18/T21/T24/T39).',
  blastRadius: 'Blast radius: the decisions, tests and runtime callers this change would reach (daemon map/impact + @mole/flows, T28).',
  oneonone:
    "1:1 prep + Read-back: questions logged via the hover 'Ask' button, grouped by folder (never by person) with the decision " +
    "record that already answers each one; the folder owner's confirm/reject is the Read-back, stored per folder (@mole/oneonone, T31).",
  reasoning:
    'Reasoning: which decisions hold under the phase in force and which flip at the next one (tenet order, T60), the losing ' +
    'arguments an incident may revive (T58), and what each proposal would change against the approved decisions (T56).',
  reviewNotes: 'Review / meeting notes: sparse notes from a design review expand only around what you flagged into decision drafts pinned to real code, with a delta diagram of what changed (@mole/reviews, T40).',
};

/** One line a developer can act on; never the raw error text, which may contain a stack trace or secrets. */
function toMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0]!.slice(0, 200);
}

/** Errors that mean "there is nothing to read here" rather than "this broke": distinguishes failure case a
 *  (no .mole / no git -> a one-line instruction, not a reported bug) from failure case b (a real fault,
 *  which must still surface as 'error' so it's visibly different from "nothing here"). */
const UNAVAILABLE_PATTERN = /not a git repository|no \.mole|enoent|not (a |an )?mole repo|not initiali[sz]ed|run `?mole (reindex|init|flows record)|nothing recorded in/i;

async function section<T>(id: SectionId, run: () => Promise<T> | T, isEmpty: (v: T) => boolean): Promise<Section<T>> {
  try {
    const data = await run();
    if (isEmpty(data)) return { status: 'empty', caption: CAPTIONS[id], data, message: 'nothing found here yet' };
    return { status: 'ok', caption: CAPTIONS[id], data };
  } catch (e) {
    const message = toMessage(e) || 'failed to load';
    const status: SectionStatus = UNAVAILABLE_PATTERN.test(message) ? 'unavailable' : 'error';
    return { status, caption: CAPTIONS[id], message };
  }
}

const emptyArr = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

/** one sub-source of a section: its value, or its one-line error (T34 failure case b, one level down) */
async function part<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (e) {
    return { error: toMessage(e) || 'failed to load' };
  }
}
const isFailed = (x: unknown): x is { error: string } => !!x && typeof x === 'object' && typeof (x as { error?: unknown }).error === 'string';

/** T62: phase in force + the adjacent phase's comparison (next if any, else previous), incidents, proposals. */
async function buildReasoning(r: Runners): Promise<ReasoningData> {
  const phaseP = part(async () => {
    const [phases, evaluation] = await Promise.all([r.prioritiesList(), r.priorities()]);
    const i = phases.findIndex((p) => p.name === evaluation.phase);
    if (i < 0) return { evaluation };
    const current = phases[i]!;
    const adjacent = phases[i + 1] ?? phases[i - 1];
    if (!adjacent) return { current, evaluation };
    const direction = phases[i + 1] ? ('next' as const) : ('previous' as const);
    // always earlier -> later, so a line reads forward in time (next: current -> next; previous: previous -> current)
    const [a, b] = direction === 'next' ? [current.name, adjacent.name] : [adjacent.name, current.name];
    const comparison = await part(() => r.prioritiesCompare(a, b));
    return { current, adjacent, direction, evaluation, comparison };
  });
  const [phase, incidents, proposals] = await Promise.all([phaseP, part(() => r.incidents()), part(() => r.proposals())]);
  return { phase, incidents, proposals };
}

function reasoningSection(d: ReasoningData): Section<ReasoningData> {
  const caption = CAPTIONS.reasoning;
  const parts = [d.phase, d.incidents, d.proposals];
  const errors = parts.filter(isFailed).map((p) => p.error);
  if (errors.length === parts.length) {
    const message = errors[0]!;
    return { status: UNAVAILABLE_PATTERN.test(message) ? 'unavailable' : 'error', caption, data: d, message };
  }
  const hasPhase = !!d.phase && !isFailed(d.phase) && !!d.phase.current;
  const hasIncidents = Array.isArray(d.incidents) && d.incidents.length > 0;
  const hasProposals = !!d.proposals && !isFailed(d.proposals) && d.proposals.proposals.length > 0;
  if (!hasPhase && !hasIncidents && !hasProposals && errors.length === 0) {
    return { status: 'empty', caption, data: d, message: 'no priorities, incidents or proposals recorded yet (.mole/priorities.md, .mole/incidents/, mole-proposals create)' };
  }
  return { status: 'ok', caption, data: d };
}

export async function buildPanelModel(target: BuildTarget, r: Runners): Promise<PanelModel> {
  const at = target.symbol ? `${target.file}#${target.symbol}` : target.file;
  const reasoningP = buildReasoning(r); // T62: started alongside the other sections

  const [decisions, pastFixes, notes, since, questions, tests, agents, blastRadius, oneonone, reviewNotes] = await Promise.all([
    section('decisions', () => r.decisions(), (v: any) => emptyArr(v?.decisions)),
    section('pastFixes', () => r.check(), (v: any) => emptyArr(v?.hunks) || (v?.hunks ?? []).every((h: any) => emptyArr(h.pastFixes))),
    section('notes', () => r.noteList(target.file), emptyArr),
    section('since', () => r.since(), (v: any) => emptyArr(v?.files)),
    section('questions', () => r.questions(), (v: any) => emptyArr(v?.questions)),
    section('tests', () => r.testsAtLine(target.file, target.line), emptyArr),
    section('agents', async () => {
      const [claims, collisions, tried, agentIntent] = await Promise.all([r.claims(), r.collisions(), r.tried(at), r.agentIntent(at)]);
      return { claims, collisions, tried, agentIntent };
    }, (v: any) => emptyArr(v?.claims?.claims) && emptyArr(v?.collisions?.pairs) && emptyArr(v?.tried?.tried) && emptyArr(v?.agentIntent?.statuses)),
    section('blastRadius', async () => {
      const [map, impact, flows] = await Promise.all([r.map(at), r.impact(at), r.flows(at)]);
      return { map, impact, flows };
    }, (v: any) => (v?.map as any)?.state === 'error' && (v?.impact as any)?.state === 'error'),
    section('oneonone', () => r.oneonone(), (v: any) => emptyArr(v?.groups as FolderGroup[] | undefined)),
    section('reviewNotes', () => r.reviewNotes(), (v: any) => emptyArr(v?.drafts) && !v?.diagramSvg),
  ]);
  // T62: built outside section(): its three parts fail independently, so the section status is derived from them
  const reasoning = reasoningSection(await reasoningP);

  // a section whose runner reported a clean "not applicable here" (e.g. not a git repo) reads as one
  // friendly line, same shape as a thrown error, so the view never special-cases it
  for (const s of [decisions, pastFixes, notes, since, questions, tests, agents, blastRadius, oneonone, reviewNotes] as Section<any>[]) {
    if (s.status === 'ok' && (s.data as any)?.state === 'error') {
      s.status = 'unavailable';
      s.message = toMessage((s.data as any).message ?? 'not available here');
    }
  }

  return {
    file: target.file,
    line: target.line,
    symbol: target.symbol,
    generatedAt: Date.now(),
    cacheHit: false,
    sections: { decisions, pastFixes, notes, since, questions, tests, agents, blastRadius, oneonone, reviewNotes, reasoning },
  };
}
