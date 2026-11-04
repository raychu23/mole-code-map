// T53: a decision's BM25 index text and one-line summary -- built from rationale.ts's own section extraction
// (sectionsOf/formatSections) and the tree view's existing summaryOf(), never duplicating that parsing logic.
import { sectionsOf, formatSections } from '../rationale.js';
import { summaryOf } from '../tree/core.js';

/** Index text budget, in characters. Deliberately far below rationale.ts's own RATIONALE_BUDGET (4000): this
 *  text is for BM25 ranking (lexical overlap), not for giving a model the record to read -- title + a one-line
 *  summary + a clipped slice of the Decision/Context/Consequences sections carries plenty of ranking signal
 *  without approaching the RAG arm's "send the whole decision" cost. */
export const INDEX_TEXT_BUDGET = 600;

/** Title (repeated -- its own words are usually the strongest lexical signal a change is "about" this decision)
 *  + the first-paragraph summary + a budget-clipped slice of rationale.ts's Decision/Context/Consequences
 *  sections. `fullText` is the record's raw file text (front matter + body), same input rationale.ts takes. */
export function indexTextOf(title: string, fullText: string, budget: number = INDEX_TEXT_BUDGET): string {
  const summary = summaryOf(fullText) ?? '';
  const sections = formatSections(sectionsOf(fullText), budget);
  return [title, title, summary, sections].filter(Boolean).join('\n');
}

/** A short single line for the stage-2 listwise LLM prompt (never the index text or the full record -- that
 *  prompt must carry candidate SUMMARIES only, not their full text). Falls back to the title when the record
 *  has no `## Decision` first paragraph (summaryOf returns undefined) or no text at all. */
export function oneLineSummaryOf(title: string, fullText: string): string {
  const summary = summaryOf(fullText);
  const line = (summary ?? title).replace(/\s+/g, ' ').trim();
  return line.length <= 180 ? line : `${line.slice(0, 179)}…`;
}
