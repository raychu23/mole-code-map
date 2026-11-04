// Cascade at check time (T46): zero-LLM tier (T27/T32's prCheck content anchors + scope anchors) decides first;
// escalate to exactly ONE LLM call, with only the governing decision's own text, when a decision's scope is touched
// but no crisp rule decided (FrugalGPT, arXiv:2305.05176 -- stop as early in the cascade as a tier can decide).
import type { LlmClient } from '../compile/types.js';

export type CascadeTier = 'zero-llm' | 'llm';
export type CascadeFlag = 'violates' | 'compliant';

export interface CascadeVerdict {
  decision: string;
  title: string;
  tier: CascadeTier;
  flag: CascadeFlag;
  /** why the tier that decided, decided (anchor name(s), or the LLM's one-sentence reason) */
  reason: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** T54: packages/reasoning's grounded-semantics label for every argument derived from this decision's OWN
   *  MADR/Nygard sections (deriveAdrArgumentFramework), keyed by its derived id (`<decision>::claim`,
   *  `<decision>::option:N`, `<decision>::reason:N`) -- present only on an 'llm' tier verdict (the escalation
   *  tier is where the judge prompt is built from these labels; the zero-llm tier never reads them). Absent
   *  (not just empty) when the decision's own text had no Considered Options/Decision Outcome structure to
   *  derive anything from -- same "nothing to add" fallback as argument-view.ts's plain-text degrade. */
  argumentLabels?: Record<string, 'in' | 'out' | 'undecided'>;
  ms: number;
}

/** T49: which decisions govern this change and how, decided with ZERO LLM calls (prCheck's own scope anchors,
 *  content anchors and -- now -- rules/check.ts import:/call: violations). This is Mole's actual value proposition
 *  over the non-Mole baseline (RAG over every decision in the repo): routing the right decision(s) to a check at
 *  no cost, instead of paying to search/read all of them every time. `routing` is independent of the cascade's
 *  eventual verdict, so routing accuracy (did Mole find the governing decision at all) can be measured apart from
 *  verdict correctness (did the tier that decided get the right answer). */
export interface RoutedDecision {
  decision: string;
  title: string;
  /** anchor kinds that routed this decision here: 'match' | 'export-convention' | 'rule' | 'semantic' | the scope target string */
  hitKinds: string[];
}

/** T53: config for the semantic routing stage cascadeCheck runs over decisions scope/content anchors missed. */
export interface SemanticRouteOptions {
  /** every decision's BM25 index doc (title + summary + index text) -- the repo's WHOLE candidate set, built by
   *  the caller with route/index-text.ts's indexTextOf/oneLineSummaryOf (cascade.ts has no opinion on how a
   *  decision's record text becomes an index doc, same posture as CascadeOptions.decisionText). */
  decisions: Array<{ id: string; title: string; summary: string; text: string }>;
  topK?: number;
  minScore?: number;
  confidenceRatio?: number;
  /** stage 2's model call; can be the same LlmClient as CascadeOptions.llm, or a cheaper one -- the router's own
   *  budget is independent of the escalation tier's. Omit to run the BM25-only tier. */
  llm?: LlmClient;
}

export interface CascadeResult {
  base: string;
  head: string;
  verdicts: CascadeVerdict[];
  /** files touched by this diff that no decision's scope covers at all (not in verdicts: nothing to decide) */
  files: string[];
  /** T49: every decision prCheck found governing this change, zero-LLM, before any escalation decided a verdict.
   *  T53: also includes any decision `semanticRoute` found that scope/content anchors missed entirely (hitKinds
   *  `['semantic']`), additive to the scope/content/export/rule hits above, never replacing them. */
  routing: RoutedDecision[];
  /** T53: semantic routing's own cost/confidence for this check, only when `semanticRoute` was configured and its
   *  LLM stage actually ran (the zero-LLM BM25-only tier costs exactly $0 and is not reported here). */
  semanticRouteUsage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  ms: number;
}
