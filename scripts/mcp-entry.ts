#!/usr/bin/env node
// T86/D97: esbuild entry point for the bundled MCP server, replacing packages/mcp/src/cli.ts as the thing we
// bundle (never modifying packages/mcp/src -- outside this task's boundary). Same logic as that file, with ONE
// change: everything after createServer() is wrapped in an async main() instead of living at module top level.
// Shared by release/mole-code/tools/build.mjs and plugins/claude-code/scripts/build.mjs via scripts/bundle-daemon.mjs
// (one MCP bundle format for both -- see (internal reference removed) insights.md).
//
// Why: packages/mcp/src/cli.ts has top-level `await server.connect(...)`. esbuild's CJS output format rejects
// top-level await outright ("Top-level await is currently not supported with the cjs output format"), and its ESM
// output format turns out not to help either -- several bundled CJS dependencies (typescript, yaml, ...) use a
// dynamic `require(computedName)` for their own Node-environment feature detection, which esbuild's ESM bundle can
// only shim for STATIC require() calls ("Dynamic require of \"process\" is not supported" from node_modules/yaml,
// "... \"fs\" ..." from typescript). CJS format has no such problem (it's Node's own real `require`), so this
// wrapper moves the awaits into a function and the whole file bundles as CJS like dist/cli.js and dist/worker.cjs.
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../packages/mcp/src/server.js';

async function main() {
  const server = createServer({
    root: resolve(process.env.MOLE_ROOT ?? process.cwd()),
    stateDir: process.env.MOLE_STATE_DIR,
    tsconfig: process.env.MOLE_TSCONFIG,
    srcDir: process.env.MOLE_SRC_DIR,
  });
  // T16: spans when MOLE_OTEL=1 (no-op otherwise); flush them when the client goes away
  const otel = await import('@mole/telemetry');
  if (await otel.startTelemetry('mole-mcp')) {
    const bye = () => void otel.shutdownTelemetry().finally(() => process.exit(0));
    process.stdin.on('end', bye);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, bye);
  }
  await server.connect(new StdioServerTransport());
}

main();
