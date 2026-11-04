// T53: routeDecisions -- stage 1 (BM25, zero-LLM, zero network) narrows every candidate decision to its top-k
// lexical matches against the change text; stage 2 (ONE listwise LLM call, candidate SUMMARIES only -- never
// full decision text, that is the RAG arm's cost) runs ONLY when stage 1 is not confidently ahead. Shape from
// prior-art.md: aurelio-labs/semantic-router's cheap-then-slow fallthrough (`Chain`), RankGPT's listwise-pick
// mechanic (numbered candidate list, ask for a selection back), Agentless's narrow-before-decide localization.
import { Bm25Index } from './bm25.js';
import type { RouteCandidate, RouteDoc, RouteOptions, RouteResult } from './types.js';

const DEFAULT_TOP_K = 5;
const DEFAULT_CONFIDENCE_RATIO = 0.75; // tuned on M2 v2 dev -- see t53-results.md

const LISTWISE_PROMPT = (changeSummary: string, candidates: Array<{ id: string; title: string; summary: string }>): string =>
  [
    'A code change needs to be checked against team architecture decisions. Below is a short summary of the',
    'change, and a numbered list of CANDIDATE decisions (title + one-line summary only, not their full text).',
    '',
    '--- THE CHANGE (summary) ---',
    changeSummary,
    '',
    '--- CANDIDATE DECISIONS ---',
    ...candidates.map((c, i) => `[${i + 1}] ${c.id}: ${c.title} -- ${c.summary}`),
    '',
    'Which of these candidates does the change actually touch/govern? A change can govern zero, one, or several.',
    'Answer with exactly one line: PICK: <comma-separated candidate numbers, or NONE>',
  ].join('\n');

/** An unparsable response never silently drops everything -- same "never silently drop" contract as the cascade's
 *  escalation parsing (cascade.ts parseVerdict/parseMultiVerdicts): falls back to BM25's own top candidate. */
function parsePick(resp: string, candidates: RouteCandidate[]): RouteCandidate[] {
  const m = /PICK:\s*(.+)/i.exec(resp);
  if (!m) return candidates.length ? [candidates[0]!] : [];
  const body = m[1]!.trim();
  if (/^none\b/i.test(body)) return [];
  const idxs = [...new Set(body.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n)))];
  const picked = idxs.map((i) => candidates[i - 1]).filter((c): c is RouteCandidate => !!c);
  return picked.length ? picked : candidates.length ? [candidates[0]!] : [];
}

export async function routeDecisions(opts: RouteOptions): Promise<RouteResult> {
  const t0 = performance.now();
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? 0;
  const confidenceRatio = opts.confidenceRatio ?? DEFAULT_CONFIDENCE_RATIO;

  const idx = new Bm25Index();
  for (const d of opts.decisions) idx.add(d.id, d.text);
  const byId = new Map<string, RouteDoc>(opts.decisions.map((d) => [d.id, d]));
  const scored = idx.score(opts.changeText).filter((h) => h.score > minScore);
  const bm25Candidates: RouteCandidate[] = scored.map((h) => ({ id: h.id, title: byId.get(h.id)?.title ?? h.id, bm25Score: h.score }));

  if (bm25Candidates.length === 0) {
    return { routed: [], bm25Candidates: [], tier: 'bm25', confidence: 1, ms: Math.round(performance.now() - t0) };
  }

  const top = bm25Candidates.slice(0, topK);
  const top1 = top[0]!.bm25Score;
  const top2 = top[1]?.bm25Score ?? 0;
  const confidence = top1 + top2 > 0 ? top1 / (top1 + top2) : 1;

  if (confidence >= confidenceRatio || !opts.llm) {
    return { routed: [top[0]!], bm25Candidates, tier: 'bm25', confidence, ms: Math.round(performance.now() - t0) };
  }

  // stage 2: one listwise LLM call, candidate SUMMARIES only (never full index text)
  const prompt = LISTWISE_PROMPT(
    opts.changeText.slice(0, 2000),
    top.map((c) => ({ id: c.id, title: c.title, summary: byId.get(c.id)?.summary ?? c.title })),
  );
  const { text: resp, usage } = await opts.llm.complete(prompt);
  const routed = parsePick(resp, top);
  return { routed, bm25Candidates, tier: 'bm25+llm', confidence, usage, ms: Math.round(performance.now() - t0) };
}
