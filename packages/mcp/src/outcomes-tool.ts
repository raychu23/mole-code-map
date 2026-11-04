// T81 (D66): `mole_outcomes` read-only MCP tool -- same JSON as `mole outcomes --json`. Follows the
// packages/mcp/src/coupling-tool.ts / assurance pattern (one registerX(server, opts) per feature file, read
// through @mole/decisions, never a second implementation).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outcomesReport } from '@mole/decisions';
import { READ_ONLY_ANNOTATIONS, sc } from './annotations.js';

interface Opts {
  root: string;
}

export function registerOutcomesTool(server: McpServer, opts: Opts): void {
  server.registerTool(
    'mole_outcomes',
    {
      title: 'Mole outcomes',
      description:
        'The outcome tracking log (D66): every decision record with an opt-in `prediction:` block (expected outcome, measurable signal, check_at date), its ' +
        'recorded `outcome:` (observed value, date, who -- the human\'s own verdict, never inferred), and any `rollout:` (a staged rollout\'s named ' +
        'treated/holdout scopes -- recording only, no assignment logic). `due=true` keeps only checks with no outcome yet and a passed (or today\'s) ' +
        'check_at. An outcome the human recorded as `result: contradicted` is flagged with a draft SUGGESTED incident (same shape the T58 incident ' +
        'files already use) for a person to review and save -- this tool never writes it, never accepts it, and never changes a decision\'s verdict. ' +
        'Same JSON as `mole outcomes --json`. Deterministic, no LLM, read-only.',
      inputSchema: {
        due: z.boolean().optional().describe('keep only due/overdue checks (no outcome yet, check_at <= today)'),
        today: z.string().optional().describe('YYYY-MM-DD to treat as "today" instead of the real clock'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole outcomes' },
      outputSchema: z.object({ root: z.string(), generatedAt: z.string(), entries: z.array(z.unknown()), malformed: z.array(z.unknown()) }).passthrough(),
    },
    async ({ due, today }) => {
      try {
        const r = outcomesReport(opts.root, { ...(due !== undefined ? { due } : {}), ...(today ? { today } : {}) });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_outcomes: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );
}
