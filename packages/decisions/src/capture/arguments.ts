// T80: contestable AI-drafted arguments captured from a decision record's own MADR structure (Considered
// Options + Pros and Cons of the Options), each with its exact source span (W3C Web Annotation
// TextQuoteSelector style: file + line/char range + the quoted text itself -- prior-art.md #1) and
// provenance (`Provenance` from types.ts: 'person' | 'compiler' | 'model' -- this module's extraction is
// always 'compiler', deterministic, no model call, per the task's own contract). A captured argument is
// `draft` until a person approves it (store.ts's `approveCapturedArgument`); drafts are never turned into
// a graph node (captured-loader.ts), so they can never reach packages/reasoning's evaluate() (prior-art.md
// design choice #1).
//
// Deliberately NOT a parallel store: this extends T54's `deriveAdrArgumentFramework` (claim/
// considered-option/reason, already built and tested) by adding spans on top of its own output, and adds
// ONE new deterministic parse (Pros and Cons of the Options -- T54 never read that section, prior-art.md
// #3) in the same file, rather than re-deriving the Considered-Options/Decision-Outcome structure a second
// time.
import { deriveAdrArgumentFramework, findChosenOptionName, optionNameOf, sameName } from '../argdown/derive-adr.js';
import type { Provenance } from '../types.js';

export type ArgumentRole = 'claim' | 'considered-option' | 'reason' | 'pro' | 'con';
export type ArgumentStatus = 'draft' | 'approved' | 'rejected';

/** W3C Web Annotation Data Model TextQuoteSelector shape (prior-art.md #1), plus the file + 1-based
 *  line / 0-based char range a person needs to re-find the exact quote while hand-checking a span. */
export interface TextQuoteSpan {
  file: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
}

export interface ArgumentProvenance {
  source: Provenance;
  /** e.g. 'mole-derive-adr' / 'mole-derive-adr-pros-cons' (compiler), or a model name -- never required to
   *  be a person's name; `approvedBy` on the row itself is where the approving PERSON is recorded. */
  detail?: string;
}

export interface CapturedArgument {
  id: string;
  decisionId: string;
  role: ArgumentRole;
  /** verbatim text at the span (same string as span.exact, kept alongside it for display without having
   *  to re-read the span back out of the quote). */
  text: string;
  span: TextQuoteSpan;
  /** ids of OTHER captured arguments (within the same decision) this one attacks -- fed into
   *  packages/reasoning's Framework once approved (captured-loader.ts), never before. */
  attacks: string[];
  /** ids this one supports -- display only, never fed into evaluate() (same T48 rule framework.ts already
   *  applies to hand-authored Argdown `supports` edges: a plain Dung AF has no support relation). */
  supports: string[];
  provenance: ArgumentProvenance;
  status: ArgumentStatus;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  rejectedAt?: string;
  /** review HIGH 1: content identity (sha256 of `role::text`), set by captured-store.ts on every save --
   *  what an approval/rejection actually binds to, never this row's positional id (`::pro:N`), which shifts
   *  whenever a bullet is inserted/removed/reordered above it. Optional here because a freshly-extracted
   *  row (captureAdrArguments' own output, never yet saved) does not have one until the store computes it. */
  contentHash?: string;
  /** review HIGH 1: set by captured-store.ts when a re-capture finds this id's text has changed since it
   *  was approved -- the row goes back to `draft` (a person must re-review the NEW text) but this flag (plus
   *  previouslyApprovedBy/At below) keeps a visible record that it once was approved, rather than silently
   *  looking like a row nobody has ever reviewed. */
  previouslyApproved?: boolean;
  previouslyApprovedBy?: string;
  previouslyApprovedAt?: string;
  /** review 2 NEW HIGH (D-attack): the contentHash captured AT THE MOMENT of approval -- set only by
   *  approveCapturedArgument, carried forward by mergeByContent only when a re-capture's fresh hash still
   *  matches (case 1, nothing changed). A status of 'approved' whose approvedHash no longer equals the
   *  row's current contentHash is exactly the bug this field exists to make detectable: it means some path
   *  carried an approval forward onto content (text OR attack/support targets) nobody actually reviewed. */
  approvedHash?: string;
  /** review 3 structural fix: the NORMALIZED NAME of every id in `attacks`, in the SAME order -- 'claim'
   *  for the claim, or the considered-option's own name (never its positional `::option:N` id, which a
   *  later re-capture can silently reassign to an UNRELATED argument). captured-loader.ts resolves every
   *  approved row's edges by these names against the CURRENT (non-stale) capture batch, never by trusting
   *  `attacks` itself -- the root cause of every review round on this task is that a stored positional id,
   *  once written, is never re-validated against what it currently points at. Always set when `attacks` is
   *  non-empty (and the role has a resolvable target); undefined/omitted only for rows with no attack. */
  attacksNames?: string[];
  /** Same as `attacksNames`, for `supports`. */
  supportsNames?: string[];
  /** review 3 HIGH 1 (name collision): set when this row's attack/support target could not be resolved
   *  because two considered options in the record normalize to the SAME name (e.g. "Option A" / "Option
   *  A.") -- naming BOTH options, rather than guessing (last-write-wins) which one a Pros-and-Cons bullet
   *  meant. The row itself is still captured (text/span intact, approvable as TEXT) but `attacks`/
   *  `supports` are forced empty until the record's own option names are disambiguated. */
  ambiguousTarget?: string;
  /** review 3 HIGH 2 (stale rows): set by captured-store.ts's `mergeByContent` on a row no fresh capture
   *  claimed (deleted/renamed-beyond-recognition from the source) -- history only, append-only, never
   *  dropped, but NEVER a graph node or edge (captured-loader.ts skips every stale row outright) and
   *  approve/reject refuse to act on it (setRow) with a clear message. A row's positional id is NOT a
   *  reliable way to tell stale apart from current (a later capture can reissue the same id for an
   *  unrelated argument) -- this explicit flag is the source of truth. */
  stale?: boolean;
}

