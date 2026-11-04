// T54: derive a plain Dung argument framework from an ADR's OWN MADR/Nygard sections, for the (real,
// bench-corpus-wide) case where no hand-authored `.mole/arguments/*.argdown` file exists for a decision --
// T48's `argumentFramework()` has nothing to load there, so wiring packages/reasoning (T42) into the check
// path for THAT corpus needs a second, rule-derived source of Framework args/attacks. Evaluated with the
// SAME grounded evaluator T48 already wires through (`@mole/reasoning`'s `evaluate()`), never a second
// semantics -- see (internal reference removed) log/prior-art.md for the design choice and what was rejected.
//
// Two-level shape, borrowed directly from MADR's own headings (prior-art.md #4; IBIS Position/Argument;
// ASPIC+ rebutting attack): a `## Considered Options` entry other than the chosen one is a counter-Position
// that ATTACKS the claim; a stated reason in `## Decision Outcome`'s "Chosen option: X, because <bullets>"
// ATTACKS each non-chosen considered option back, defending the claim. `## Consequences` is deliberately NOT
// fed into the evaluated attack graph (prior-art.md's rejected option (b): almost every real ADR documents
// SOME trade-off, so attacking the claim with it would defeat the claim on nearly every record -- a trivial,
// non-discriminative use of grounded semantics) -- it is carried through for display only.
import type { Framework } from '@mole/reasoning';
import { sectionsOf } from '../rationale.js';

export type AdrArgumentRole = 'claim' | 'considered-option' | 'reason';

export interface AdrArgument {
  id: string;
  role: AdrArgumentRole;
  text: string;
}

export interface AdrArgumentFramework {
  framework: Framework;
  claimId: string;
  arguments: AdrArgument[];
  /** `## Context`/`## Rationale`/`## Decision Drivers` text (rationale.ts's `sectionsOf` context bucket),
   *  descriptive only -- never an id in `framework.args`. Always carried through (never dropped): the raw
   *  ADR text a caller had before T54 included this prose, and losing it to only show Decision+Consequences
   *  is exactly the regression the M2 v2 dev run caught (see `2 insights.md`). */
  context?: string;
  /** `## Consequences` text, descriptive only -- never an id in `framework.args`, never attacked/attacking. */
  consequences?: string;
}

const CONSIDERED_OPTIONS_HEADING = /^#{2,3}\s+considered options\s*$/i;
const DECISION_OUTCOME_HEADING = /^#{2,3}\s+decision outcome\s*$/i;
// Quoted names may wrap across lines and contain commas (python-tuf 0002/0008); unquoted names stop at a comma/newline.
// "quoted" (may wrap, may hold commas) · **bold** · unquoted up to a comma, a sentence-ending period or the line end
// (review 2 P0: "Chosen option: Modern Python. We picked it because ..." used to swallow the whole sentence)
const CHOSEN_OPTION_LINE = /chosen option:\s*(?:"([^"]+)"|\*\*([^*]+)\*\*|([^",\n]+?)(?=,|\.(?:\s|$)|\n|$))/i;
const BULLET = /^\s*[-*]\s+(.*)$/;
const HEADING = /^#{2,3}\s+/;

/** The lines strictly between one `##`/`###` heading and the next (or EOF), trimmed. */
function headingSlice(text: string, headingRe: RegExp): string | undefined {
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => headingRe.test(l.trim()));
  if (startIdx === -1) return undefined;
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const body = lines.slice(startIdx + 1, end).join('\n').trim();
  return body || undefined;
}

/** Bullet items, joining markdown continuation lines (indented or lazy) until a blank line or the next bullet. */
function bulletsOf(block: string): string[] {
  const items: string[] = [];
  let open = false;
  for (const line of block.split(/\r?\n/)) {
    const m = BULLET.exec(line);
    if (m) {
      items.push(m[1] ?? '');
      open = true;
    } else if (open && line.trim() && !HEADING.test(line)) {
      items[items.length - 1] += ' ' + line.trim();
    } else {
      open = false;
    }
  }
  return items.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 0);
}

