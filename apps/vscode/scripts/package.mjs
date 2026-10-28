// Builds the self-contained extension package:  npm run package -w @mole/vscode   ->  apps/vscode/mole-code-map-<version>.vsix
// 1. bundles everything (esbuild.mjs), 2. stages only the files the extension needs (no node_modules, no sources),
// 3. runs vsce on the stage. Publishing is a separate, deliberate step: see PUBLISH.md.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(ext, '.stage');
execFileSync('node', ['esbuild.mjs'], { cwd: ext, stdio: 'inherit' });

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });
for (const f of ['extension.cjs', 'webview.js', 'daemon.cjs', 'worker.cjs', ...readdirSync(join(ext, 'dist')).filter((n) => /^lib\..*\.d\.ts$/.test(n))]) cpSync(join(ext, 'dist', f), join(stage, 'dist', f));
for (const f of ['README.md', 'CHANGELOG.md']) cpSync(join(ext, f), join(stage, f));
for (const dir of [ext, resolve(ext, '../..')]) if (existsSync(join(dir, 'LICENSE')) && !existsSync(join(stage, 'LICENSE'))) cpSync(join(dir, 'LICENSE'), join(stage, 'LICENSE'));
cpSync(join(ext, 'media'), join(stage, 'media'), { recursive: true });

// the workspace manifest is named @mole/vscode and private; the published one is a plain extension manifest
const m = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8'));
for (const k of ['private', 'type', 'scripts', 'dependencies', 'devDependencies']) delete m[k];
m.name = process.env.MOLE_EXT_NAME ?? 'mole-code-map';
m.publisher = process.env.MOLE_PUBLISHER ?? m.publisher;
const repoUrl = String(m.repository?.url ?? '').replace(/\.git$/, '');
writeFileSync(join(stage, 'package.json'), JSON.stringify(m, null, 2) + '\n');
writeFileSync(join(stage, '.vscodeignore'), '**/*.map\n');

const out = join(ext, `${m.name}-${m.version}.vsix`);
rmSync(out, { force: true });
const vsce = resolve(ext, '../../node_modules/.bin/vsce');
// the extension lives in apps/vscode of the repository: vsce would otherwise rewrite the README screenshot to <repo>/raw/HEAD/media/panel.png
const args = ['package', '--no-dependencies', '--out', out, ...(repoUrl ? ['--baseContentUrl', `${repoUrl}/blob/HEAD/apps/vscode`, '--baseImagesUrl', `${repoUrl}/raw/HEAD/apps/vscode`] : ['--allow-missing-repository', '--no-rewrite-relative-links']), ...(process.env.MOLE_PRERELEASE ? ['--pre-release'] : [])];
execFileSync(vsce, args, { cwd: stage, stdio: 'inherit' });
console.log(`\nbuilt ${out}`);
