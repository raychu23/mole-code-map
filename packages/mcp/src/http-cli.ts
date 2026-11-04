#!/usr/bin/env node
// Streamable-HTTP MCP entrypoint ((internal task reference removed)). Same tool set as cli.ts (stdio), different
// transport -- see http.ts for why (Smithery URL-publish, Docker MCP catalog "remote" server type, VS
// Code/Cursor's "http" server config all want a URL, not a spawned process).
import { resolve } from 'node:path';
import { startMoleHttpServer } from './http.js';

const port = process.env.MOLE_HTTP_PORT ? Number(process.env.MOLE_HTTP_PORT) : 3917;
const host = process.env.MOLE_HTTP_HOST ?? '127.0.0.1';
// T91 review fix HIGH 1: binding past loopback needs BOTH of these set (see http.ts's file header) -- an
// operator who wants a reachable-from-other-machines endpoint has to opt in explicitly and set a token.
const allowNonLoopback = process.env.MOLE_HTTP_ALLOW_NON_LOOPBACK === '1';
const bearerToken = process.env.MOLE_HTTP_BEARER_TOKEN;

const server = await startMoleHttpServer(
  {
    root: resolve(process.env.MOLE_ROOT ?? process.cwd()),
    stateDir: process.env.MOLE_STATE_DIR,
    tsconfig: process.env.MOLE_TSCONFIG,
    srcDir: process.env.MOLE_SRC_DIR,
  },
  { port, host, allowNonLoopback, bearerToken }
);

// eslint-disable-next-line no-console -- this is the one line an operator watches to confirm it's up
console.log(`mole-mcp (streamable HTTP) listening at ${server.url}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void server.close().finally(() => process.exit(0)));
}