const BULLET_LINE = /^(\s*[-*]\s+)(.*)$/;
const PROS_CONS_HEADING = /^##\s+pros and cons of the options\s*$/i;
const NEXT_H2 = /^##\s+/;
const SUBHEADING = /^###\s+(.+?)\s*$/;
const GOOD_BAD = /^(Good|Bad|OK|Neutral)\b[,:]?\s*(.*)$/i;

function spanAt(file: string, rawLines: string[], lineIdx: number, exact: string, startChar: number): TextQuoteSpan {
  const raw = rawLines[lineIdx] ?? '';
  const endChar = startChar + exact.length;
  const prefix = raw.slice(Math.max(0, startChar - 24), startChar);
  const suffix = raw.slice(endChar, endChar + 24);
  return { file, exact, prefix: prefix || undefined, suffix: suffix || undefined, startLine: lineIdx + 1, endLine: lineIdx + 1, startChar, endChar };
}

/** The first bullet line (`- text` / `* text`) whose content, trimmed, is EXACTLY `text` -- never a fuzzy
 *  or normalized match: a span must quote the record verbatim, so a bullet that wraps across lines or was
 *  otherwise cleaned up before reaching this function (derive-adr.ts's continuation-joining) legitimately
 *  has no single-line span here, and callers skip it rather than inventing one (prior-art.md design
 *  choice #2's same rule: never fabricate what cannot be found verbatim). */
function locateBulletLine(rawLines: string[], file: string, text: string): TextQuoteSpan | undefined {
  const want = text.trim();
  for (let i = 0; i < rawLines.length; i++) {
    const m = BULLET_LINE.exec(rawLines[i] ?? '');
    if (!m) continue;
    if (m[2]!.trim() !== want) continue;
    return spanAt(file, rawLines, i, want, m[1]!.length);
  }
  return undefined;
}

/** The first line containing "chosen option:" (case-insensitive) -- the claim's own span. */
function locateChosenLine(rawLines: string[], file: string): TextQuoteSpan | undefined {
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    if (!/chosen option:/i.test(raw)) continue;
    const exact = raw.trim();
    return spanAt(file, rawLines, i, exact, raw.indexOf(exact));
  }
  return undefined;
}

