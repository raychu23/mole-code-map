// Builds the `mole-code` npm package: the bundled CLI (`mole`) + MCP stdio server (`mole-mcp`) AND the
// Claude Code plugin files, all in one package (D97). Nothing this script writes is committed to git --
// see release/mole-code/.gitignore -- `npm run build` (or `node tools/build.mjs`) must run before
// `npm pack`/`npm publish`.
//
//   node tools/build.mjs
//
// Bundling: scripts/bundle-daemon.mjs (repo root), the same esbuild step apps/vscode/esbuild.mjs and
// plugins/claude-code/scripts/build.mjs use, bundles packages/daemon/src/cli.ts (+ worker.ts) and
// scripts/mcp-entry.ts (the MCP server as one more CJS bundle -- see that file's header for why a CJS
// wrapper entry point exists instead of bundling packages/mcp/src/cli.ts's top-level-await directly).
//
// Native-dep strategy (picked over T85's original "list as a real npm dependency" -- see
// (internal reference removed) insights.md's correction and (internal reference removed) insights.md):
// dependency-cruiser (pure JS, ESM+top-level-await, cannot go in a CJS bundle) and better-sqlite3 (native
// addon, cannot be bundled by esbuild either) are both VENDORED into dist/node_modules/ from this repo's own
// install, not left as `dependencies` of this package. Evidence this is the right call for a plugin shipped
// through Claude Code's npm plugin source (fetched 2026-11-03, code.claude.com/docs/en/plugins/marketplace-reference):
// "The package's install scripts ... never run, and its dependencies aren't installed during the fetch. If
// the package has a supported lockfile beside its package.json, Claude Code installs those ... in a separate
// step, also with scripts disabled" -- vendoring removes any dependency on that separate step succeeding (and
// removes the caret-resolution question T85 raised for dependency-cruiser entirely, by shipping the exact
// bytes this repo already resolved). better-sqlite3 vendors only this build machine's prebuilt .node binary
// (no universal binary exists); a different OS/arch degrades gracefully, same as plugins/claude-code already
// documents (every call site swallows a non-zero CLI exit).
//
// Plugin files: plugins/claude-code stays the single source of truth for hooks.json, plugin.json, .mcp.json
// and the hook scripts (scripts/lib.mjs, pre-tool-use.mjs, session-start.mjs, stop.mjs, user-prompt-submit.mjs,
// verify.mjs) -- this script only COPIES them here, never hand-duplicates their content. All of them already
// resolve the bundle through ${CLAUDE_PLUGIN_ROOT}, Claude Code's documented plugin-root variable
// (code.claude.com/docs/en/plugins/plugins-reference, fetched 2026-11-03), which for an npm-sourced plugin is
// this package's own installed directory -- so `dist/cli.js`-relative paths below (findMole() in scripts/lib.mjs)
// resolve correctly without any change to those files.
import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDaemon, resolvePackageDir, vendorPackageTree } from '../../../scripts/bundle-daemon.mjs';

const here = dirname(fileURLToPath(import.meta.url)); // release/mole-code/tools
const pkgRoot = resolve(here, '..'); // release/mole-code
const repoRoot = resolve(pkgRoot, '../..');
const pluginSrc = join(repoRoot, 'plugins/claude-code');
const require = createRequire(import.meta.url);
const outDir = join(pkgRoot, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

// 1. bundle the CLI, its worker thread, and the MCP server (shared esbuild step, see scripts/bundle-daemon.mjs)
await bundleDaemon({
  repoRoot,
  outDir,
  cliOutfile: 'cli.js',
  workerOutfile: 'worker.cjs',
  mcpEntry: join(repoRoot, 'scripts/mcp-entry.ts'),
  mcpOutfile: 'mcp.cjs',
});

// TypeScript finds its default lib files (lib.es2022.d.ts ...) next to the file it runs from, which is now
// dist/ (packages/indexer, @mole/memory, @mole/flows etc. load the real `typescript` compiler at runtime).
const tsLib = dirname(require.resolve('typescript/lib/typescript.js'));
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) copyFileSync(join(tsLib, f), join(outDir, f));

// 2. vendor dependency-cruiser (pure JS, with its own full dependency closure -- see vendorPackageTree's
// header), typescript, and better-sqlite3 (native, just the native binary + lib/) into dist/node_modules/,
// from this repo's own install -- see this file's header for why, instead of listing either as a
// `dependency`. `typescript` additionally fixes a real bug T86's review found (see
// (internal reference removed) insights.md): dependency-cruiser's own TypeScript-AST pass
// (`tsPreCompilationDeps`, needed for `mole rules` to match a rule against a .ts import at all) does its own
// `await tryImport('typescript')` and silently treats EVERY import as rule-compliant when that import fails
// -- which it does unless a real `typescript` package is resolvable from dist/'s own node_modules or an
// ancestor of it. Inside this monorepo that ancestor walk finds the repo root's `typescript` and the bug
// never shows; standalone (this package installed anywhere else) it always does.
const vendored = new Set();
vendorPackageTree('dependency-cruiser', outDir, vendored);
vendorPackageTree('typescript', outDir, vendored);
console.log(`vendored dependency-cruiser + typescript + ${vendored.size - 2} further dependencies`);
{
  const name = 'better-sqlite3';
  const src = resolvePackageDir(name);
  const dest = join(outDir, 'node_modules', name);
  rmSync(dest, { recursive: true, force: true });
  const nodeBinary = join(src, 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(nodeBinary)) {
    mkdirSync(join(dest, 'build', 'Release'), { recursive: true });
    copyFileSync(nodeBinary, join(dest, 'build', 'Release', 'better_sqlite3.node'));
    cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true });
    copyFileSync(join(src, 'package.json'), join(dest, 'package.json'));
    // its MIT notice must ship with the code we redistribute (T86 review 2 MEDIUM)
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dest, f));
    console.log(`vendored better-sqlite3's native binary for ${process.platform}-${process.arch}`);
  } else {
    console.log(`better-sqlite3 has no prebuilt binary at ${nodeBinary}: shipping without it (degrades, see README.md)`);
  }
}

// 3. copy the Claude Code plugin files from plugins/claude-code (the single source of truth for them) --
// never hand-duplicated here.
mkdirSync(join(pkgRoot, '.claude-plugin'), { recursive: true });
copyFileSync(join(pluginSrc, '.claude-plugin/plugin.json'), join(pkgRoot, '.claude-plugin/plugin.json'));
mkdirSync(join(pkgRoot, 'hooks'), { recursive: true });
copyFileSync(join(pluginSrc, 'hooks/hooks.json'), join(pkgRoot, 'hooks/hooks.json'));
copyFileSync(join(pluginSrc, '.mcp.json'), join(pkgRoot, '.mcp.json'));
rmSync(join(pkgRoot, 'scripts'), { recursive: true, force: true });
mkdirSync(join(pkgRoot, 'scripts'), { recursive: true });
for (const f of readdirSync(join(pluginSrc, 'scripts'))) {
  if (f === 'build.mjs' || f === 'mcp-entry.ts') continue; // the plugin's own build tooling / the entry point bundled above, not shipped as-is
  copyFileSync(join(pluginSrc, 'scripts', f), join(pkgRoot, 'scripts', f));
}

// 4. LICENSE, copied at build time (never hand-duplicated, never committed here -- see .gitignore)
copyFileSync(join(repoRoot, 'LICENSE'), join(pkgRoot, 'LICENSE'));

console.log(`built ${pkgRoot}: dist/cli.js, dist/worker.cjs, dist/mcp.cjs, .claude-plugin/, hooks/, scripts/, .mcp.json, LICENSE`);
