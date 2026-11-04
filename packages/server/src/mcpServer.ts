// Remote MCP server (R0 prior-art.md §7): official MCP TypeScript SDK, streamable HTTP
// transport, OAuth 2.1 bearer auth (2025-06-18 spec) via requireBearerAuth, backed by the
// local test issuer. Tool calls are RLS-scoped by the token's `org` claim (§6 + §7 combined),
// so a token for org-b asking about org-a's file gets 0 results, never an error that would
// confirm org-a's data exists.
import express from 'express';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';
import type { Pool } from './db.js';
import { getGoverningDecisions } from './graph.js';
import type { TestIssuer } from './oauth.js';

export interface McpHttpServer {
  url: string;
  close(): Promise<void>;
  /** test helper: calls governing_decisions as the org embedded in `token`, over real HTTP+MCP */
  callToolAsOrg(token: string, tool: string, args: { org: string; file: string }): Promise<unknown[]>;
}

export interface McpTelemetry {
  withSpan<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
}

export async function createMcpHttpServer(opts: { pool: Pool; issuer: TestIssuer; telemetry?: McpTelemetry }): Promise<McpHttpServer> {
  const { pool, issuer, telemetry } = opts;

  const verifier = {
    async verifyAccessToken(token: string) {
      const claims = await issuer.verifyToken(token);
      return { token, clientId: claims.org, scopes: claims.scopes, expiresAt: claims.expiresAt, extra: { org: claims.org } };
    },
  };

  function buildMcpServer() {
    const srv = new McpServer({ name: 'mole-team-server', version: '0.0.0' });
    srv.registerTool(
      'governing_decisions',
      {
        description: 'Decisions/tenets governing a file, scoped to the caller org (D31 decision graph)',
        inputSchema: { org: z.string(), file: z.string() },
      },
      async ({ org, file }, extra) => {
        // The caller's authenticated org (from the bearer token) is the ONLY org scope ever
        // used for the query — `org` in args is what the caller is asking ABOUT, which may
        // legitimately differ (and then RLS returns nothing, per the M25 leak test).
        const viewerOrg = (extra as any)?.authInfo?.extra?.org ?? (extra as any)?.authInfo?.clientId;
        const run = async (): Promise<{ content: { type: 'text'; text: string }[] }> => {
          const rows = await getGoverningDecisions(pool, viewerOrg, file, { forOrg: org });
          return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
        };
        // Review round 1 P1 #5: mcpServer.ts had zero telemetry calls (only the job side,
        // rebuild.ts/checkrun.ts, emitted spans) — this is the "request" side for MCP, named
        // `execute_tool {tool.name}` per the GenAI span-naming convention (R0 §9).
        if (telemetry) {
          return telemetry.withSpan(
            'execute_tool governing_decisions',
            { 'mole.viewer_org': viewerOrg, 'mole.for_org': org, 'mole.file': file },
            run
          );
        }
        return run();
      }
    );
    return srv;
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/mcp',
    requireBearerAuth({ verifier: verifier as any }),
    async (req, res) => {
      // Stateless mode (sessionIdGenerator: undefined): one McpServer + one transport per
      // request, since a McpServer instance can only be connected to one transport at a time.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      const srv = buildMcpServer();
      await srv.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    url,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async callToolAsOrg(token, tool, args) {
      const client = new Client({ name: 'mole-m25-bench-client', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      try {
        const result = await client.callTool({ name: tool, arguments: args });
        const text = (result.content as any)?.[0]?.text ?? '[]';
        return JSON.parse(text);
      } finally {
        await client.close();
      }
    },
  };
}