/** `## Pros and Cons of the Options` -> one `### <option>` subsection per considered option -> `- Good,
 *  because ...` / `- Bad, because ...` bullets (MADR's own shape, prior-art.md #3). Each bullet becomes a
 *  'pro' (Good/OK/Neutral) or 'con' (Bad) argument; a con ATTACKS the option its subsection names (ASPIC+
 *  rebutting reading, same attack direction T54 already uses for "reason attacks rejected option" --
 *  prior-art.md design choice #2), a pro SUPPORTS it (display only, T48's existing supports rule). A
 *  subsection whose option has no id in `optionIdByName` (the CHOSEN option: derive-adr.ts deliberately
 *  never turns it into a graph argument) still gets captured arguments, just with an empty attacks/
 *  supports list -- never a fabricated target.
 *
 *  review 3 HIGH 1: `optionIdByName` is necessarily last-write-wins for a NAME that two considered options
 *  share once normalized (e.g. "Option A" / "Option A.") -- there is no correct single id to pick, so a
 *  subsection whose heading normalizes to an ambiguous name (`ambiguousNames`, built by the caller from
 *  every considered option sharing that name) never resolves a target at all: its pros/cons are still
 *  captured as rows (approvable as TEXT) but with `attacks`/`supports` forced empty and `ambiguousTarget`
 *  naming every option the heading could have meant, rather than silently attacking/supporting whichever
 *  option happened to be last into the map. */
const FENCE = /^\s*```/;

function extractProsCons(decisionId: string, file: string, rawLines: string[], optionIdByName: Map<string, string>, ambiguousNames: Map<string, string[]>): CapturedArgument[] {
  const startIdx = rawLines.findIndex((l) => PROS_CONS_HEADING.test(l.trim()));
  if (startIdx === -1) return [];
  // real MADR records embed ```markdown example fences showing headings/bullets AS ILLUSTRATION TEXT
  // (e.g. m29-madr's own 0016 ADR, read in full for prior-art.md #3) -- a heading/bullet line found
  // inside a fence is example prose, not document structure, so both the end-of-section search and the
  // bullet scan below must skip fenced spans entirely rather than stopping/matching on their contents.
  let end = rawLines.length;
  let fenced = false;
  for (let i = startIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i] ?? '';
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (NEXT_H2.test(line)) {
      end = i;
      break;
    }
  }
  const out: CapturedArgument[] = [];
  let currentOptionId: string | undefined;
  let currentOptionName: string | undefined;
  let currentAmbiguous: string | undefined;
  let proN = 0;
  let conN = 0;
  let inFence = false;
  for (let i = startIdx + 1; i < end; i++) {
    const raw = rawLines[i] ?? '';
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const sub = SUBHEADING.exec(raw.trim());
    if (sub) {
      const norm = sameName(optionNameOf(sub[1]!));
      const dup = ambiguousNames.get(norm);
      if (dup && dup.length > 1) {
        currentOptionId = undefined;
        currentOptionName = undefined;
        currentAmbiguous = `ambiguous considered-option name "${norm}": matches both ${dup.map((t) => `"${t}"`).join(' and ')} -- the Pros-and-Cons subsection's target cannot be resolved until the record's own option names are disambiguated`;
      } else {
        currentOptionId = optionIdByName.get(norm);
        currentOptionName = norm;
        currentAmbiguous = undefined;
      }
      continue;
    }
    const bullet = BULLET_LINE.exec(raw);
    if (!bullet) continue;
    const content = bullet[2]!.trim();
    const kind = GOOD_BAD.exec(content);
    if (!kind) continue;
    const role: ArgumentRole = kind[1]!.toLowerCase() === 'bad' ? 'con' : 'pro';
    const startChar = bullet[1]!.length;
    const n = role === 'pro' ? ++proN : ++conN;
    const hasTarget = !currentAmbiguous && currentOptionId !== undefined;
    out.push({
      id: `${decisionId}::${role}:${n}`,
      decisionId,
      role,
      text: content,
      span: spanAt(file, rawLines, i, content, startChar),
      attacks: role === 'con' && hasTarget ? [currentOptionId!] : [],
      attacksNames: role === 'con' && hasTarget ? [currentOptionName!] : [],
      supports: role === 'pro' && hasTarget ? [currentOptionId!] : [],
      supportsNames: role === 'pro' && hasTarget ? [currentOptionName!] : [],
      ambiguousTarget: currentAmbiguous,
      provenance: { source: 'compiler', detail: 'mole-derive-adr-pros-cons' },
      status: 'draft',
    });
  }
  return out;
}

