// Types of compile-at-capture (T46): a model drafts machine checks for a decision (content anchors, scope globs,
// dependency-cruiser forbidden rules, guard-test links); a person approves or rejects; approved drafts merge into the
// decision record's own front matter (T27/T32's existing `scope:`/`match:`/`rules:` shapes), so checking stays zero-LLM.

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

/** Injectable model call: product code never calls a model directly, so tests can fake this and the bench can swap in
 *  the real `hermes` CLI (prior-art.md's FrugalGPT note: at most one call per ambiguous case). */
export interface LlmClient {
  complete(prompt: string): Promise<LlmResult>;
}

export interface MatchDraft {
  pattern: string;
  in?: string;
  why?: string;
}

export interface RuleDraft {
  forbid: 'import' | 'call';
  from: string;
  to?: string[];
  callee?: string[];
  except?: string[];
  why?: string;
}

export type DraftStatus = 'pending' | 'approved' | 'rejected';

export interface CompiledDraft {
  decision: string;
  version: number;
  draftedAt: string;
  status: DraftStatus;
  /** the decision record file this draft would merge into (repo-relative to the records root) */
  recordFile: string;
  scope: string[];
  match: MatchDraft[];
  rules: RuleDraft[];
  guardTests: string[];
  /** the model's raw response, kept for audit (what a reviewer approved, verbatim) */
  raw: string;
  usage: LlmUsage;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  rejectedAt?: string;
}
