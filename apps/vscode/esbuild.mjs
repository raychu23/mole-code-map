// Bundles the extension host code (CommonJS, vscode external), the webview script (browser IIFE) and the daemon + index
// worker (CommonJS, TypeScript inlined) so the .vsix needs no node_modules and no repo checkout.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'node22' };
// import.meta does not exist in CommonJS: the daemon client uses it only as a fallback, but make it point at the bundle instead of undefined
const importMeta = { define: { 'import.meta.url': '__importMetaUrl' }, banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" } };
await build({ ...common, ...importMeta, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode'] });
await build({ ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' });

// the daemon and its worker thread run as plain Node (the editor's own Node with ELECTRON_RUN_AS_NODE). server.ts / client.ts use
// import.meta.url to find sibling files, which does not exist in CommonJS: point it at the bundle file.
const daemon = { ...common, ...importMeta, platform: 'node', format: 'cjs', sourcemap: false };
await build({ ...daemon, entryPoints: ['../../packages/daemon/src/cli.ts'], outfile: 'dist/daemon.cjs' });
await build({ ...daemon, entryPoints: ['../../packages/daemon/src/worker.ts'], outfile: 'dist/worker.cjs' });

// TypeScript finds its default lib files (lib.es2022.d.ts ...) next to the file it runs from, which is now dist/
const tsLib = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
mkdirSync('dist', { recursive: true });
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) copyFileSync(join(tsLib, f), join('dist', f));
