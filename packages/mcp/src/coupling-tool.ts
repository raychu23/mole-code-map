// T77 (D69): `mole_coupling` read-only MCP tool -- same JSON as `mole coupling --json`. Follows the
// packages/mcp/src/hotspots-tool.ts pattern (one registerX(server, opts) per feature file, read
// through @mole/coupling, never a second implementation).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeCoupling } from '@mole/coupling';
import { READ_ONLY_ANNOTATIONS, sc } from './annotations.js';

interface Opts {
  root: string;
}

export function registerCouplingTool(server: McpServer, opts: Opts): void {
  server.registerTool(
    'mole_coupling',
    {
      title: 'Mole coupling',
      description:
        'Logical coupling from git co-change (code-maat\'s `coupling` analysis, D69): pairs of files that tend to change in the same commit. ' +
        'degree = truncated int(100 x shared commits / average(revisions of A, revisions of B)) -- code-maat\'s own `(int coupling)`, computed from ' +
        'the RAW average, not the ceiled one (ceiling is only applied to the separately-reported average-revs column). min-revs is checked against ' +
        'that same raw average AFTER pairing (a file alone under min-revs can still appear in a kept pair); max-coupling is checked against ' +
        'floor(degree), not the raw percentage. code-maat defaults: min-revs=5, min-shared-revs=5, min-coupling=30%, max-coupling=100%, ' +
        'max-changeset-size=30 -- a commit touching more files than that is dropped from every count, so one mass-reformat commit cannot manufacture ' +
        'coupling. Owners come from CODEOWNERS (GitHub syntax, last matching pattern wins) at HEAD. ' +
        'Cross-team pairs (both sides owned, owner sets disjoint) are always sorted first -- Cataldo & Herbsleb\'s socio-technical congruence: a ' +
        'technical coupling crossing a team boundary is the pair most likely nobody is actually coordinating across. Every pair carries its own ' +
        'evidence (shared commit count + up to 5 sample shas, both sides\' owners, and any Mole decisions whose scope covers both files) -- a pair ' +
        'is never returned without it. Same JSON as `mole coupling --json`. Deterministic, no model calls, read-only.',
      inputSchema: {
        top: z.number().int().positive().optional().describe('max pairs to return, cross-team first then by degree desc (default 10)'),
        since: z.string().optional().describe('restrict the git log to commits since this date (any `git log --since` value)'),
        minRevs: z.number().int().positive().optional().describe('code-maat min-revs: a file needs this many revisions to be considered (default 5)'),
        minSharedRevs: z.number().int().positive().optional().describe('code-maat min-shared-revs: a pair needs this many shared commits (default 5)'),
        minCoupling: z.number().min(0).max(100).optional().describe('code-maat min-coupling %: minimum degree to keep a pair (default 30)'),
        maxCoupling: z.number().min(0).max(100).optional().describe('code-maat max-coupling %: maximum degree to keep a pair (default 100)'),
        maxChangesetSize: z.number().int().positive().optional().describe('code-maat max-changeset-size: commits touching more files than this are dropped entirely (default 30)'),
        all: z.boolean().optional().describe('include non-source files (lockfiles/generated dirs stay excluded; same escape hatch as mole_hotspots)'),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Mole coupling' },
      outputSchema: z
        .object({
          pairs: z.array(z.unknown()),
          commitsConsidered: z.number(),
          filesConsidered: z.number(),
          codeownersPath: z.string().nullable(),
          minRevs: z.number(),
          minSharedRevs: z.number(),
          minCoupling: z.number(),
          maxCoupling: z.number(),
          maxChangesetSize: z.number(),
          all: z.boolean(),
          ms: z.number(),
        })
        .passthrough(),
    },
    async ({ top, since, minRevs, minSharedRevs, minCoupling, maxCoupling, maxChangesetSize, all }) => {
      try {
        const r = await computeCoupling(opts.root, {
          ...(top !== undefined ? { top } : {}),
          ...(since ? { since } : {}),
          ...(minRevs !== undefined ? { minRevs } : {}),
          ...(minSharedRevs !== undefined ? { minSharedRevs } : {}),
          ...(minCoupling !== undefined ? { minCoupling } : {}),
          ...(maxCoupling !== undefined ? { maxCoupling } : {}),
          ...(maxChangesetSize !== undefined ? { maxChangesetSize } : {}),
          ...(all !== undefined ? { all } : {}),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: sc(r) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_coupling: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );
}