/** Compare option names ignoring wrapping whitespace, case, a trailing period, and EVERY quote kind MADR
 *  text uses to wrap an option name -- straight double ("), straight single ('), curly double (" "), curly
 *  single (' '), and backtick (`). Exported (T80): capture/arguments.ts matches a MADR `### <option>`
 *  Pros-and-Cons subheading back to the SAME considered-option id this module already derived, instead of
 *  re-implementing the comparison.
 *
 *  Review HIGH 2: stripping double/curly quotes but not single quotes let a real record's own chosen
 *  option escape exclusion -- m29-madr's 0015/0016 phrase the Decision Outcome's chosen name with single
 *  quotes nested inside the outer double quotes (`"Include 'Consulted' and 'Informed' of RACI"`) while the
 *  Considered Options bullet has no nesting (`"Include "Consulted" and "Informed" of RACI"` once its own
 *  wrapping quotes are stripped) -- the two normalized strings differed only by leftover `'`s, so
 *  `chosenIdx` below never matched and the chosen option came out as a considered-option attacking its own
 *  claim. Stripping every quote kind closes that (and the backtick case nothing here has hit yet). */
export function sameName(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/[`'"\u2018\u2019\u201c\u201d]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase();
}

/** The option "name" from a MADR bullet (`- **Name** -- why`, `- [Name](url) -- why`, or plain `- Name`):
 *  strip markdown emphasis/links, then take the lead phrase up to the first ` - `/` -- `/` – `/`:` separator.
 *  Exported (T80 review HIGH 2): capture/arguments.ts reuses this to re-derive an option's bare name from a
 *  considered-option argument's full bullet text, for its own defensive "never attack-the-claim with the
 *  chosen option" guard (findChosenOptionName below), instead of re-implementing the lead-phrase split. */
export function optionNameOf(bullet: string): string {
  const cleaned = bullet.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const m = /^(.*?)(\s+[-\u2013\u2014:]+\s+|$)/.exec(cleaned);
  return (m?.[1] ?? cleaned).trim();
}

/** The record's own chosen option, normalized by `sameName` -- the SAME value `deriveAdrArgumentFramework`
 *  uses internally to find `chosenIdx` and exclude that option from its considered-option attackers, now
 *  also exported (T80 review HIGH 2) so capture/arguments.ts can independently re-check, belt-and-suspenders,
 *  that no considered-option argument it emits attacks the claim with the chosen option's own text -- even
 *  if a future change to this exclusion logic ever regresses. `undefined` when no "Chosen option:" line is
 *  found (e.g. a record with no Decision Outcome section). */
export function findChosenOptionName(adrText: string): string | undefined {
  const outcomeBlock = headingSlice(adrText, DECISION_OUTCOME_HEADING) ?? sectionsOf(adrText).decision;
  const chosenMatch = outcomeBlock ? CHOSEN_OPTION_LINE.exec(outcomeBlock) : null;
  const chosenRaw = chosenMatch?.[1] ?? chosenMatch?.[2] ?? chosenMatch?.[3];
  return chosenRaw ? sameName(chosenRaw) : undefined;
}

/** Build the Dung framework + display arguments for one decision's ADR text. `decisionId` namespaces the
 *  derived argument ids so two decisions' frameworks never collide when a caller merges several. */
export function deriveAdrArgumentFramework(decisionId: string, adrText: string): AdrArgumentFramework {
  const sections = sectionsOf(adrText);
  const claimId = `${decisionId}::claim`;
  const claimText = (sections.decision ?? adrText).trim() || adrText.trim();
  const args: AdrArgument[] = [{ id: claimId, role: 'claim', text: claimText }];
  const attacks: [string, string][] = [];

  const consideredBlock = headingSlice(adrText, CONSIDERED_OPTIONS_HEADING);
  const outcomeBlock = headingSlice(adrText, DECISION_OUTCOME_HEADING) ?? sections.decision;
  const chosenMatch = outcomeBlock ? CHOSEN_OPTION_LINE.exec(outcomeBlock) : null;
  const chosenRaw = chosenMatch?.[1] ?? chosenMatch?.[2] ?? chosenMatch?.[3];
  const chosenName = chosenRaw ? sameName(chosenRaw) : undefined;

  const optionIds: string[] = [];
  if (consideredBlock) {
    const bullets = bulletsOf(consideredBlock);
    const names = bullets.map((b) => sameName(optionNameOf(b)));
    // the chosen option is not its own counter-argument: an exact name match first (two options can share a
    // prefix, "MADR 2.1.2" vs "MADR 2.1.2 with Log4brains patch"); only when none is exact, a bullet whose name
    // contains the chosen name or the reverse -- and only if exactly ONE bullet fits (review 2 P1, real log4brains
    // "Transition to Simplified Git Flow." vs **Simplified Git Flow**); otherwise no guess
    let chosenIdx = chosenName ? names.indexOf(chosenName) : -1;
    if (chosenName && chosenIdx === -1) {
      const fits = names.flatMap((nm, i) => (nm.includes(chosenName) || chosenName.includes(nm) ? [i] : []));
      if (fits.length === 1) chosenIdx = fits[0]!;
    }
    let n = 0;
    for (const [i, bullet] of bullets.entries()) {
      if (i === chosenIdx) continue;
      n += 1;
      const optId = `${decisionId}::option:${n}`;
      args.push({ id: optId, role: 'considered-option', text: bullet });
      attacks.push([optId, claimId]);
      optionIds.push(optId);
    }
  }

  if (outcomeBlock) {
    // reasons live after the "Chosen option: X, because" line when present, else the whole outcome block
    const reasonSource = chosenMatch ? outcomeBlock.slice(chosenMatch.index + chosenMatch[0].length) : outcomeBlock;
    const reasons = bulletsOf(reasonSource);
    // MADR also permits a plain-prose "because ..." paragraph. Without it,
    // an explicitly defended decision was incorrectly labelled undefended.
    if (reasons.length === 0) {
      // MADR's own slot only: "Chosen option: X, because …" / ". Because …" / ", since …" right after the choice, in
      // the paragraph that holds it (split BEFORE trimming, so a bare "because" + blank line never adopts the next
      // paragraph, review 1). By the template, that slot IS the justification of the chosen option.
      // NOT read (removed after reviews 3-5, 11-02): a "because" anywhere later in free prose. Each guard round found
      // new wordings ("the former", links, "i.e.", shortened names) where it handed a REJECTED option's praise to
      // the chosen one, and it rescued 0 of 20 real ADRs. Missing a reason leaves the claim undefended (visible to
      // the judge, who reads the full outcome text); a misattributed reason is silently wrong. A leading "to" is not
      // a reason either (review 2 P0); python-tuf 0004's purpose clause stays unread.
      const first = reasonSource.split(/\r?\n\s*\r?\n/, 1)[0] ?? '';
      const opening = /^\s*[,.]?\s*(?:because|since)\b([\s\S]*)/i.exec(first)?.[1];
      const paragraph = opening?.replace(/\s+/g, ' ').trim();
      if (paragraph) reasons.push(paragraph);
    }
    let n = 0;
    for (const bullet of reasons) {
      n += 1;
      const reasonId = `${decisionId}::reason:${n}`;
      args.push({ id: reasonId, role: 'reason', text: bullet });
      for (const optId of optionIds) attacks.push([reasonId, optId]);
    }
  }

  return {
    framework: { args: args.map((a) => ({ id: a.id })), attacks },
    claimId,
    arguments: args,
    context: sections.context,
    consequences: sections.consequences,
  };
}
