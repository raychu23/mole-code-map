// T21: MCP tool mole_collisions — which parallel agent runs touch the same functions, or functions within 2 call hops.
// Kept in its own file so server.ts only gains one registration line (T15 edits server.ts too).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collisions, defaultSources } from './_oss-agentstate-stub.js';
import { READ_ONLY_ANNOTATIONS, sc } from './annotations.js'; // T50: shared read-only annotations + structuredContent cast

export function registerCollisionsTool(server: McpServer, opts: { root: string }): void {
  server.registerTool(
    'mole_collisions',
    {
      title: 'Mole collisions',
      description:
        'Pairs of agent runs (Hermes, Claude Code, Codex sessions on this machine) that worked at the same time (windows within 15 min) ' +
        'and touched the same function, or functions within 2 call hops of each other (T1 call graph): both run ids + harness, the shared ' +
        'functions, the call path, and which run changed or read what, newest first. Also lists edits to functions that carry a note. ' +
        'Read from the local transcripts (read-only); only finished steps count; no LLM. Use at session start (who else is touching this) ' +
        'and before you stop (what you changed that another run depends on).',
      inputSchema: {
        run: z.string().optional().describe('only the pairs of this run id (your session id, or a unique prefix)'),
        since_hours: z.number().optional().describe('runs active in the last N hours (default 24)'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole collisions' },
      outputSchema: z.object({ windowMinutes: z.number(), hops: z.number(), runs: z.array(z.unknown()), pairs: z.array(z.unknown()), notes: z.array(z.unknown()), skipped: z.array(z.unknown()) }).passthrough(),
    },
    async ({ run, since_hours }) => {
      const r = collisions({ ...defaultSources(), root: opts.root, run, since: since_hours !== undefined ? Date.now() - since_hours * 3600_000 : undefined });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
    },
  );
}
