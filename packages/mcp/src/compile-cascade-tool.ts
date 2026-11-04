// MCP surface for T46: compile-at-capture's approve/reject flow + the cascade check. No daemon needed (same shape
// as mole_decisions): files + git + (for draft/escalate) one real model call via @mole/decisions' injectable LlmClient.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sc } from './annotations.js';
import { confineAllToRoot, confineToRoot } from './safe-path.js'; // T91 review fix HIGH 2: client-supplied path args only

export function registerCompileAndCascadeTools(server: McpServer, opts: { root: string }): void {
  server.registerTool(
    'mole_compile_draft',
    {
      title: 'Mole compile draft',
      description:
        'Compile-at-capture (T46): draft machine checks (content anchors, scope globs, dependency-cruiser forbidden rules, ' +
        'guard-test links) for ONE decision, from its own text. Makes exactly one model call and stores the result as a new ' +
        'PENDING version under .mole/decisions/compiled/<id>.json -- it does NOT touch the decision record until approved. ' +
        'Use mole_compile_approve or mole_compile_reject next; never both on the same version.',
      inputSchema: {
        id: z.string().describe('decision id to draft checks for (must already exist in the decision graph)'),
        root: z.string().optional().describe('repo root, default .'),
        records: z.string().optional().describe('where the .mole records live, default root'),
        adrDir: z.array(z.string()).optional().describe('plain ADR folders also loaded (e.g. docs/architecture-decisions)'),
        from: z.string().optional().describe('read the decision text from this file instead of the record file (e.g. the original imported ADR)'),
      },
      // T50: writes a new compiled-draft JSON file (not read-only) and makes one model call (openWorldHint: true).
      annotations: { title: 'Mole compile draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: z.object({ id: z.string().optional(), version: z.unknown().optional() }).passthrough(),
    },
    async (args) => {
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const recordsRoot = args.records ? confineToRoot(root, args.records, 'records') : root;
        const { draftChecksFor, hermesLlmClient, loadGraph, saveDraft, contentAnchorsOf } = await import('@mole/decisions');
        const graph = loadGraph(recordsRoot, { adrDirs: confineAllToRoot(recordsRoot, args.adrDir, 'adrDir') ?? [] });
        const node = graph.nodes.find((n) => n.id === args.id);
        if (!node) return { content: [{ type: 'text' as const, text: `mole_compile_draft: no decision ${args.id} in ${recordsRoot}` }], isError: true };
        const decisionText = args.from ? readFileSync(confineToRoot(root, args.from, 'from'), 'utf8') : readFileSync(resolve(recordsRoot, node.file), 'utf8');
        const existingMatch = contentAnchorsOf(recordsRoot, node).map((a: { pattern: string; in?: string; why?: string }) => ({ pattern: a.pattern, ...(a.in ? { in: a.in } : {}), ...(a.why ? { why: a.why } : {}) }));
        const draft = await draftChecksFor(hermesLlmClient(), {
          id: node.id,
          title: node.title,
          recordFile: node.file,
          decisionText,
          existingScope: node.scope.map((a: { target: string }) => a.target),
          existingMatch,
        });
        const saved = saveDraft(recordsRoot, draft);
        return { content: [{ type: 'text' as const, text: JSON.stringify(saved, null, 2) }], structuredContent: sc(saved) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_compile_draft: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'mole_compile_review',
    {
      title: 'Mole compile review',
      description:
        'Approve or reject a compile-at-capture draft (T46). Approving MERGES the draft\'s scope/match/rules into the decision ' +
        "record's own front matter (append + dedup, never replaces an existing approved entry) and marks that version approved. " +
        'Rejecting only marks the version rejected with a reason; the record is never touched. Omit version for the latest draft.',
      inputSchema: {
        id: z.string().describe('decision id'),
        action: z.enum(['approve', 'reject']),
        version: z.number().optional().describe('draft version to act on; default = latest'),
        approver: z.string().optional().describe('required for approve: who approved it'),
        reason: z.string().optional().describe('required for reject: why'),
        root: z.string().optional(),
        records: z.string().optional(),
      },
      // T50: approve writes into the decision record's own front matter; reject writes the draft store. No
      // model call either way (openWorldHint: false). destructiveHint: true -- approve modifies existing record content.
      annotations: { title: 'Mole compile review', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: z.object({ recordPath: z.string().optional(), draft: z.unknown().optional() }).passthrough(),
    },
    async (args) => {
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const recordsRoot = args.records ? confineToRoot(root, args.records, 'records') : root;
        const { approveDraft, rejectDraft } = await import('@mole/decisions');
        if (args.action === 'approve') {
          if (!args.approver) return { content: [{ type: 'text' as const, text: 'mole_compile_review: approve needs approver' }], isError: true };
          const { recordPath, draft } = approveDraft(recordsRoot, args.id, { version: args.version, approver: args.approver });
          const out = { recordPath, draft };
          return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }], structuredContent: sc(out) };
        }
        if (!args.reason) return { content: [{ type: 'text' as const, text: 'mole_compile_review: reject needs reason' }], isError: true };
        const draft = rejectDraft(recordsRoot, args.id, { version: args.version, reason: args.reason });
        return { content: [{ type: 'text' as const, text: JSON.stringify(draft, null, 2) }], structuredContent: sc({ draft }) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_compile_review: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'mole_cascade_check',
    {
      title: 'Mole cascade check',
      description:
        'T46 cascade: for base..head, the zero-LLM tier (compiled content anchors + scope anchors, $0, ~100ms) decides first; a ' +
        'decision whose governed scope is touched but no rule gave a crisp verdict escalates to exactly ONE LLM call with only ' +
        "that decision's own text. Returns each governed decision's verdict, which tier decided it, and tokens/cost used.",
      inputSchema: {
        base: z.string(),
        head: z.string(),
        root: z.string().optional(),
        records: z.string().optional(),
        adrDir: z.array(z.string()).optional(),
        noLlm: z.boolean().optional().describe('run the zero-LLM tier only; never escalate (default false)'),
      },
      // T50: never writes (readOnlyHint: true); may escalate to one LLM call per decision (openWorldHint: true),
      // unless noLlm is set -- the annotation is static per tool, so it states the worst case.
      annotations: { title: 'Mole cascade check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      outputSchema: z.object({ decisions: z.array(z.unknown()).optional(), tokens: z.unknown().optional(), cost: z.unknown().optional() }).passthrough(),
    },
    async (args) => {
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const recordsRoot = args.records ? confineToRoot(root, args.records, 'records') : root;
        const { cascadeCheck, decisionTextFromRecords, hermesLlmClient, loadGraph } = await import('@mole/decisions');
        const adrDirs = confineAllToRoot(recordsRoot, args.adrDir, 'adrDir') ?? [];
        const graph = loadGraph(recordsRoot, { adrDirs });
        const r = await cascadeCheck({
          root,
          base: args.base,
          head: args.head,
          recordsRoot,
          adrDirs,
          llm: args.noLlm ? undefined : hermesLlmClient(),
          decisionText: decisionTextFromRecords(recordsRoot, graph.nodes),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_cascade_check: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
