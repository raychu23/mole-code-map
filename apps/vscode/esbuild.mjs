// Bundles the extension host code (CommonJS, vscode external), the webview script (browser IIFE) and the daemon + index
// worker (CommonJS, TypeScript inlined) so the .vsix needs no node_modules and no repo checkout.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { bundleDaemon } from '../../scripts/bundle-daemon.mjs';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'node22' };
// import.meta does not exist in CommonJS: the daemon client uses it only as a fallback, but make it point at the bundle instead of undefined
const importMeta = { define: { 'import.meta.url': '__importMetaUrl' }, banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" } };
await build({ ...common, ...importMeta, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode'] });
await build({ ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' });
await build({ ...common, entryPoints: ['webview/panel.ts'], outfile: 'dist/panel.js', platform: 'browser', format: 'iife', target: 'es2022' });

// the daemon and its worker thread run as plain Node (the editor's own Node with ELECTRON_RUN_AS_NODE). server.ts / client.ts use
// import.meta.url to find sibling files, which does not exist in CommonJS: point it at the bundle file.
// dependency-cruiser (T27 `mole rules`, ESM with top-level await) can't go in a CJS bundle; the CLI loads it lazily, so the
// packaged daemon works without it and only `mole rules` needs a repo checkout (npm install).
// T86/D97: this daemon+worker bundling step is shared with release/mole-code and plugins/claude-code (scripts/bundle-daemon.mjs),
// unchanged here -- same outfile names, same single external (no better-sqlite3: unlike those two, the vsix never vendors it and
// never ran it external either; `mole runs|agents|collisions`' native dependency is simply not reachable from this bundle's own
// entry points today, so adding it to `externals` here would be a behavior change this task does not make).
await bundleDaemon({ repoRoot: resolve('../..'), outDir: resolve('dist'), cliOutfile: 'daemon.cjs', workerOutfile: 'worker.cjs', externals: ['dependency-cruiser'] });

// TypeScript finds its default lib files (lib.es2022.d.ts ...) next to the file it runs from, which is now dist/
const tsLib = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
mkdirSync('dist', { recursive: true });
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) copyFileSync(join(tsLib, f), join('dist', f));