/** Deterministic extraction (no model, prior-art.md's own gate): one `CapturedArgument` per claim /
 *  considered-option / reason that T54's `deriveAdrArgumentFramework` already derives (span added on top,
 *  by re-finding its exact text as a literal line in `adrText`), plus one per Pros-and-Cons bullet
 *  (`extractProsCons`, new to T80). Every row starts life `status: 'draft'` -- a person must approve it
 *  (store.ts) before it can affect anything packages/reasoning evaluates. */
export function captureAdrArguments(decisionId: string, file: string, adrText: string): CapturedArgument[] {
  const derived = deriveAdrArgumentFramework(decisionId, adrText);
  const rawLines = adrText.split(/\r?\n/);
  const out: CapturedArgument[] = [];
  const optionIdByName = new Map<string, string>();
  // review 3 HIGH 1: track EVERY raw text that normalizes to a given name, not just the last id written --
  // `optionIdByName` must stay last-write-wins deterministic for lookups, but a name with >1 entry here is
  // ambiguous and extractProsCons must refuse to pick either option rather than silently attacking/
  // supporting whichever one happened to win the map.
  const optionTextsByName = new Map<string, string[]>();
  const byId = new Map(derived.arguments.map((a) => [a.id, a]));
  // review HIGH 2: an independent, defensive re-check -- the record's own chosen option is never emitted as
  // an attacker of the claim, even if deriveAdrArgumentFramework's own chosenIdx exclusion (derive-adr.ts)
  // ever regresses. Computed once per adrText; undefined (no "Chosen option:" line) disables the guard.
  const chosenName = findChosenOptionName(adrText);
  // review 3 structural fix: the display NAME of an attack/support target -- 'claim' for the claim, else
  // the considered-option's own normalized name. Never the target's positional id: that is exactly what a
  // later re-capture can reassign to an unrelated argument (the root cause behind every review round here).
  const nameOf = (id: string): string => {
    if (id === derived.claimId) return 'claim';
    const target = byId.get(id);
    if (!target) return id; // unresolvable within this batch -- fall back, never throw
    return sameName(target.role === 'considered-option' ? optionNameOf(target.text) : target.text);
  };
  for (const a of derived.arguments) {
    if (a.role === 'considered-option') {
      // review 4 MEDIUM: key by the bare option NAME (`**Use a database** - adds ...` -> "use a database"), the
      // same formula nameOf() and the Pros-and-Cons subsection heading use -- full-text keys never matched a
      // decorated MADR bullet, so its pros/cons silently got no target
      const norm = sameName(optionNameOf(a.text));
      if (!optionIdByName.has(norm)) optionIdByName.set(norm, a.id);
      const texts = optionTextsByName.get(norm) ?? [];
      texts.push(a.text);
      optionTextsByName.set(norm, texts);
    }
    const span = a.role === 'claim' ? locateChosenLine(rawLines, file) : locateBulletLine(rawLines, file, a.text);
    if (!span) continue; // never fabricate a span for text we cannot find verbatim (prior-art.md #2)
    const isChosen = a.role === 'considered-option' && chosenName !== undefined && sameName(optionNameOf(a.text)) === chosenName;
    const attacks = isChosen
      ? derived.framework.attacks.filter(([from]) => from === a.id).map(([, to]) => to).filter((to) => to !== derived.claimId)
      : derived.framework.attacks.filter(([from]) => from === a.id).map(([, to]) => to);
    out.push({
      id: a.id,
      decisionId,
      role: a.role,
      text: a.text,
      span,
      attacks,
      attacksNames: attacks.map(nameOf),
      supports: [],
      provenance: { source: 'compiler', detail: 'mole-derive-adr' },
      status: 'draft',
    });
  }
  const ambiguousNames = new Map<string, string[]>();
  for (const [norm, texts] of optionTextsByName) if (texts.length > 1) ambiguousNames.set(norm, texts);
  out.push(...extractProsCons(decisionId, file, rawLines, optionIdByName, ambiguousNames));
  return out;
}
