// Bundles the mole CLI (`mole`, @mole/daemon) + its worker thread + the MCP server (@mole/mcp) into
// plugins/claude-code/dist/, so the plugin works from a plain copy of this directory with no repo checkout
// and no `npm install` (T86). Used for local dev/testing of this directory directly (plugin-dir / relative
// marketplace source); the npm-sourced marketplace entry (D97) ships through release/mole-code instead, whose
// tools/build.mjs copies this directory's plugin.json/hooks.json/.mcp.json/scripts/*.mjs and runs the SAME
// shared bundling step (scripts/bundle-daemon.mjs, also used by apps/vscode/esbuild.mjs) — see that file's
// header for why each esbuild option is needed; this script just supplies plugins/claude-code's own outDir.
//
//   node plugins/claude-code/scripts/build.mjs
//
// Output layout (CLAUDE_PLUGIN_ROOT-relative, used by .mcp.json and scripts/lib.mjs's findMole):
//   dist/cli.js       the daemon CLI ('mole ...'), CommonJS. Named cli.js (not daemon.cjs) ON PURPOSE:
//                      @mole/daemon's ensureDaemon() (packages/daemon/src/client.ts defaultCli()) falls back to
//                      '<dir of the running file>/cli.js' for any caller that isn't itself named daemon.cjs — the
//                      MCP bundle (dist/mcp.cjs) relies on exactly that fallback to find and spawn the daemon,
//                      with zero changes to @mole/mcp's source (out of this task's boundary).
//   dist/worker.cjs    the daemon's index worker thread (packages/daemon/src/server.ts's workerFile() looks for
//                      'worker.js' or 'worker.cjs' next to itself; cli.js's dirname is dist/, so this is found).
//   dist/mcp.cjs       the stdio MCP server, bundled from scripts/mcp-entry.ts at the repo root (NOT
//                      @mole/mcp/src/cli.ts directly — see that file's header for why: cli.ts's top-level await
//                      needs a CJS-incompatible output format, and esbuild's ESM format can't bundle some of this
//                      server's own CJS dependencies (typescript, yaml) either, so CJS + a wrapper that moves the
//                      awaits into an async function is the only format that works for every dependency at once).
//   dist/lib.*.d.ts    TypeScript's own default-lib files, copied next to the bundles (see tsLib comment below).
//   dist/node_modules/{dependency-cruiser,better-sqlite3}/  vendored from this repo's own install (T86/D97: both
//                      used to be left external+un-vendored or external+"install it yourself"; vendoring both the
//                      same way removes the only difference between them — see (internal reference removed)
//                      2 insights.md). better-sqlite3 ships only THIS machine's prebuilt .node (no universal
//                      binary exists); a different OS/arch degrades gracefully, same as before (every call site
//                      already tolerates a non-zero CLI exit — lib.mjs's moleJson() catches it and returns
//                      undefined, so the hook silently omits that section).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDaemon, resolvePackageDir, vendorPackageTree } from '../../../scripts/bundle-daemon.mjs';

const here = dirname(fileURLToPath(import.meta.url)); // plugins/claude-code/scripts
const pluginRoot = resolve(here, '..');
const repoRoot = resolve(pluginRoot, '../..');
const outDir = join(pluginRoot, 'dist');
const require = createRequire(import.meta.url);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// Force dist/*.js(.cjs) to load as CommonJS regardless of an ancestor package.json's "type" (this repo's root
// package.json is "type": "module" — without this, Node would try to parse cli.js as ESM and fail on the CJS
// `require` our importMeta banner emits). A plugin copied to a fresh directory with no ancestor package.json at
// all would default to CommonJS anyway; this just makes dist/ self-contained either way.
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

await bundleDaemon({
  repoRoot,
  outDir,
  cliOutfile: 'cli.js',
  workerOutfile: 'worker.cjs',
  mcpEntry: join(repoRoot, 'scripts/mcp-entry.ts'),
  mcpOutfile: 'mcp.cjs',
});

// TypeScript finds its default lib files (lib.es2022.d.ts ...) next to the file it runs from, which is now dist/
// (same fix as apps/vscode/esbuild.mjs — packages/indexer, @mole/memory, @mole/flows etc. load the real `typescript`
// compiler at runtime for symbol/call-graph extraction, not just for this repo's own `tsc -b`).
const tsLib = dirname(require.resolve('typescript/lib/typescript.js'));
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) copyFileSync(join(tsLib, f), join(outDir, f));

// vendor dependency-cruiser (pure JS, with its own full dependency closure -- see vendorPackageTree's header),
// typescript (fixes a real bug T86's review found: dependency-cruiser's own `tsPreCompilationDeps` TS-AST
// pass silently treats every import as rule-compliant unless a real `typescript` package is resolvable from
// dist/'s own node_modules or an ancestor -- see release/mole-code/tools/build.mjs's matching comment and
// (internal reference removed) insights.md), and better-sqlite3 (native, just the native binary +
// lib/) into dist/node_modules/, from this repo's own install, so `require(...)` resolves from dist/ with no
// repo checkout or npm install.
const vendored = new Set();
vendorPackageTree('dependency-cruiser', outDir, vendored);
vendorPackageTree('typescript', outDir, vendored);
console.log(`vendored dependency-cruiser + typescript + ${vendored.size - 2} further dependencies`);
{
  const name = 'better-sqlite3';
  const src = resolvePackageDir(name);
  const dest = join(outDir, 'node_modules', name);
  rmSync(dest, { recursive: true, force: true });
  // Skips the multi-megabyte build/ object files and headers (binding.gyp, src/, deps/) — only the prebuilt
  // .node + lib/ are needed at runtime.
  const nodeBinary = join(src, 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(nodeBinary)) {
    mkdirSync(join(dest, 'build', 'Release'), { recursive: true });
    copyFileSync(nodeBinary, join(dest, 'build', 'Release', 'better_sqlite3.node'));
    cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true });
    copyFileSync(join(src, 'package.json'), join(dest, 'package.json'));
    console.log(`vendored better-sqlite3's native binary for ${process.platform}-${process.arch}`);
  } else {
    console.log(`better-sqlite3 has no prebuilt binary at ${nodeBinary}: shipping without it (degrades, see README.md)`);
  }
}

console.log(`built plugins/claude-code/dist from ${repoRoot}`);
