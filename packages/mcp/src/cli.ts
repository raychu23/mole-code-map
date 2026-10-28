#!/usr/bin/env node
// stdio MCP server. Root = MOLE_ROOT or cwd; MOLE_STATE_DIR / MOLE_TSCONFIG / MOLE_SRC_DIR as for the daemon CLI.
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const server = createServer({
  root: resolve(process.env.MOLE_ROOT ?? process.cwd()),
  stateDir: process.env.MOLE_STATE_DIR,
  tsconfig: process.env.MOLE_TSCONFIG,
  srcDir: process.env.MOLE_SRC_DIR,
});
await server.connect(new StdioServerTransport());
