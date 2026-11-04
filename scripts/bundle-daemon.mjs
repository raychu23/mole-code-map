// Shared esbuild step for @mole/daemon's CLI entry + worker thread (and, when a caller needs it, the MCP
// stdio server). Factored out of apps/vscode/esbuild.mjs's daemon-bundling block (T86/D97) so the three
// places that bundle the same TypeScript sources with the same esbuild options do it once:
//   - apps/vscode/esbuild.mjs        dist/daemon.cjs + dist/worker.cjs           (unchanged externals/output)
//   - release/mole-code/tools/build.mjs    dist/cli.js + dist/worker.cjs + dist/mcp.cjs
//   - plugins/claude-code/scripts/build.mjs  dist/cli.js + dist/worker.cjs + dist/mcp.cjs
//
// import.meta does not exist in CommonJS; @mole/daemon's client.ts/server.ts use it only to find sibling
// files (defaultCli, workerFile), so it is pointed at the bundle file itself instead of left undefined.
// dependency-cruiser (ESM, top-level await) can never go in a CJS bundle; a native addon (better-sqlite3)
// can never be bundled by esbuild either -- both must be in `externals` for any caller that reaches them
// (mole-code/the plugin vendor both into dist/node_modules instead of leaving them as npm dependencies;
// see (internal reference removed) insights.md and (internal reference removed) insights.md for why).
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Resolves <name>'s installed package directory. `require.resolve(`${name}/package.json`)` fails for a
 * package whose exports map has no "./package.json" entry and no "require" condition on "."
 * (dependency-cruiser is both -- ESM-only, `import` condition only on "."): fall back to resolving its main
 * entry via `import.meta.resolve` (which honors "import") and walk up to the nearest package.json. */
export function resolvePackageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    return dir;
  }
}

/**
 * Vendors `name` AND its full runtime `dependencies` closure (recursively) into `<outDir>/node_modules/`,
 * copied from this repo's own already-resolved install (never running `npm install` itself). Shared by
 * release/mole-code/tools/build.mjs and plugins/claude-code/scripts/build.mjs to vendor dependency-cruiser +
 * typescript (see bundleDaemon's header for why they are vendored, not listed as `dependencies` of the
 * shipped package) -- vendoring only the package's own directory and skipping its transitive dependencies
 * silently breaks at runtime (`Cannot find package 'safe-regex'` was the first one T86's review hit;
 * dependency-cruiser alone pulls in 18 direct dependencies). A package with no real own-directory
 * dependency on another vendored package (e.g. `typescript`, no `dependencies` of its own) still needs a
 * SEPARATE explicit `vendorPackageTree(name, ...)` call from the build script -- this only follows a
 * package's declared `dependencies`, not everything a caller happens to need. `visited` lets a caller
 * vendor more than one root package into the same outDir without re-copying a package both already pulled in.
 * @param {string} name
 * @param {string} outDir absolute dist dir; packages land in `<outDir>/node_modules/<name>`
 * @param {Set<string>} [visited]
 */
export function vendorPackageTree(name, outDir, visited = new Set()) {
  if (visited.has(name)) return;
  visited.add(name);
  const src = resolvePackageDir(name);
  const dest = join(outDir, 'node_modules', name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (p) => !/(^|\/)(test|tests|\.github|\.git|\.husky|coverage|examples?|docs?|\.vscode)(\/|$)/.test(p) });
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).dependencies ?? {};
  } catch {
    /* no package.json or unparsable -- nothing to recurse into */
  }
  for (const dep of Object.keys(deps)) vendorPackageTree(dep, outDir, visited);
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot absolute path to the monorepo root (packages/daemon lives at <repoRoot>/packages/daemon)
 * @param {string} opts.outDir absolute output directory
 * @param {string} opts.cliOutfile output filename (relative to outDir) for packages/daemon/src/cli.ts
 * @param {string} [opts.workerOutfile] output filename for packages/daemon/src/worker.ts (default 'worker.cjs')
 * @param {string} [opts.mcpEntry] absolute path to an MCP entry point to also bundle (omit to skip it)
 * @param {string} [opts.mcpOutfile] output filename for the MCP bundle (required when mcpEntry is set)
 * @param {string} [opts.format] esbuild output format for every entry point (default 'cjs' -- the only format
 *   this importMeta banner works with; an 'esm' caller needs its own banner and should not pass this)
 * @param {string[]} [opts.externals] esbuild `external` list (default: dependency-cruiser + better-sqlite3)
 * @param {boolean} [opts.sourcemap] default false
 */
export async function bundleDaemon({ repoRoot, outDir, cliOutfile, workerOutfile = 'worker.cjs', mcpEntry, mcpOutfile, format = 'cjs', externals = ['dependency-cruiser', 'better-sqlite3'], sourcemap = false }) {
  const common = { bundle: true, sourcemap, logLevel: 'info', target: 'node22', platform: 'node', format };
  const importMeta = { define: { 'import.meta.url': '__importMetaUrl' }, banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" } };
  const jobs = [
    build({ ...common, ...importMeta, external: externals, entryPoints: [join(repoRoot, 'packages/daemon/src/cli.ts')], outfile: join(outDir, cliOutfile) }),
    build({ ...common, ...importMeta, external: externals, entryPoints: [join(repoRoot, 'packages/daemon/src/worker.ts')], outfile: join(outDir, workerOutfile) }),
  ];
  if (mcpEntry) {
    if (!mcpOutfile) throw new Error('bundleDaemon: mcpOutfile is required when mcpEntry is set');
    jobs.push(build({ ...common, ...importMeta, external: externals, entryPoints: [mcpEntry], outfile: join(outDir, mcpOutfile) }));
  }
  await Promise.all(jobs);
}
