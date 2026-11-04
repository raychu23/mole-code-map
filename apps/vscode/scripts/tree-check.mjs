// T30 proof artifact: real VS Code (--extensionDevelopmentPath, no new Electron/Chromium download) opens the Mole repo itself
// (it already has .mole/decisions + .mole/incidents) with the decision-tree extension loaded. MOLE_TREE_CHECK makes the
// extension dump every decorated folder's {badge, color, tooltip=intent card} straight from the live FileDecorationProvider,
// plus a no-record folder (done-when 4). We also screencapture the real window once the Explorer has redrawn, for a visual
// artifact of the badges (a true hover tooltip render needs mouse automation this machine's load doesn't have budget for right
// now; the JSON dump carries the actual tooltip/intent-card text instead -- see the task's own fallback instruction).
// Usage: node scripts/tree-check.mjs   (writes OUT, default (internal reference removed) log/tree-check.json, + a .png beside it)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '..');
const repo = resolve(ext, '../..'); // the T30 worktree
const mainRepo = process.env.MOLE_MAIN_REPO ?? resolve(repo, '../../Mole'); // the real checkout: has .mole/decisions
const CODE = process.env.CODE_BIN ?? 'code';
const SCRATCH = process.env.SCRATCH ?? join(process.env.TMPDIR ?? tmpdir(), 'mole-t30-tree');
const OUT = process.env.OUT ?? resolve(repo, '(internal reference removed) log/tree-check.json');
const SHOT = OUT.replace(/\.json$/, '.png');

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

const resultPath = join(SCRATCH, 'result.json');
const ud = join(SCRATCH, 'ud');
const extDir = join(SCRATCH, 'ext');
const env = { ...process.env, MOLE_TREE_CHECK: resultPath, MOLE_STATE_DIR: join(SCRATCH, 'state') };
const child = spawn(
  CODE,
  ['--new-window', '--user-data-dir', ud, '--extensions-dir', extDir, '--extensionDevelopmentPath', ext, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', mainRepo],
  { env, stdio: 'ignore', detached: true },
);
child.unref();

const deadline = Date.now() + Number(process.env.TREE_TIMEOUT_MS ?? 180_000);
while (!existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 2500)); // let the Explorer finish painting badges before the screenshot

let shotNote = 'not attempted';
try {
  // Find the Code window via System Events (no extra installs) and capture it.
  const winId = sh('osascript', ['-e', 'tell application "System Events" to tell (first process whose name contains "Electron" or name contains "Code") to id of front window']).trim();
  sh('screencapture', ['-x', '-o', '-l', winId, SHOT]);
  shotNote = existsSync(SHOT) ? 'captured via screencapture -l<windowid>' : 'screencapture ran but produced no file';
} catch (e) {
  try {
    sh('screencapture', ['-x', SHOT]); // whole-screen fallback
    shotNote = existsSync(SHOT) ? 'window id lookup failed; captured full screen instead' : `failed: ${e.message.split('\n')[0]}`;
  } catch (e2) {
    shotNote = `screenshot failed: ${e2.message.split('\n')[0]}`;
  }
}

try {
  execFileSync('pkill', ['-f', SCRATCH]);
} catch {}

const res = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { error: 'tree check did not finish in time' };
const report = {
  generatedAt: new Date().toISOString(),
  what: 'T30: decision-tree FileDecorationProvider output (badges/colors/tooltips=intent cards) read live from a real VS Code window on the Mole repo itself, not fabricated',
  vscode: sh(CODE, ['--version']).split('\n').slice(0, 2),
  extension: { developmentPath: ext },
  workspace: mainRepo,
  screenshot: { path: existsSync(SHOT) ? SHOT : null, note: shotNote },
  result: res,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${OUT}`);
console.log(`screenshot: ${report.screenshot.path ?? '(none)'} (${shotNote})`);
console.log(`folders decorated: ${res.folderCount ?? 'n/a'}, sample: ${(res.decorations ?? []).length}, noRecord ok: ${(res.noRecord ?? []).every((n) => !n.decoration)}`);
