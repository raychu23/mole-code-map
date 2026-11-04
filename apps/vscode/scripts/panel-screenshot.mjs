// T34 one-panel: screenshot of the sidebar view on the Mole repo itself (done-when 5), same idiom as
// scripts/m26.mjs (code --extensionDevelopmentPath + MOLE_M26_CHECK), but with cfg.shot set so the extension
// waits after focusing the sidebar; this script takes the shot with `screencapture -x` once it sees the
// ".ready" marker. No osascript "activate" call (unlike scripts/selftest.mjs): a freshly spawned
// `code --new-window` session is already the frontmost window, so no Automation permission is needed — see
// (internal reference removed) insights.md for why selftest.mjs's approach doesn't work in this sandboxed run.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..');
const repoRoot = resolve(extRoot, '../..');
const taskLog = join(repoRoot, '(internal reference removed) log');
const CODE = process.env.CODE_BIN ?? 'code';
const DEST = process.env.OUT ?? join(taskLog, 'panel-view.png');

const SCRATCH = join(process.env.TMPDIR ?? tmpdir(), `mole-shot-${Date.now()}`);
mkdirSync(SCRATCH, { recursive: true });
const ud = join(SCRATCH, 'ud');
const extDir = join(SCRATCH, 'ext');
const cfgPath = join(SCRATCH, 'm26-check.json');
const resultPath = join(SCRATCH, 'result.json');
const shotBase = join(SCRATCH, 'shot');
// T62: WORKSPACE / FILES (comma list) / SCROLL_TO (section id) / MODEL_OUT (keep the rendered model) overrides
// T73: WHATIF_ORDER (comma list of tenet ids) scripts the reasoning section's "compare with order X" before the shot
const WORKSPACE = process.env.WORKSPACE ?? repoRoot;
const FILES = process.env.FILES ? process.env.FILES.split(',') : ['apps/vscode/src/panelData.ts'];
writeFileSync(cfgPath, JSON.stringify({ out: resultPath, shot: shotBase, files: FILES, ...(process.env.SCROLL_TO ? { scrollTo: process.env.SCROLL_TO } : {}), ...(process.env.WHATIF_ORDER ? { whatIfOrder: process.env.WHATIF_ORDER } : {}) }));
const env = { ...process.env, MOLE_M26_CHECK: cfgPath, MOLE_STATE_DIR: join(SCRATCH, 'state') };
const child = spawn(CODE, ['--new-window', '--user-data-dir', ud, '--extensions-dir', extDir, '--extensionDevelopmentPath', extRoot, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', WORKSPACE], { env, stdio: 'ignore' });

const deadline = Date.now() + 120_000;
let shot = false;
while (Date.now() < deadline) {
  if (!shot && existsSync(`${shotBase}.ready`)) {
    shot = true;
    try {
      execFileSync('screencapture', ['-x', DEST]);
      console.log(`screenshot -> ${DEST}`);
    } catch (e) {
      console.error('screencapture failed:', e.message);
    }
  }
  if (shot && existsSync(resultPath)) break;
  await new Promise((r) => setTimeout(r, 500));
}
try {
  process.kill(child.pid, 'SIGTERM');
} catch {
  // already exited
}
await new Promise((r) => setTimeout(r, 1500));
if (process.env.MODEL_OUT && existsSync(resultPath)) writeFileSync(process.env.MODEL_OUT, readFileSync(resultPath, 'utf8'));
try {
  rmSync(SCRATCH, { recursive: true, force: true });
} catch {
  // a lingering handle from the just-killed process; harmless, the OS will reclaim it
}
console.log(JSON.stringify({ shot, dest: shot ? DEST : null, exists: shot && existsSync(DEST) }));
process.exit(shot && existsSync(DEST) ? 0 : 1);
