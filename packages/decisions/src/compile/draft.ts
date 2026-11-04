// Draft prompt + response parsing for compile-at-capture (T46). One LLM call per decision, at capture/import time
// (not at check time): the model reads the decision's OWN text (what a human captured or what the T36 ADR importer
// pulled in) and drafts crisp, code-inferable checks, per prior-art.md's SemOpt/RuleDroid reading (prefer a rule a
// diff alone can decide; leave the rest to the cascade's one-call LLM tier instead of a vaguer regex).
import type { CompiledDraft, LlmClient, MatchDraft, RuleDraft } from './types.js';

export interface DraftInput {
  id: string;
  title: string;
  recordFile: string;
  /** the decision's own Decision/Consequences text (the ADR body, or the record's own markdown body) */
  decisionText: string;
  existingScope: string[];
  existingMatch: MatchDraft[];
}

export function compilePrompt(input: DraftInput): string {
  return [
    'You are drafting machine-checkable rules for ONE architecture decision, to be run with NO model call at check',
    'time (a future PR either matches your rule or it does not). This decision may already have some rules; do not',
    'repeat them, only add what is missing.',
    '',
    `Decision id: ${input.id}`,
    `Title: ${input.title}`,
    `Existing scope (repo-relative path/glob/folder anchors already governing this decision): ${JSON.stringify(input.existingScope)}`,
    `Existing content-anchor patterns already on this decision: ${JSON.stringify(input.existingMatch)}`,
    '',
    '--- THE DECISION TEXT (verbatim) ---',
    input.decisionText,
    '--- END DECISION TEXT ---',
    '',
    'Draft additional checks that would catch a future code change VIOLATING this decision. Prefer a crisp,',
    'code-inferable signal (an exact import, a function call, an exact keyword like "export default") over a broad',
    'vocabulary match: a pattern that also matches code that COMPLIES with the decision is a false alarm waiting to',
    'happen, so keep patterns narrow and specific to the actual violating shape, not just words the decision uses.',
    'Where the decision clearly concerns a package or area the existing scope does not list (e.g. a barrel/index file',
    'that re-exports the governed symbols), add a scope entry for it so the decision is at least considered there,',
    'even if you cannot write a crisp pattern for it.',
    '',
    'Output EXACTLY one fenced json block and nothing else outside it, with this shape (omit a key or leave an array',
    'empty when you have nothing to add; never repeat an existing scope or match entry verbatim):',
    '```json',
    '{',
    '  "scope": ["<repo-relative path, glob, or folder/ to ADD to scope>"],',
    '  "match": [{"pattern": "<JS regex, anchored to the violating token/shape only>", "in": "<glob, optional>", "why": "<short quote from the decision text>"}],',
    '  "rules": [{"forbid": "import", "from": "<path/glob>", "to": ["<module or path>"], "except": ["<path>"], "why": "<short quote>"}],',
    '  "guardTests": ["<repo-relative test file path that exercises this decision, if the text names one>"]',
    '}',
    '```',
  ].join('\n');
}

function fencedJson(text: string): string | undefined {
  const m = /```json\s*([\s\S]*?)```/i.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
  return m?.[1]?.trim();
}

/** Never throws: a bad or unparsable draft becomes an empty draft, left `pending` for a person to reject — the
 *  compiler drafting garbage must never silently become a check nobody reviewed. */
export function parseDraftResponse(text: string): { scope: string[]; match: MatchDraft[]; rules: RuleDraft[]; guardTests: string[] } {
  const empty = { scope: [], match: [], rules: [], guardTests: [] };
  const block = fencedJson(text);
  if (!block) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const p = parsed as Record<string, unknown>;
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const match: MatchDraft[] = Array.isArray(p.match)
    ? p.match
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).pattern === 'string')
        .map((m) => ({ pattern: String(m.pattern), ...(typeof m.in === 'string' ? { in: m.in } : {}), ...(typeof m.why === 'string' ? { why: m.why } : {}) }))
    : [];
  const rules: RuleDraft[] = Array.isArray(p.rules)
    ? p.rules
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && ((r as Record<string, unknown>).forbid === 'import' || (r as Record<string, unknown>).forbid === 'call'))
        .map((r) => ({
          forbid: r.forbid as 'import' | 'call',
          from: typeof r.from === 'string' ? r.from : '',
          ...(strArr(r.to).length ? { to: strArr(r.to) } : {}),
          ...(strArr(r.callee).length ? { callee: strArr(r.callee) } : {}),
          ...(strArr(r.except).length ? { except: strArr(r.except) } : {}),
          ...(typeof r.why === 'string' ? { why: r.why } : {}),
        }))
        .filter((r) => r.from)
    : [];
  return { scope: strArr(p.scope), match, rules, guardTests: strArr(p.guardTests) };
}

export async function draftChecksFor(llm: LlmClient, input: DraftInput): Promise<Omit<CompiledDraft, 'version'>> {
  const prompt = compilePrompt(input);
  const { text, usage } = await llm.complete(prompt);
  const parsed = parseDraftResponse(text);
  return {
    decision: input.id,
    recordFile: input.recordFile,
    draftedAt: new Date().toISOString(),
    status: 'pending',
    raw: text,
    usage,
    ...parsed,
  };
}
