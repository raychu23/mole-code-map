// Cascade at check time (T46). Tier 0 (zero-LLM, $0, ~100ms): `prCheck()`'s own governed list; a hit from a `match:`
// content anchor or the export-convention AST fallback is crisp (the pattern IS the violation signal) and decides
// outright, no escalation. A hit that comes ONLY from a path/folder/symbol scope anchor (no content anchor fired) is
// "a governed scope is touched but no rule decides" -- exactly the task contract's escalation trigger -- and
// escalates to tier 1: ONE LLM call with only that decision's own text + the real diff of the files it hit, same
// prompt shape as M2's oracle llm-reviewer arm (run_llm_arms.py), so the numbers are directly comparable.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LlmClient } from '../compile/types.js';
import { isModuleExportTitle } from '../check/options.js';
import { prCheck } from '../check/pr-check.js';
import type { GovernedRecord } from '../check/types.js';
import { routeDecisions } from '../route/route.js';
import { argumentChainView } from './argument-view.js';
import type { CascadeFlag, CascadeResult, CascadeVerdict, RoutedDecision, SemanticRouteOptions } from './types.js';

/** T49: a decision's content/export-convention/rule hit decides outright (the pattern IS the signal); a decision
 *  governed ONLY by a scope anchor has nothing crisp and must escalate. `rule:` (rules/check.ts import:/call:
 *  violations wired into prCheck, verifier.md #1) joins `match:` and `export-convention` as a crisp signal.
 *
 *  T66: an `export-convention` hit is crisp only when the decision's OWN title actually uses module-export
 *  vocabulary (isModuleExportTitle) -- a title that merely contains a word starting with "export" (e.g. "Audit
 *  every data export") still ROUTES via the broad isExportConventionTitle test (prCheck still gives it the AST
 *  hit, nothing about recall changes) but is not treated as a no-judge, auto-decide signal; it escalates to the
 *  LLM tier like any other governed-but-not-crisp hit instead. The two real ADRs that motivated option 4
 *  (Backstage's "Avoid Default Exports and Prefer Named Exports" / "Module Export Structure") both pass
 *  isModuleExportTitle, so they are unaffected. */
const isCrisp = (g: GovernedRecord): boolean =>
  g.hits.some((h) => h.anchor.startsWith('match:') || h.anchor.startsWith('rule:') || (h.anchor === 'export-convention' && isModuleExportTitle(g.title)));

export interface CascadeOptions {
  root: string;
  base: string;
  head: string;
  recordsRoot?: string;
  adrDirs?: string[];
  /** injectable model call for the escalation tier; omit to run the zero-LLM tier only (tests, or a caller that
   *  wants to see what's ambiguous without spending anything). */
  llm?: LlmClient;
  /** the governing decision's own text, by id, for the ONE escalation call. Required to actually escalate; a
   *  decision with no text available is reported as zero-LLM 'violates' with that reason (never silently dropped). */
  decisionText?: (id: string) => string | undefined;
  /** T53: semantic routing (BM25 stage1 + optional listwise LLM stage2) over decisions prCheck's scope/content/
   *  export-convention/rule anchors found NOTHING for -- additive, never removes or overrides an anchor hit.
   *  A decision added this way has no crisp anchor (lexical overlap is never itself the violation signal), so it
   *  escalates to the LLM tier same as a scope-anchor-only hit, over the change's WHOLE diff (a semantic hit is
   *  change-level, not line-anchored). Omit to keep T49's scope/content-anchor-only routing unchanged. */
  semanticRoute?: SemanticRouteOptions;
}

const ESCALATE_PROMPT = (decisionText: string, diff: string): string =>
  [
    'You are reviewing a code change against one specific team architecture decision (an ADR).',
    '',
    '--- THE DECISION (full text) ---',
    decisionText,
    '',
    '--- THE CODE CHANGE (unified diff) ---',
    diff,
    '',
    'Does this change VIOLATE the decision above? Answer with exactly one line first:',
    'VERDICT: VIOLATES or VERDICT: COMPLIANT',
    'Then one short sentence of reasoning.',
  ].join('\n');

