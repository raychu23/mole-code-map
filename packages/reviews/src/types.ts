// T40: capture (Granola model) -- a person's sparse notes expand only around what they flagged, into decision
// DRAFTS pinned to the function/file named (D38: never invent). "Flagged" lines are the ones a person actually
// wrote a decision on (DECIDED:/AGREED:/DECISION:); every other line in the note is read but never turned into a
// draft, however decision-shaped it sounds.
export type SectionId = never;

export interface DraftDecision {
  /** the raw line number (1-based) of the flagged note line this draft came from */
  line: number;
  /** true for a DECIDED:/AGREED:/DECISION: line; false drafts are never produced -- kept only for completeness in tests */
  flagged: boolean;
  /** the flagged line's text, trimmed of its leading marker */
  title: string;
  /** 'path' or 'path#tail' when a candidate in the note resolved to real code; null when nothing did (D38: no guess) */
  anchor: string | null;
  /** every candidate the note text offered, whether or not it resolved -- so a human reviewer can see what was considered */
  candidates: string[];
}
