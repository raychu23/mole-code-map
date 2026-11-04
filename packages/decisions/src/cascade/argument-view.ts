// T54: builds the escalation tier's judge-facing view of a decision's text from its OWN derived argument
// chain (deriveAdrArgumentFramework, src/argdown/derive-adr.ts) evaluated with packages/reasoning's grounded
// semantics (T42) -- "the engine's labels for the decision's arguments, used in the judge prompt" (done-when
// #3). A record with no `## Considered Options`/`## Decision Outcome` structure degrades to its plain text,
// unchanged (see derive-adr.ts's own fallback), so this is additive: it only adds structure where the ADR's
// own headings give it something real to add, never invents content a plain record didn't have.
import { evaluate, type Label } from '@mole/reasoning';
import { deriveAdrArgumentFramework } from '../argdown/derive-adr.js';

export interface ArgumentChainView {
  /** judge-facing text: DECISION + any REJECTED/UNRESOLVED ALTERNATIVE blocks + CONSEQUENCES, in that order. */
  text: string;
  /** every derived argument's grounded-semantics label, keyed by its derive-adr.ts id (`${decisionId}::claim`,
   *  `${decisionId}::option:N`, `${decisionId}::reason:N`) -- what CascadeVerdict.argumentLabels reports. */
  labels: Record<string, Label>;
  claimId: string;
}

/** `decisionId` + the decision's own full record/ADR text (front matter included -- sectionsOf strips it). */
export function argumentChainView(decisionId: string, adrText: string): ArgumentChainView {
  const derived = deriveAdrArgumentFramework(decisionId, adrText);
  const result = evaluate(derived.framework);
  const labels: Record<string, Label> = {};
  for (const id of derived.framework.args.map((a) => a.id)) labels[id] = result.labels[id] ?? 'undecided';

  const claim = derived.arguments.find((a) => a.id === derived.claimId)!;
  const parts: string[] = [`DECISION: ${claim.text}`];
  if (derived.context) {
    // ALWAYS carried through, unconditionally, right after the claim -- dropping it was the T54 dev-run
    // regression (recall 0.91 -> 0.82 on M2 v2 dev, see `2 insights.md`): the raw decisionText this view
    // replaces was the record's FULL text (Context included), and the judge used that Context prose for
    // some verdicts. The argument-engine blocks below are additive annotations, never a replacement for it.
    parts.push(`CONTEXT: ${derived.context}`);
  }

  const options = derived.arguments.filter((a) => a.role === 'considered-option');
  const defeated = options.filter((o) => labels[o.id] === 'out');
  const standing = options.filter((o) => labels[o.id] !== 'out');
  if (defeated.length) {
    parts.push(['REJECTED ALTERNATIVES (considered, defeated by a stated reason in this record -- settled, do not re-raise):', ...defeated.map((o) => `- ${o.text}`)].join('\n'));
  }
  if (standing.length) {
    parts.push(
      [
        "UNRESOLVED ALTERNATIVES (considered in this record, but no stated reason here defeats them -- the record's own argument chain does not settle this; judge the change against the decision as written, do not treat the decision as void):",
        ...standing.map((o) => `- ${o.text}`),
      ].join('\n'),
    );
  }
  if (derived.consequences) {
    parts.push(`CONSEQUENCES (descriptive, not argument-evaluated): ${derived.consequences}`);
  }

  return { text: parts.join('\n\n'), labels, claimId: derived.claimId };
}