/** T49: FrugalGPT/PR-Agent-style prompt compression -- when MORE THAN ONE decision escalates for the SAME check,
 *  one call carries every escalating decision's OWN text (nothing else: not the whole decision graph, the
 *  realistic non-Mole baseline RAG arm pays 5-7x more per check for exactly that), each paired with a diff
 *  restricted to that decision's own governed paths (chunked to the governed hunks, not the whole repo). The
 *  M2 v2 61-case run measured cascade costing MORE than the LLM reviewer ($0.0050 vs $0.0039/check) because 24/61
 *  cases made 2+ separate escalation calls (one case made 4); this collapses N calls into 1. */
const MULTI_ESCALATE_PROMPT = (entries: Array<{ id: string; text: string; diff: string }>): string =>
  [
    'You are reviewing ONE code change against SEVERAL team architecture decisions (ADRs) at once.',
    'Judge each decision INDEPENDENTLY of the others -- a change can violate one and comply with another.',
    '',
    ...entries.map((e) => ['=== DECISION ' + e.id + ' (full text) ===', e.text, '', '--- CODE CHANGE governed by this decision (unified diff) ---', e.diff].join('\n')),
    '',
    `Answer with exactly one block per decision, in this exact order (${entries.map((e) => e.id).join(', ')}):`,
    '### <decision id>',
    'VERDICT: VIOLATES or VERDICT: COMPLIANT',
    '<one short sentence of reasoning>',
  ].join('\n\n');

function parseVerdict(text: string): CascadeFlag | undefined {
  const m = /VERDICT:\s*(VIOLATES|COMPLIANT)/i.exec(text);
  if (!m) return undefined;
  return m[1]!.toUpperCase() === 'VIOLATES' ? 'violates' : 'compliant';
}

/** Splits a batched response into one block per decision id, in the order the ids were given. A decision whose
 *  block is missing or unparsable (model dropped it, truncated output) reports 'violates' -- an escalation never
 *  silently drops, same contract as the single-decision path. */
function parseMultiVerdicts(resp: string, ids: string[]): Map<string, { flag: CascadeFlag; reason: string }> {
  const out = new Map<string, { flag: CascadeFlag; reason: string }>();
  const blocks = resp.split(/^###\s*/m).slice(1); // drop any preamble before the first block
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const id = (nl === -1 ? block : block.slice(0, nl)).trim();
    if (!ids.includes(id) || out.has(id)) continue;
    const body = nl === -1 ? '' : block.slice(nl + 1);
    const flag = parseVerdict(body) ?? 'violates';
    out.set(id, { flag, reason: body.replace(/^\s*VERDICT:\s*\S+\s*/i, '').trim() || body.trim() || resp.trim() });
  }
  return out;
}

/** T49 token budget (PR-Agent `token_handler.py`/`pr_processing.py` shape, estimate-based: Mole's `LlmClient` is
 *  provider-agnostic so there is no single real tokenizer to call here -- the ~4 chars/token estimate is the same
 *  fallback PR-Agent itself uses when a provider-accurate count isn't available). A single-decision escalation
 *  gets the full per-call budget; a batched multi-decision call splits it evenly per decision so no one diff can
 *  crowd out the others, with a trailing note when a diff was clipped (never silently truncated with no signal). */
const CHARS_PER_DECISION_BUDGET = 20_000; // ~5k tokens/decision at the ~4 chars/token estimate
function clipDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + `\n...[diff clipped at ${maxChars} chars by the cascade's token budget; ${diff.length - maxChars} more chars omitted]`;
}

