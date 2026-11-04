// T61: the built reasoning features as READ-ONLY MCP tools, so an agent in Claude Code / Hermes / Codex sees them.
//   mole_priorities         T60 tenet order per phase: evaluate one phase (phase | at) or compare two
//   mole_incident_suggest   T58 losing arguments an incident may revive (suggest only; accept/dismiss stay CLI)
//   mole_proposals_compare  T56 proposal worktrees of THIS repo vs their baseline (found via git worktree list)
// Prior art ((internal reference removed) log/prior-art.md): MCP 2025-06-18 tools (structuredContent + the same
// JSON as text; bad input / business errors = isError result), ToolAnnotations readOnlyHint, github-mcp-server
// --read-only (write tools left out). Writes are a person's act in Mole (T58/T59), so none are exposed here.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { comparePhases, evaluatePhase, phaseInForce, recallSimilar, suggestRevivals } from '@mole/decisions';
import { listProposals, summarizeProposals } from '@mole/proposals';
import { READ_ONLY_ANNOTATIONS, sc } from './annotations.js';

interface Opts {
  root: string;
}

const ok = (o: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }], structuredContent: sc(JSON.parse(JSON.stringify(o)) as object) });
const fail = (tool: string, e: unknown) => ({ content: [{ type: 'text' as const, text: `${tool}: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/** T62: moved to @mole/proposals (one source for MCP, CLI and panel); kept as an export for callers of T61's name */
export const repoProposals = listProposals;

export function registerReasoningTools(server: McpServer, opts: Opts): void {
  server.registerTool(
    'mole_priorities',
    {
      title: 'Mole priorities',
      description:
        "The decision graph judged under one phase's tenet order (.mole/priorities.md: e.g. launch ranks speed over cost, scale the reverse; " +
        'an argument serves the tenet tagged #tenet-x on its definition), or two phases compared: every argument and decision that changes, with the attack ' +
        'that wins in one phase and loses in the other, both tenets and their ranks. Give `phase`, or `at` (YYYY-MM-DD, the phase in force then), or ' +
        '`compare` [A, B]; none = the phase in force today. Same JSON as `mole priorities`. Deterministic, no LLM, read-only.',
      inputSchema: {
        phase: z.string().optional().describe('phase name from .mole/priorities.md'),
        at: z.string().optional().describe('YYYY-MM-DD: use the phase in force on that date'),
        compare: z.array(z.string()).length(2).optional().describe('two phase names to compare'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole priorities' },
      outputSchema: z.object({}).passthrough(),
    },
    async ({ phase, at, compare }) => {
      try {
        if (compare && (phase || at)) throw new Error('give `compare`, or `phase`/`at`, not both');
        if (compare) return ok(comparePhases(opts.root, compare[0]!, compare[1]!));
        // T73 backlog priorities-default: this tool's own doc says "none = the phase in force today" -- make
        // that true (phaseInForce, the same selector T68 already gave incident-suggest/proposals-compare)
        // instead of evaluatePhase's own plain-Dung default, which is `mole priorities`'s unchanged CLI default.
        const explicit = phase || at;
        const resolved = explicit ? { ...(phase ? { phase } : {}), ...(at ? { at } : {}) } : (() => { const p = phaseInForce(opts.root, {}); return p ? { phase: p.name } : {}; })();
        return ok(evaluatePhase(opts.root, resolved));
      } catch (e) {
        return fail('mole_priorities', e);
      }
    },
  );

  server.registerTool(
    'mole_incident_suggest',
    {
      title: 'Mole incident suggest',
      description:
        'For an incident record (.mole/incidents/<id>.md), the recorded losing arguments it may revive: arguments that lost to what a named or ' +
        'scope-sharing decision rests on, ranked, each with its evidence and what else accepting it would reinstate. Suggestions only: accepting one is ' +
        "a person's act (`mole incident accept`), not available over MCP. Judged under the T60 phase in force (`phase`, or `at` a date, or today by " +
        'default), with the plain-Dung (no phase) label shown beside each candidate so a phase-driven candidate is never silently substituted for it. ' +
        'Same JSON as `mole incident suggest`. Deterministic, no LLM, read-only.',
      inputSchema: {
        incident: z.string().describe('incident id, e.g. inc-42'),
        limit: z.number().int().nonnegative().optional().describe('max candidates (default 20; 0 = none, as the library)'),
        phase: z.string().optional().describe('phase name from .mole/priorities.md (default: the phase in force today)'),
        at: z.string().optional().describe('YYYY-MM-DD: use the phase in force on that date instead of today'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole incident suggest' },
      outputSchema: z.object({ incident: z.string(), candidates: z.array(z.unknown()) }).passthrough(),
    },
    async ({ incident, limit, phase, at }) => {
      try {
        return ok({ incident, candidates: suggestRevivals(opts.root, incident, { ...(limit !== undefined ? { limit } : {}), ...(phase ? { phase } : {}), ...(at ? { at } : {}) }) });
      } catch (e) {
        return fail('mole_incident_suggest', e);
      }
    },
  );

  server.registerTool(
    'mole_proposals_compare',
    {
      title: 'Mole proposals compare',
      description:
        "This repo's decision proposals (what-if branches made with `mole-proposals create`) judged against the approved baseline they were made from: " +
        'which arguments and decisions change state in each, and why. Proposals are found from this repo\'s git worktrees; pass `names` to pick some ' +
        '(default: all). One proposal = its evaluation; two or more = side by side (must share a baseline). `changes` is judged under the T60 phase in ' +
        'force (`phase`, or `at` a date, or today by default, resolved against each side\'s own .mole/priorities.md); `plainDung` is always the ' +
        'plain-Dung (no phase) reading, shown beside it so a phase-driven reading is never silently substituted for it. Same JSON as `mole-proposals ' +
        'compare`. Read-only.',
      inputSchema: {
        names: z.array(z.string()).optional().describe('proposal names (default: every proposal of this repo)'),
        phase: z.string().optional().describe('phase name from .mole/priorities.md (default: the phase in force today)'),
        at: z.string().optional().describe('YYYY-MM-DD: use the phase in force on that date instead of today'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole proposals compare' },
      outputSchema: z.object({ baselineRevision: z.string(), proposals: z.array(z.unknown()) }).passthrough(),
    },
    async ({ names, phase, at }) => {
      try {
        // MCP keeps T61's contract: no proposals is an error result an agent can read, not an empty list
        const r = summarizeProposals(opts.root, names, { ...(phase ? { phase } : {}), ...(at ? { at } : {}) });
        if (r.proposals.length === 0) throw new Error('no proposals in this repo -- create one with: mole-proposals create');
        return ok(r);
      } catch (e) {
        return fail('mole_proposals_compare', e);
      }
    },
  );

  server.registerTool(
    'mole_recall',
    {
      title: 'Mole recall',
      description:
        'Past decisions/incidents that resemble a new proposal/decision draft (`text`) or an existing record (`record`), nearest first -- Klein ' +
        "recognition-primed decision's \"resembles\" relation: each hit is a SIMILAR CASE to check whether it applies, never a claim that it does, " +
        'never a causal claim about what will happen. Candidates are every decision/incident Mole already knows (.mole/decisions, .mole/incidents, ' +
        'plus any `adrDirs`); scored by BM25 lexical overlap (route/bm25.ts, zero model calls). Same JSON as `mole recall`. Read-only.',
      inputSchema: {
        text: z.string().optional().describe('a new proposal/decision draft to recall similar past cases for'),
        record: z.string().optional().describe('an existing decision/incident id to use as the query instead of text (excluded from its own results)'),
        limit: z.number().int().positive().optional().describe('max cases returned (default 5)'),
        adrDirs: z.array(z.string()).optional().describe('plain ADR folders to include as candidates, same as `mole decisions --adr-dir`'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole recall' },
      outputSchema: z.object({ query: z.string(), cases: z.array(z.unknown()), note: z.string() }).passthrough(),
    },
    async ({ text, record, limit, adrDirs }) => {
      try {
        if (!text && !record) throw new Error("mole_recall: give `text` or `record`");
        if (text && record) throw new Error('mole_recall: give `text` or `record`, not both');
        return ok(recallSimilar(opts.root, record ? { record } : { text }, { ...(limit !== undefined ? { limit } : {}), ...(adrDirs ? { adrDirs } : {}) }));
      } catch (e) {
        return fail('mole_recall', e);
      }
    },
  );
}
