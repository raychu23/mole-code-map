// Types of the decision graph (T29).

export type Flag = 'red' | 'yellow' | 'green' | 'grey';
// 'argument' (T48): an Argdown statement or argument title, loaded by src/argdown/*.
export type NodeKind = 'tenet' | 'decision' | 'intent' | 'incident' | 'argument';
export type RecordFormat = 'mole' | 'tenets' | 'nygard' | 'backstage' | 'speckit' | 'argdown';
// T48 (core-audit capture-records-schema.md rank 1; Argdown RelationType + AIF RA/CA split):
// 'supports' | 'attacks' | 'undercuts' are argumentation relations between 'argument' nodes,
// borrowed from Argdown's model.ts RelationType (SUPPORT/ATTACK/UNDERCUT). Two readings are
// pinned deliberately, per the consolidation-semantics memo ((internal reference removed)
// system-design/research/consolidation-semantics/memo.md):
//   - 'undercuts' uses the general Pollock/ASPIC+ reading (an edge attacks the inference link,
//     not the narrower Carneades/CAES "argument pro an exception" reading, memo §4.2) -- Mole's
//     reasoning engine (packages/reasoning) has no structured-argument/inference-step model, so
//     at evaluation time an 'undercuts' edge is collapsed to a plain Dung 'attack' between the
//     two abstract arguments (memo §4.1: "a graph fed to a Dung reasoner must already be
//     collapsed to single attack edges" -- this is that collapse, done once, here).
//   - 'supports' is recorded in the graph (for display and for the Argdown round trip) but is
//     NOT fed into packages/reasoning's evaluate(): plain Dung AFs have no support relation at
//     all (memo §4.3; Framework only takes `attacks`), and building a bipolar semantics
//     (Cayrol/Lagasquie-Schiex's supported/mediated attack, or any of TweetyProject's bipolar
//     readings) is out of this task's scope (T48 boundary) and memo §6 step 5/8's own flagged
//     follow-up -- grounded evaluation of Mole's reasoning graphs ignores 'supports' edges.
export type EdgeType =
  | 'traces_to'
  | 'supersedes'
  | 'overrides'
  | 'amends'
  | 'constrains'
  | 'forbids'
  | 'enables'
  | 'subsumes'
  | 'conflicts_with'
  | 'comprises'
  | 'alternative_to'
  | 'cites'
  | 'applies_to'
  | 'evidence_for'
  | 'supports'
  | 'attacks'
  | 'undercuts';

/** Where something is written: repo-relative file + 1-based line. */
export interface Loc {
  file: string;
  line: number;
}

export interface Anchor extends Loc {
  target: string; // 'path', 'path#Symbol' or 'folder/'
}

export interface EvidenceRef extends Loc {
  test?: string; // 'path#test name'
  incident?: string;
}

export interface GraphNode extends Loc {
  id: string;
  kind: NodeKind;
  title: string;
  status: string; // normalized: accepted | proposed | superseded | deprecated | rejected | partly-superseded | unknown
  statusText?: string;
  format: RecordFormat;
  door?: string;
  approver?: string;
  confirmed?: string;
  source?: string;
  retired?: boolean;
  scope: Anchor[];
  evidence: EvidenceRef[];
  /** 1-based line of each front matter key (or Status section) in the record file */
  fields: Record<string, number>;
  /** argument nodes: every Argdown definition (file, line, text after the colon), from the parser itself (T60) */
  definitions?: Array<{ file: string; line: number; text: string }>;
}

export interface GraphEdge extends Loc {
  from: string;
  to: string;
  type: EdgeType;
}

export interface Problem extends Loc {
  message: string;
}

export interface DecisionGraph {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  problems: Problem[];
}

export interface LoadOptions {
  /** plain ADR folders (Nygard / adr-tools / backstage), repo-relative or absolute */
  adrDirs?: string[];
}

export interface Reason extends Loc {
  flag: 'red' | 'yellow';
  code: string;
  text: string;
  by?: string; // the record that caused it, when another record did
}

export interface FlagResult extends Loc {
  id: string;
  kind: NodeKind;
  title: string;
  status: string;
  flag: Flag;
  reasons: Reason[];
  /** T43: the record's full Decision + Context/Rationale + Consequences text (MADR/Nygard section names),
   * bounded by rationale.ts's RATIONALE_BUDGET with section-aware truncation. Undefined when the record's
   * file could not be read, or has no decision-bearing content at all (a tenet/intent/incident node, or an
   * empty record). This is in ADDITION to the tree view's summaryOf() 240-char preview, never a replacement. */
  rationale?: string;
}

export interface FlagContext {
  /** vitest JSON report file (path) or its parsed content */
  testReport?: string | unknown;
}

export interface DecisionsResult {
  root: string;
  decisions: FlagResult[];
  problems: Problem[];
}

// T78 (D65): per-link assurance on `door: one-way` decisions only. 'door' itself stays the explicit,
// human-authored front-matter string it always was (types.ts GraphNode.door) -- see
// (internal reference removed) log/prior-art.md: Mole has no door classifier to trust (0 lines of
// inference code; 0/146 real vendored ADRs carry a door field at all), so assurance never infers door-ness.
export type DoubtType = 'rebutting' | 'undermining' | 'undercutting'; // ASPIC+ (Modgil & Prakken 2014) attack kinds
export type Provenance = 'person' | 'compiler' | 'model';
// FDA 2018 "Data Integrity and Compliance With Drug CGMP" + MHRA 2018 "'GXP' Data Integrity Guidance":
// ALCOA (attributable, legible, contemporaneous, original, accurate) + Complete, Consistent, Enduring, Available.
export const ALCOA_PLUS_ATTRS = ['attributable', 'legible', 'contemporaneous', 'original', 'accurate', 'complete', 'consistent', 'enduring', 'available'] as const;
export type AlcoaAttr = (typeof ALCOA_PLUS_ATTRS)[number];

