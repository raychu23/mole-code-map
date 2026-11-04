// T53: router API types. RouteDoc is a decision's INDEX text for BM25 (title + one-line summary + a clipped slice
// of rationale.ts's own sections) -- deliberately much smaller than the record's full text (that's RAG's job, and
// its cost: M2 v2 results.md measured the RAG arm at $0.0255/check for reading every decision's full body).
import type { LlmClient, LlmUsage } from '../compile/types.js';

export interface RouteDoc {
  id: string;
  title: string;
  /** one-line summary, used ONLY in the stage-2 listwise LLM prompt (never the full index text) */
  summary: string;
  /** BM25 index text: title + summary + clipped rationale key terms (indexTextOf) */
  text: string;
}

export interface RouteCandidate {
  id: string;
  title: string;
  bm25Score: number;
}

export type RouteTier = 'bm25' | 'bm25+llm';

export interface RouteResult {
  /** final routed decision ids for this change */
  routed: RouteCandidate[];
  /** every BM25-scored candidate above minScore, including ones stage 2 dropped (audit trail) */
  bm25Candidates: RouteCandidate[];
  tier: RouteTier;
  /** stage 1's own confidence in its top pick: top1Score / (top1Score + top2Score), 1 when there is no runner-up
   *  or no candidate at all. This is the number `confidenceRatio` is compared against to decide whether stage 2
   *  runs at all. */
  confidence: number;
  /** stage 2's usage, only when the LLM stage actually ran (bm25-only tier costs exactly $0) */
  usage?: LlmUsage;
  ms: number;
}

export interface RouteOptions {
  /** the change: file paths + hunk text (added/removed lines), assembled by the caller -- route.ts has no git
   *  dependency of its own, keeping the zero-LLM stage pure and unit-testable without a repo. */
  changeText: string;
  /** every decision this change could plausibly be about -- the repo's WHOLE candidate set, not pre-filtered by
   *  scope anchors (the (internal task reference removed) recall ceiling: a decision with no authored anchor never got to compete). */
  decisions: RouteDoc[];
  /** how many BM25 candidates stage 2 ever sees (RankGPT-style small listwise window). Default 5. */
  topK?: number;
  /** BM25 score floor below which a candidate is dropped before stage 2 ever sees it. Default: any score > 0. */
  minScore?: number;
  /** stage 1 skips the LLM stage when confidence >= this ratio (top1/(top1+top2)). Default 0.75, tuned on M2 v2
   *  dev -- see t53-results.md. */
  confidenceRatio?: number;
  /** injectable stage-2 listwise pick call; omit to run the BM25-only tier (tests, or no LLM budget). */
  llm?: LlmClient;
}