function gitDiffFor(root: string, mergeBase: string, head: string, paths: string[]): string {
  if (!paths.length) return '';
  try {
    return execFileSync('git', ['-C', root, 'diff', `${mergeBase}..${head}`, '--', ...paths], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  } catch {
    return '';
  }
}

export async function cascadeCheck(opts: CascadeOptions): Promise<CascadeResult> {
  const t0 = performance.now();
  const recordsRoot = opts.recordsRoot ?? opts.root;
  const pr = await prCheck({ root: opts.root, base: opts.base, head: opts.head, recordsRoot, adrDirs: opts.adrDirs });

  // T53: semantic routing over decisions scope/content/export/rule anchors found NOTHING for -- the (internal task reference removed)
  // recall ceiling (routing accuracy 0.36: a decision with no authored anchor never even became a candidate).
  // Additive: a decision pr.governed already found is never re-added or re-scored here.
  const alreadyGoverned = new Set(pr.governed.map((g) => g.id));
  const semanticAdds: GovernedRecord[] = [];
  let semanticRouteUsage: CascadeResult['semanticRouteUsage'];
  if (opts.semanticRoute) {
    const candidates = opts.semanticRoute.decisions.filter((d) => !alreadyGoverned.has(d.id));
    const changeText = [...pr.files, gitDiffFor(opts.root, pr.mergeBase, pr.head, pr.files)].join('\n');
    const routed = await routeDecisions({
      changeText,
      decisions: candidates,
      topK: opts.semanticRoute.topK,
      minScore: opts.semanticRoute.minScore,
      confidenceRatio: opts.semanticRoute.confidenceRatio,
      llm: opts.semanticRoute.llm,
    });
    semanticRouteUsage = routed.usage;
    for (const c of routed.routed) {
      // change-level hit (not line-anchored): every changed file is "the governed scope" for this decision's
      // own escalation diff, same shape the scope-anchor path already uses for a folder anchor over many files.
      semanticAdds.push({ id: c.id, title: c.title, status: 'accepted', flag: 'yellow', file: '', line: 0, hits: pr.files.map((path) => ({ anchor: 'semantic', path, side: 'new' as const, ranges: [[1, 1]] as [number, number][] })) });
    }
  }
  const governedAll: GovernedRecord[] = [...pr.governed, ...semanticAdds];

  // T49 routing: which decisions govern this change and how, decided with zero LLM calls -- independent of
  // whatever verdict the tiers below reach. This is the number the M2 bench's "Mole-routed check" arm reports
  // routing accuracy against (did the right decision get found at all), separate from verdict correctness.
  const routing: RoutedDecision[] = governedAll.map((g) => ({ decision: g.id, title: g.title, hitKinds: [...new Set(g.hits.map((h) => (h.anchor.includes(':') ? h.anchor.split(':')[0]! : h.anchor)))] }));

  const verdicts: CascadeVerdict[] = [];
  const times = new Map<string, number>();
  const escalations: Array<{ g: GovernedRecord; paths: string[]; text: string; argumentLabels?: Record<string, 'in' | 'out' | 'undecided'> }> = [];
  for (const g of governedAll) {
    const t1 = performance.now();
    if (isCrisp(g)) {
      verdicts.push({ decision: g.id, title: g.title, tier: 'zero-llm', flag: 'violates', reason: `content anchor matched (${g.hits.map((h) => h.anchor).join(', ')})`, ms: Math.round(performance.now() - t1) });
      continue;
    }
    // governed only by a path/folder/symbol scope anchor: scope touched, no crisp rule decided -> escalate
    const paths = [...new Set(g.hits.map((h) => h.path))];
    if (!opts.llm) {
      verdicts.push({ decision: g.id, title: g.title, tier: 'zero-llm', flag: 'violates', reason: 'scope anchor touched; no LLM tier configured for this call, reporting the raw governed hit', ms: Math.round(performance.now() - t1) });
      continue;
    }
    const rawText = opts.decisionText?.(g.id);
    if (!rawText) {
      verdicts.push({ decision: g.id, title: g.title, tier: 'zero-llm', flag: 'violates', reason: 'scope anchor touched; no decision text available to escalate to the LLM tier', ms: Math.round(performance.now() - t1) });
      continue;
    }
    // T54: the judge prompt is built from the decision's OWN derived argument chain (deriveAdrArgumentFramework)
    // evaluated with packages/reasoning's grounded semantics, not the raw text alone -- a Considered Options
    // entry the record's own stated reasons never defeat is surfaced as a standing, unresolved objection
    // instead of silently reading as settled prose. A record with no Considered Options/Decision Outcome
    // structure degrades to its plain text unchanged (argument-view.ts's own fallback).
    const view = argumentChainView(g.id, rawText);
    const argumentLabels = Object.keys(view.labels).length > 1 ? view.labels : undefined; // >1: something was actually derived beyond the bare claim
    times.set(g.id, t1);
    escalations.push({ g, paths, text: view.text, argumentLabels });
  }

  if (escalations.length === 1) {
    // single escalation: same one-call shape as before (kept separate from the batch path so the prompt/response
    // contract for the common case stays simple and unchanged)
    const { g, paths, text, argumentLabels } = escalations[0]!;
    const t1 = times.get(g.id)!;
    const diff = clipDiff(gitDiffFor(opts.root, pr.mergeBase, pr.head, paths), CHARS_PER_DECISION_BUDGET);
    const { text: resp, usage } = await opts.llm!.complete(ESCALATE_PROMPT(text, diff));
    const flag = parseVerdict(resp) ?? 'violates'; // an unparsable LLM response is reported as a flag, never silently dropped
    verdicts.push({ decision: g.id, title: g.title, tier: 'llm', flag, reason: resp.replace(/^VERDICT:\s*\S+\s*/i, '').trim() || resp, usage, argumentLabels, ms: Math.round(performance.now() - t1) });
  } else if (escalations.length > 1) {
    // T49 batched escalation (FrugalGPT/PR-Agent): ONE call for every escalating decision on this check, instead
    // of one call per decision -- the fix for the M2 v2 cost regression (cascade > llm-reviewer per-check cost
    // because multi-decision checks paid for 1.6 calls on average).
    const perDecisionBudget = Math.max(2_000, Math.floor(CHARS_PER_DECISION_BUDGET / escalations.length)); // split one call's budget evenly (review: was N x the budget)
    const entries = escalations.map(({ g, paths, text }) => ({ id: g.id, text, diff: clipDiff(gitDiffFor(opts.root, pr.mergeBase, pr.head, paths), perDecisionBudget) }));
    const ids = entries.map((e) => e.id);
    const { text: resp, usage } = await opts.llm!.complete(MULTI_ESCALATE_PROMPT(entries));
    const parsed = parseMultiVerdicts(resp, ids);
    // usage is reported for the WHOLE batched call once, on its first decision; the rest cost $0 marginal (this is
    // the actual saving: one call's tokens instead of N calls' tokens) -- the bench sums per-case cost over
    // verdicts, so attributing once (not once-per-decision) is what makes the arithmetic match the real spend.
    escalations.forEach(({ g, argumentLabels }, i) => {
      const t1 = times.get(g.id)!;
      const found = parsed.get(g.id);
      const flag = found?.flag ?? 'violates'; // a decision whose block the model dropped is reported as a flag, never silently dropped
      const reason = found?.reason ?? `(batched call did not return a parseable block for ${g.id}) ${resp.slice(0, 200)}`;
      verdicts.push({ decision: g.id, title: g.title, tier: 'llm', flag, reason, usage: i === 0 ? usage : undefined, argumentLabels, ms: Math.round(performance.now() - t1) });
    });
  }

  return { base: pr.base, head: pr.head, verdicts, files: pr.files, routing, semanticRouteUsage, ms: Math.round(performance.now() - t0) };
}

/** Reads a decision's own full text from its record file, for `CascadeOptions.decisionText`. `adrFile`, when given,
 *  overrides with the original ADR/source file (what the T36 importer saw) -- the richer text a real cascade would
 *  prefer when the record itself is a thin overlay (bench and M24-bench-style records). */
export function decisionTextFromRecords(recordsRoot: string, nodes: Array<{ id: string; file: string }>, adrFile?: (id: string) => string | undefined): (id: string) => string | undefined {
  return (id: string) => {
    const override = adrFile?.(id);
    if (override) {
      try {
        return readFileSync(resolve(override), 'utf8');
      } catch {
        // fall through to the record file
      }
    }
    const node = nodes.find((n) => n.id === id);
    if (!node) return undefined;
    try {
      return readFileSync(resolve(recordsRoot, node.file), 'utf8');
    } catch {
      return undefined;
    }
  };
}
