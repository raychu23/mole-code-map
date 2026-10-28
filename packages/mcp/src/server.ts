import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatNeighborhood } from '@mole/core';
import { ensureDaemon, MoleClient, type EnsureOptions } from '@mole/daemon';

export interface MoleMcpOptions extends EnsureOptions {
  /** Do not spawn a daemon if none runs (tests). */
  noStart?: boolean;
}

/** `mole_map(path|symbol)`: the same ranked neighbourhood the editor panel draws, as compact text for an agent. */
export function createServer(opts: MoleMcpOptions): McpServer {
  const server = new McpServer({ name: 'mole', version: '0.0.0' });
  server.registerTool(
    'mole_map',
    {
      title: 'Mole map',
      description:
        'Ranked neighbourhood (<=25 nodes) of a file or symbol: what it defines, who calls it, what it calls, who imports it. ' +
        'Facts come from the TypeScript compiler index with file:line evidence; no LLM. Use before reading unfamiliar code. ' +
        'For "called by" and "imported by" the line is where the call or import happens (the first one; ×N means N sites); for everything else it is the declaration line.',
      inputSchema: {
        target: z.string().describe('repo-relative file (src/a.ts), file#Symbol (src/a.ts#Cls.method), or a bare symbol name'),
        impact: z.boolean().optional().describe('also mark transitive callers (what breaks if this changes) with !impact'),
      },
    },
    async ({ target, impact }) => {
      const client = opts.noStart ? new MoleClient(opts) : await ensureDaemon(opts);
      let n = await client.map(target, impact === true);
      for (let i = 0; i < 50 && n.state === 'indexing'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        n = await client.map(target, impact === true);
      }
      return { content: [{ type: 'text' as const, text: formatNeighborhood(n) }], isError: n.state === 'index-unavailable' };
    },
  );
  return server;
}