/** One per-link doubt/provenance/re-verification record, written by a person into a decision record's
 * `assurance:` front-matter list (one item per linked target `to`). Never inferred. */
export interface AssuranceLink extends Loc {
  to: string; // the linked decision/record id this entry's doubt+provenance applies to
  doubt?: DoubtType;
  provenance?: Provenance;
  author?: string;
  approver?: string;
  /** the subset of ALCOA_PLUS_ATTRS the author attests is satisfied for this link */
  alcoa: AlcoaAttr[];
  reverifyBy?: string; // YYYY-MM-DD
}

export interface AssuranceOverdue {
  decisionId: string;
  to: string;
  reverifyBy: string;
  file: string;
  line: number;
}

/** One rejected `assurance:` entry field: an unrecognized doubt/provenance value, a `reverify_by` that
 * is not a real ISO calendar date, or an entry with no `to` at all (field: 'to'). The link it belongs to
 * (when it has a `to`) is always unassured -- an invalid value never silently counts as present. */
export interface AssuranceMalformed {
  decisionId: string;
  to: string; // '(missing)' when the entry itself has no `to`
  field: string;
  value: string;
  reason: string;
  file: string;
  line: number;
}

export interface AssuranceFolder {
  folder: string;
  oneWayDoors: number; // decision records with door: one-way in this folder
  links: number; // assurance slots: one per assurance: item, or 1 unassured slot per door with none
  assured: number;
  assuredShare: number; // assured / links, 0 when links === 0
  overdue: AssuranceOverdue[];
}

export interface AssuranceReport {
  root: string;
  generatedAt: string;
  folders: AssuranceFolder[];
  totalOneWayDoors: number;
  totalLinks: number;
  totalAssured: number;
  assuredShare: number;
  /** rejected assurance field values across the whole report (not duplicated per folder, even when a
   * decision governs several folders -- each malformed field is one source entry, reported once). */
  malformed: AssuranceMalformed[];
}

// T81 (D66): outcome tracking log -- a decision record may carry a `prediction:` (what is expected, how it will be
// measured, and when to check) and later an `outcome:` (what was actually observed). A `rollout:` block names a
// staged rollout's treated and holdout scopes -- recording only, no assignment logic (D66: "staggered rollout +
// 1 holdout folder"). Like `door` (T78), every field here is human-authored and never inferred by Mole.
export type OutcomeResult = 'confirmed' | 'contradicted' | 'inconclusive'; // the human's own verdict, never inferred

/** `prediction:` front matter on a decision record. */
export interface Prediction extends Loc {
  expected: string; // the expected outcome, in the author's own words
  signal: string; // the measurable signal that will tell them
  checkAt?: string; // YYYY-MM-DD: when to check it (rejected -> undefined, see OutcomeMalformed)
}

/** `outcome:` front matter recorded later, once checked. */
export interface Outcome extends Loc {
  observed: string; // what was actually observed
  date?: string; // YYYY-MM-DD: when it was recorded (rejected -> undefined)
  who?: string; // who recorded it
  result?: OutcomeResult; // the human's verdict against the prediction (rejected -> undefined)
}

/** `rollout:` front matter: a staged rollout's two named scopes. Recording only -- Mole assigns nothing. */
export interface Rollout extends Loc {
  treated: string;
  holdout: string;
}

/** One rejected `prediction:`/`outcome:`/`rollout:` field value: not silently dropped (same convention as
 * AssuranceMalformed) -- reported with the value that was rejected and why, with the decision it belongs to. */
export interface OutcomeMalformed {
  decisionId: string;
  block: 'prediction' | 'outcome' | 'rollout';
  field: string;
  value: string;
  reason: string;
  file: string;
  line: number;
}

/** One decision record with an opt-in `prediction:` block, its outcome (if recorded yet) and rollout (if any). */
export interface OutcomeEntry {
  decisionId: string;
  title: string;
  file: string;
  line: number;
  prediction: Prediction;
  outcome?: Outcome;
  rollout?: Rollout;
  /** no outcome yet and checkAt <= today */
  due: boolean;
  /** no outcome yet and checkAt < today */
  overdue: boolean;
  daysOverdue?: number;
  /** outcome.result === 'contradicted' -- the human's own verdict, read as-is, never computed from text */
  contradicts: boolean;
  /** T58 T81: present only when contradicts is true. A draft incident record (same front-matter shape
   * `readIncident` in incidents/revive.ts already parses) for a PERSON to review and save -- never written to
   * disk by this report, never accepted automatically. Saving it is the person's act; from there the existing
   * `mole incident suggest/accept/dismiss` (T58) flow applies unchanged. */
  suggestedIncident?: { title: string; decisions: string[]; draft: string };
}

export interface OutcomesReport {
  root: string;
  generatedAt: string;
  entries: OutcomeEntry[];
  malformed: OutcomeMalformed[];
}
