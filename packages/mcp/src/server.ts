import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatNeighborhood, MAX_MAP_NODES } from '@mole/core';
import { ensureDaemon, MoleClient, type EnsureOptions } from '@mole/daemon';
import { agentIntentsFor, claims, defaultSources, tried } from './_oss-agentstate-stub.js';
import { registerCollisionsTool } from './collisions-tool.js';
import { registerCompileAndCascadeTools } from './compile-cascade-tool.js'; // T46: compile-at-capture approve/reject + cascade check
import { registerOneOnOneTool } from './oneonone-tool.js'; // T31: 1:1 prep + read-back, grouped by folder, never by person
import { registerReasoningTools } from './reasoning-tools.js'; // T61: priorities, incident suggestions, proposals (read-only)
import { registerHotspotsTool } from './hotspots-tool.js'; // T70: churn x complexity x decision volatility x fix density, ranked (read-only)
import { registerCouplingTool } from './coupling-tool.js'; // T77: logical coupling (co-change) x CODEOWNERS teams, cross-team pairs first (read-only)
import { registerOutcomesTool } from './outcomes-tool.js'; // T81 (D66): outcome tracking log -- prediction vs outcome, due/overdue checks (read-only)
import { executeTool, GEN_AI } from '@mole/telemetry';
import type { Change } from '@mole/history';
import { boundedPage } from './limit.js';
import { READ_ONLY_ANNOTATIONS, sc } from './annotations.js';
import { confineAllToRoot, confineToRoot } from './safe-path.js'; // T91 review fix HIGH 2: every path-shaped tool arg stays inside the server root

export interface MoleMcpOptions extends EnsureOptions {
  /** Do not spawn a daemon if none runs (tests). */
  noStart?: boolean;
}

// T43 review fix P2: documented aggregate rationale budget for mole_decisions when called without `files`
// (see the handler below). A files-scoped call is already a handful of decisions and skips this cap.
const MCP_DECISIONS_RATIONALE_AGGREGATE_BUDGET = 20_000;
/** Loosely typed companion to @mole/decisions's DecisionsResult: this file adds `truncated` only on the
 * MCP response object, never on the shared TS type (which stays the same shape `mole decisions --json`
 * and this tool's `files`-scoped responses use). */
type DecisionsResultWithTruncation = { decisions: Array<{ id: string; flag: string; rationale?: string }>; truncated?: string };

/** `mole_map(path|symbol)`: the same ranked neighbourhood the editor panel draws, as compact text for an agent. */
export function createServer(opts: MoleMcpOptions): McpServer {
  const server = new McpServer({ name: 'mole', version: '0.0.0' });
  server.registerTool(
    'mole_map',
    {
      title: 'Mole map',
      description:
        'Ranked neighbourhood (<=25 nodes, or `maxNodes` if lower) of a file or symbol: what it defines, who calls it, what it calls, who imports it. ' +
        'Facts come from the TypeScript compiler index with file:line evidence; no LLM. Use before reading unfamiliar code. ' +
        'For "called by" and "imported by" the line is where the call or import happens (the first one; ×N means N sites); for everything else it is the declaration line.',
      inputSchema: {
        target: z.string().describe('repo-relative file (src/a.ts), file#Symbol (src/a.ts#Cls.method), or a bare symbol name'),
        impact: z.boolean().optional().describe('also mark transitive callers (what breaks if this changes) with !impact'),
        // T50 (core-audit rank 4; Serena symbol_tools.py max_matches): caller-tunable cap, never above the
        // server's own ceiling (MAX_MAP_NODES) -- that ceiling itself stays in packages/daemon, out of this tool's boundary.
        maxNodes: z.number().int().positive().optional().describe('cap the returned node count at this many (<= the server ceiling, ' + String(MAX_MAP_NODES) + '); dropped nodes are folded into the existing more groups, never silently lost'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole map' },
      // T50 (core-audit rank 3): mole_map's content is deliberately compact TEXT (not raw JSON, see the file
      // header) -- structuredContent still gives a client the two fields that text already encodes (state +
      // the text itself), matching the official filesystem server's "content text AND structuredContent" shape.
      outputSchema: { text: z.string().describe('same text as the content block'), state: z.enum(['ok', 'indexing', 'not-indexed', 'index-unavailable']) },
    },
    // T16: OTel GenAI execute_tool span per call (no-op unless MOLE_OTEL=1)
    async ({ target, impact, maxNodes }, extra) =>
      executeTool('mole_map', { [GEN_AI.toolCallId]: String(extra.requestId), [GEN_AI.mcpMethod]: 'tools/call', 'mole.target': target }, async (span) => {
      const client = opts.noStart ? new MoleClient(opts) : await ensureDaemon(opts);
      let n = await client.map(target, impact === true);
      for (let i = 0; i < 50 && n.state === 'indexing'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        n = await client.map(target, impact === true);
      }
      span({ 'mole.map.state': n.state });
      // T50: maxNodes trims the response client-side, below whatever the daemon's own fixed cap already gave;
      // dropped nodes move into `more` (same shape the daemon already uses), so nothing vanishes silently.
      if (maxNodes !== undefined && n.state === 'ok' && n.nodes.length > maxNodes) {
        const kept = n.nodes.slice(0, Math.max(1, maxNodes)); // always keep the focus node
        const dropped = n.nodes.slice(kept.length);
        const moreCounts = new Map(n.more.map((m) => [m.role, m.count]));
        for (const d of dropped) moreCounts.set(d.role, (moreCounts.get(d.role) ?? 0) + 1);
        const keptIds = new Set(kept.map((x) => x.id));
        n = { ...n, nodes: kept, more: [...moreCounts].map(([role, count]) => ({ role, count })), edges: n.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)) };
      }
      const text = formatNeighborhood(n);
      return { content: [{ type: 'text' as const, text }], isError: n.state === 'index-unavailable', structuredContent: sc({ text, state: n.state }) };
    }),
  );
  // T18: what agents already tried (commands, tests, fixes + outcome), including before a context compaction
  server.registerTool(
    'mole_tried',
    {
      title: 'Mole tried',
      description:
        'Commands, tests and edits an agent run already tried, each with its outcome (pass/fail/unknown) and the compaction it came before. ' +
        'Target = a run id (Hermes session, Claude Code or Codex session id, or a unique prefix) or file#Symbol / file (the runs that edited it). ' +
        'Read from the local transcripts (read-only); no LLM. Use after a compaction, before retrying a fix.',
      inputSchema: { target: z.string().describe('run id or prefix, file#Symbol, or repo-relative file') },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole tried' },
      outputSchema: z.object({ target: z.string(), runs: z.array(z.string()), items: z.array(z.unknown()), skipped: z.array(z.unknown()) }).passthrough(),
    },
    async ({ target }) => {
      const r = tried(target, { ...defaultSources(), root: opts.root });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
    },
  );
  // T24: what an agent says it did (its final answer) checked against what it did (its own tool calls + git)
  server.registerTool(
    'mole_claims',
    {
      title: 'Mole claims',
      description:
        "Checks an agent run's last answer: each claim (tests pass, N/N passed, exit 0, committed <sha>, merged, pushed, wrote <file>, fixed) " +
        "against the run's own tool calls and results and git, as supported / unsupported / contradicted with the evidence (tool call id, exit code, commit). " +
        'A claim only a subagent reported is unsupported. Same JSON as `mole claims <run> --json`. Deterministic patterns, no LLM.',
      inputSchema: { run: z.string().describe('run id (Hermes session, Claude Code or Codex session id, or a unique prefix)'), at: z.number().int().optional().describe('check the answer at this row instead of the last one') },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole claims' },
      outputSchema: z.object({
        run: z.string(),
        harness: z.string().nullable(),
        answer: z.unknown().nullable(),
        claims: z.array(z.unknown()),
        summary: z.object({ supported: z.number(), unsupported: z.number(), contradicted: z.number() }),
        nothing: z.boolean(),
        skipped: z.array(z.unknown()),
      }).passthrough(),
    },
    async ({ run, at }) => {
      try {
        const r = claims(run, { ...defaultSources(), at });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_claims: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerCollisionsTool(server, opts); // T21: parallel-agent collisions
  registerReasoningTools(server, opts); // T61: T60 priorities, T58 incident suggest, T56 proposals compare -- read-only
  registerHotspotsTool(server, opts); // T70: D68 hotspot ranking -- read-only
  registerCouplingTool(server, opts); // T77: D69 coupling x CODEOWNERS -- read-only
  registerOutcomesTool(server, opts); // T81: D66 outcome tracking log -- read-only
  // T39: external agent-session memory (Entire Checkpoints, git-ai Authorship Logs, Agent Trace v0.1.0) mapped
  // onto the function it touched, re-checked against the function's current body like a T11 note.
  server.registerTool(
    'mole_agent_intent',
    {
      title: 'Mole agent intent',
      description:
        'What an external agent-session tool (Entire Checkpoints, git-ai, or Agent Trace) recorded about why a function was written, anchored to that function and re-checked: ' +
        "fresh if the function's body is unchanged since, stale if it changed or the function is gone. Target = repo-relative file or file#Symbol. Consumes existing records; Mole captures nothing of its own here.",
      inputSchema: { target: z.string().describe('repo-relative file, or file#Symbol') },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole agent intent' },
      outputSchema: z.object({ target: z.string(), statuses: z.array(z.unknown()), misses: z.array(z.unknown()) }).passthrough(),
    },
    async ({ target }) => {
      try {
        const r = agentIntentsFor(opts.root, target);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_agent_intent: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerOneOnOneTool(server, opts); // T31: mole_oneonone (prep | readback)
  registerCompileAndCascadeTools(server, opts); // T46: mole_compile_draft, mole_compile_review, mole_cascade_check
  server.registerTool(
    'mole_check',
    {
      title: 'Mole check',
      description:
        'Before or after editing: for a change (the working tree vs HEAD, a commit sha, or a diff file + base), the past fix commits that last ' +
        'wrote the edited lines (git blame on the base), each with its reason (commit text, comments, task/note files), the tests that guard it ' +
        'and a source file:line in the fix; plus at most 3 questions about them. Same JSON as `mole check ... --json`. Git history only: no index, ' +
        'no daemon, no model calls. Give exactly one of sha, diff, worktree.',
      inputSchema: {
        root: z.string().optional().describe('repository root (default: the server root, MOLE_ROOT or cwd)'),
        sha: z.string().optional().describe('a commit: check what it changed against its parent'),
        diff: z.string().optional().describe('a unified diff file (relative to root or absolute)'),
        base: z.string().optional().describe('with diff: the commit the diff applies to (default HEAD)'),
        worktree: z.boolean().optional().describe('check the uncommitted working-tree change vs HEAD'),
        fixRule: z.string().optional().describe('regex for which commits count as fixes (default: fix/revert/regression/review fixes, or .mole/config.json)'),
        notesRoot: z.string().optional().describe('read .mole/notes from this directory instead of the root'),
        files: z.array(z.string()).optional().describe('T37: only report hunks on these repo-relative files (e.g. the files Edit/Write just touched); others are dropped from the result'),
        // T50 (core-audit rank 2): hunks can be unbounded on a growing repo/diff; same bounded+paginated shape as mole_decisions/mole_coverage.
        limit: z.number().int().nonnegative().optional().describe('page size over `hunks` (default: all, subject to maxAnswerChars)'),
        offset: z.number().int().nonnegative().optional().describe('page offset over `hunks` (default 0)'),
        maxAnswerChars: z.number().int().nonnegative().optional().describe(`ceiling on this page's serialized size in characters (default ${String(25_000)}); hunks are dropped from the end of the page, never mid-item, if exceeded`),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole check' },
      outputSchema: z.object({ hunks: z.array(z.unknown()), questions: z.array(z.unknown()).optional(), total: z.number().optional(), offset: z.number().optional(), hasMore: z.boolean().optional(), nextOffset: z.number().optional(), truncated: z.string().optional() }).passthrough(),
    },
    async (args) => {
      const modes = [args.sha !== undefined, args.diff !== undefined, args.worktree === true].filter(Boolean).length;
      if (modes !== 1) return { content: [{ type: 'text' as const, text: 'mole_check: give exactly one of sha, diff (+ base) or worktree: true' }], isError: true };
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const json = await checkJson(root, args);
        // T37: files-scoped view, so a hook can ask "what does mole_check say about just the file I'm about to touch"
        if (args.files?.length) {
          const want = new Set(args.files);
          const hunks = Array.isArray(json.result.hunks) ? (json.result.hunks as Array<{ file: string }>).filter((h) => want.has(h.file)) : json.result.hunks;
          const keptFiles = new Set((Array.isArray(hunks) ? hunks : []).map((h) => h.file));
          const questions = Array.isArray(json.result.questions) ? (json.result.questions as Array<{ source?: { file?: string } }>).filter((q) => !q.source?.file || keptFiles.has(q.source.file)) : json.result.questions;
          json.result = { ...json.result, hunks, questions };
        }
        // T50 (core-audit rank 2): bound + paginate `hunks` -- the one array on this tool that can grow without limit
        // (a large diff / a long-lived worktree change). `questions` stays as-is: @mole/questions already caps it at 3.
        const allHunks = Array.isArray(json.result.hunks) ? json.result.hunks : [];
        const page = boundedPage(allHunks, args, (hunks) => ({ hunks }));
        json.result = { ...json.result, hunks: page.items, total: page.total, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), ...(page.truncated ? { truncated: page.truncated } : {}) };
        return { content: [{ type: 'text' as const, text: JSON.stringify(json.result, null, 2) }, ...json.notices.map((n) => ({ type: 'text' as const, text: `mole: ${n}` }))], structuredContent: sc(json.result) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_check: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  // T29: the decision graph (tenets, decisions, plain ADR folders) with citator flags; same JSON as `mole decisions --json`
  server.registerTool(
    'mole_decisions',
    {
      title: 'Mole decisions',
      description:
        'Every decision and tenet of the repo (.mole/tenets.md, .mole/decisions/*.md, plus plain ADR folders) with a flag and its reasons at file:line: ' +
        'red = superseded/deprecated/orphaned (every scope anchor gone)/retired tenet; yellow = a proposed record conflicts with or supersedes it, its scope code ' +
        'changed since the approver confirmed, an anchor or evidence test is missing or failing, or a record it traces to is yellow/red; green = accepted and intact; ' +
        'grey = proposed. Same JSON as `mole decisions --json`. Files + git only, no model calls. Use before editing code a decision covers.',
      inputSchema: {
        root: z.string().optional().describe('repository root (default: the server root, MOLE_ROOT or cwd)'),
        adrDir: z.array(z.string()).optional().describe('plain ADR folders to include, relative to root (e.g. docs/architecture-decisions)'),
        testReport: z.string().optional().describe('a vitest JSON report: evidence tests that fail there turn their decisions yellow'),
        files: z.array(z.string()).optional().describe('T37: only decisions whose scope: covers one of these repo-relative files or symbols in them (file exact match, path#Symbol by its file, folder/ by prefix) -- this is what the Claude Code / Codex / Cursor plugins call for "the decisions governing the files in play"'),
        // T50 (core-audit rank 2): the `decisions` array itself is now bounded + paginated too, on top of the T43
        // aggregate rationale budget above (that budget trims rationale TEXT; this trims the ARRAY of decisions).
        limit: z.number().int().nonnegative().optional().describe('page size over `decisions` (default: all, subject to maxAnswerChars)'),
        offset: z.number().int().nonnegative().optional().describe('page offset over `decisions` (default 0)'),
        maxAnswerChars: z.number().int().nonnegative().optional().describe(`ceiling on this page's serialized size in characters (default ${String(25_000)}); decisions are dropped from the end of the page, never mid-item, if exceeded`),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole decisions' },
      outputSchema: z.object({ decisions: z.array(z.unknown()), problems: z.array(z.unknown()).optional(), total: z.number().optional(), offset: z.number().optional(), hasMore: z.boolean().optional(), nextOffset: z.number().optional(), truncated: z.string().optional() }).passthrough(),
    },
    async (args) => {
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const { decisions, loadGraph } = await import('@mole/decisions');
        const json = decisions(root, { adrDirs: confineAllToRoot(root, args.adrDir, 'adrDir') ?? [], testReport: args.testReport ? confineToRoot(root, args.testReport, 'testReport') : undefined });
        if (args.files?.length) {
          const want = new Set(args.files);
          const scopeMatches = (scopeFile: string, changed: string) => scopeFile === changed || (scopeFile.endsWith('/') && (changed === scopeFile.slice(0, -1) || changed.startsWith(scopeFile)));
          const graph = loadGraph(root, { adrDirs: args.adrDir ?? [] });
          const governedIds = new Set(
            graph.nodes
              .filter((n) => n.scope.some((a) => [...want].some((f) => scopeMatches(a.target.split('#')[0]!, f))))
              .map((n) => n.id),
          );
          json.decisions = json.decisions.filter((d) => governedIds.has(d.id));
        } else {
          // T43 review fix P2: without `files` to scope the call, a repo with many decisions/tenets, each
          // carrying real rationale text (T43's own feature), had no total cap -- `mole_decisions` could
          // return an unbounded response. Whole-decision dropping (never mid-rationale), ranked by flag
          // severity so decisions that most need attention (red, then yellow) keep their full text longest;
          // a dropped decision keeps every other field (id/title/status/flag/reasons), just not `rationale`.
          const SEVERITY_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2, grey: 3 };
          const candidates = json.decisions.filter((d) => d.rationale);
          const ranked = [...candidates].sort((a, b) => (SEVERITY_RANK[a.flag] ?? 4) - (SEVERITY_RANK[b.flag] ?? 4));
          let used = 0;
          let dropped = 0;
          const keepIds = new Set<string>();
          for (const d of ranked) {
            const len = d.rationale!.length;
            if (used + len <= MCP_DECISIONS_RATIONALE_AGGREGATE_BUDGET) {
              used += len;
              keepIds.add(d.id);
            } else {
              dropped += 1;
            }
          }
          if (dropped > 0) {
            json.decisions = json.decisions.map((d) => (d.rationale && !keepIds.has(d.id) ? { ...d, rationale: undefined } : d));
            (json as DecisionsResultWithTruncation).truncated = `${dropped} more: full rationale omitted at the aggregate budget (${MCP_DECISIONS_RATIONALE_AGGREGATE_BUDGET} chars total) -- pass \`files\` to get the full rationale for specific decisions`;
          }
        }
        // T50 (core-audit rank 2): bound + paginate the `decisions` ARRAY itself (separate from the rationale-text
        // budget above), same shared helper as mole_check/mole_coverage.
        const page = boundedPage(json.decisions, args, (decisions) => ({ decisions }));
        const priorTruncated = (json as DecisionsResultWithTruncation).truncated;
        const out = {
          ...json,
          decisions: page.items,
          total: page.total,
          offset: page.offset,
          hasMore: page.hasMore,
          ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
          ...(priorTruncated || page.truncated ? { truncated: [priorTruncated, page.truncated].filter(Boolean).join(' | ') } : {}),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }], structuredContent: sc(out) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_decisions: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  // T35 (M27): which agents cover which code, and where nobody does -- blast radius / weak spots, in the one panel
  // where the agent or developer already works (D31). Same JSON as `mole coverage --json`.
  server.registerTool(
    'mole_coverage',
    {
      title: 'Mole agent coverage',
      description:
        'Which agent sessions (Hermes, Claude Code, Codex) read or edited a file, when a human last looked (T13), what tests guard it and what decision ' +
        'governs it (T29), with a weak-spot reason computed from that data: agent-edited with no human read since, and no guarding test or a red/yellow ' +
        "decision. Read-only: local session logs + git + .mole/ records, never message text, nothing leaves the machine. Use to see a session's blast radius " +
        'or which files in the repo nobody has reviewed after an agent changed them.',
      inputSchema: {
        root: z.string().optional().describe('repository root (default: the server root, MOLE_ROOT or cwd)'),
        file: z.string().optional().describe('one file, repo-relative or absolute; omit for the whole repo scan'),
        session: z.string().optional().describe('filter to files touched by this session id (or its prefix)'),
        weak: z.boolean().optional().describe('only files flagged as a weak spot'),
        // T50 (core-audit rank 2): a whole-repo scan (`file` omitted) can be unbounded on a large repo; same
        // bounded+paginated shape as mole_check/mole_decisions. Has no effect on the single-`file` call (one record).
        limit: z.number().int().nonnegative().optional().describe('page size over `files` on a whole-repo scan (default: all, subject to maxAnswerChars)'),
        offset: z.number().int().nonnegative().optional().describe('page offset over `files` (default 0)'),
        maxAnswerChars: z.number().int().nonnegative().optional().describe(`ceiling on this page's serialized size in characters (default ${String(25_000)}); files are dropped from the end of the page, never mid-item, if exceeded`),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole agent coverage' },
      // loose on purpose: `file` (one record: file/agents/human/tests/decisions/weak), the whole-scan shape
      // (scannedAt/files/skipped/malformed/notice + T50's total/offset/hasMore/nextOffset/truncated), and the
      // bare-notice shape are three different top-level shapes from the same tool -- every field stays optional.
      outputSchema: z.object({
        files: z.array(z.unknown()).optional(),
        notice: z.string().nullable().optional(),
        scannedAt: z.string().optional(),
        skipped: z.array(z.unknown()).optional(),
        malformed: z.number().optional(),
        total: z.number().optional(),
        offset: z.number().optional(),
        hasMore: z.boolean().optional(),
        nextOffset: z.number().optional(),
        truncated: z.string().optional(),
      }).passthrough(),
    },
    async (args) => {
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const { coverage, scanCoverage } = await import('./_oss-coverage-stub.js');
        if (args.file) {
          // T91 review fix MEDIUM: `file` is a path-shaped arg like any other -- confine it the same way
          // `root` already is, so it can't point outside the server root (absolute escape or `..` traversal).
          const file = confineToRoot(root, args.file, 'file');
          const r = await coverage(root, file);
          return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
        }
        const scan = scanCoverage(root);
        if (scan.notice) return { content: [{ type: 'text' as const, text: scan.notice }], structuredContent: sc({ notice: scan.notice, files: [] }) };
        let files = scan.files;
        if (args.session) files = files.filter((f) => f.agents.some((a) => a.session.startsWith(args.session!)));
        if (args.weak) files = files.filter((f) => f.weak.is);
        // T50 (core-audit rank 2): bound + paginate `files` on a whole-repo scan.
        const page = boundedPage(files, args, (files) => ({ files }));
        const out = { ...scan, files: page.items, total: page.total, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), ...(page.truncated ? { truncated: page.truncated } : {}) };
        return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }], structuredContent: sc(out) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_coverage: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  // T23: agents interrogate, people write (D38). Up to 3 pointed questions + which decision(s) govern the change,
  // built only from facts Mole already found (diff hunks, past fixes, governing decisions); silent when nothing
  // governs the change. Mole never drafts a decision record's own why/(internal reference removed) text (R6).
  server.registerTool(
    'mole_interrogate',
    {
      title: 'Mole interrogate',
      description:
        'For a code change, which decisions (.mole/decisions) govern the files it touches, and up to 3 pointed questions ' +
        'built from evidence Mole already found (diff hunks, past fixes + guarding tests, the governing decision) — never ' +
        'a question invented about something code did not find. Silent (governed: false, 0 questions) when nothing governs ' +
        'the change. Files + git only, no model calls by default (R6).',
      inputSchema: {
        root: z.string().optional().describe('repository root (default: the server root, MOLE_ROOT or cwd)'),
        sha: z.string().optional().describe('a commit sha to interrogate'),
        diff: z.string().optional().describe('a diff file to interrogate (with base)'),
        base: z.string().optional().describe('base sha for diff'),
        worktree: z.boolean().optional().describe('interrogate the uncommitted working tree'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole interrogate' },
      outputSchema: z.object({ governed: z.boolean().optional(), questions: z.array(z.unknown()).optional(), decisions: z.array(z.unknown()).optional() }).passthrough(),
    },
    async (args) => {
      const modes = [args.sha !== undefined, args.diff !== undefined, args.worktree === true].filter(Boolean).length;
      if (modes !== 1) return { content: [{ type: 'text' as const, text: 'mole_interrogate: give exactly one of sha, diff (+ base) or worktree: true' }], isError: true };
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const { interrogate } = await import('@mole/intake');
        const change = args.sha ? { sha: args.sha } : args.diff ? { diffFile: args.diff, base: args.base } : { worktree: true as const };
        const result = await interrogate(root, change);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: sc(result) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_interrogate: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  // T38: as-of answers from the bitemporal decision graph in Postgres (what held on a given date),
  // beside what a latest-only store would answer. Same engine @mole/temporal uses for its M32 bench.
  server.registerTool(
    'mole_decisions_asof',
    {
      title: 'Mole decisions as-of',
      description:
        "What a decision's status held on a given date (application/valid time), from the bitemporal store in Postgres " +
        '(EXCLUDE USING gist enforces 0 overlapping validity rows; history is append-only). Needs MOLE_TEMPORAL_PG ' +
        '(a Postgres connection string) in the environment; returns an error, not a guess, if it is unset or unreachable. ' +
        '0 model calls.',
      inputSchema: {
        decisionId: z.string().describe("a decision id, e.g. 'D24'"),
        attr: z.string().optional().describe("the fact attribute (default 'status')"),
        asOf: z.string().describe('an ISO timestamp: what held at that instant'),
      },
      // T50: the audit's own rank-3 recommendation names this tool explicitly ("readOnlyHint: true,
      // openWorldHint: false on all 8" -- agent-surfaces.md section 1 item 1) even though it reads Postgres: it
      // never writes and is not an open-world (web/API) call in the sense the annotation means.
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole decisions as-of' },
      outputSchema: { value: z.string() },
    },
    async (args) => {
      const connectionString = process.env.MOLE_TEMPORAL_PG;
      if (!connectionString) {
        return { content: [{ type: 'text' as const, text: 'mole_decisions_asof: set MOLE_TEMPORAL_PG (a Postgres connection string) to use this tool' }], isError: true };
      }
      try {
        const { openPool, asOf } = await import('@mole/temporal');
        const pool = openPool(connectionString);
        try {
          const value = (await asOf(pool, args.decisionId, args.attr ?? 'status', args.asOf)) ?? 'not yet proposed';
          return { content: [{ type: 'text' as const, text: value }], structuredContent: { value } };
        } finally {
          await pool.end();
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_decisions_asof: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  return server;
}


export interface CheckArgs {
  sha?: string;
  diff?: string;
  base?: string;
  worktree?: boolean;
  fixRule?: string;
  notesRoot?: string;
}

/**
 * Exactly what `mole check <change> --json` prints (packages/daemon/src/cli.ts): T12's CheckResult with T14's questions, the
 * questions' internal facts (notes, guards) left out. Loaded lazily: git history + questions only, never the indexer.
 */
export async function checkJson(root: string, args: CheckArgs): Promise<{ result: Record<string, unknown>; notices: string[] }> {
  const { questions } = await import('@mole/questions');
  const diffPath = args.diff !== undefined ? confineToRoot(root, args.diff, 'diff') : undefined;
  const change: Change = diffPath !== undefined ? { diffFile: diffPath, base: args.base } : args.sha !== undefined ? { sha: args.sha } : { worktree: true };
  const q = await questions(root, change, { fixRule: args.fixRule, notesRoot: args.notesRoot ? confineToRoot(root, args.notesRoot, 'notesRoot') : undefined });
  const { notes: _notes, guards: _guards, ...r } = q.facts;
  return { result: { ...r, questions: q.questions }, notices: q.notices };
}
