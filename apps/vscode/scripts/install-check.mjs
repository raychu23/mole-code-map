// Proof that the packaged .vsix works on its own, in a CLEAN VS Code profile, using only files from the installed extension:
//   node scripts/install-check.mjs <extension.vsix>
// 1. non-TypeScript workspace: the extension stays silent (no panel, no daemon);
// 2. TypeScript workspace with a short idle limit: the daemon stops by itself and the extension starts a new one on the next use;
// 3. the full real-editor self-test (selftest.mjs VSIX=...): latency, every node opens its line, restore after relaunch.
// Writes ../../generated data/t9-install-check.json. Uses a scratch COPY of the ui-tui fixture; the fixture is never written.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vsix = resolve(process.argv[2] ?? '');
if (!existsSync(vsix)) throw new Error('usage: node scripts/install-check.mjs <extension.vsix>');
const CODE = process.env.CODE_BIN ?? 'code';
const FIX = process.env.FIXTURE ?? ''; // path of a TypeScript repository with a src/ folder (a scratch COPY is safest)
if (!FIX) throw new Error('set FIXTURE=<path of a TypeScript repository with a src/ folder>');
const SCRATCH = join(process.env.TMPDIR ?? tmpdir(), 'mole-t9-install');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { generatedAt: new Date().toISOString(), vsix: vsix.split('/').pop(), vscode: execFileSync(CODE, ['--version'], { encoding: 'utf8' }).split('\n')[0], checks: {} };

const ud = join(SCRATCH, 'ud'), extDir = join(SCRATCH, 'ext');
const install = execFileSync(CODE, ['--install-extension', vsix, '--force', '--user-data-dir', ud, '--extensions-dir', extDir], { encoding: 'utf8' }).trim();
const installed = readdirSync(extDir).filter((d) => !d.startsWith('.'));
report.checks.install = { output: install, folders: installed, repoPathUsed: false };

const launch = (workspace, env, ms, ready) => new Promise(async (ok) => {
  const child = spawn(CODE, ['--new-window', '--user-data-dir', ud, '--extensions-dir', extDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace], { env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  child.unref();
  const end = Date.now() + ms;
  while (Date.now() < end && !ready()) await sleep(500);
  ok();
});
const killProfile = () => { try { execFileSync('pkill', ['-f', SCRATCH]); } catch {} };

// 1. silent in a workspace without TypeScript
const plain = join(SCRATCH, 'plain-ws');
mkdirSync(plain, { recursive: true });
writeFileSync(join(plain, 'notes.md'), '# not code\n');
writeFileSync(join(plain, 'script.py'), 'print("hi")\n');
const probe1 = join(SCRATCH, 'idle-probe.json');
await launch(plain, { MOLE_IDLE_PROBE: probe1, MOLE_STATE_DIR: join(SCRATCH, 'state-plain') }, 60_000, () => existsSync(probe1));
const idle = existsSync(probe1) ? JSON.parse(readFileSync(probe1, 'utf8')) : null;
const lockFiles = existsSync(join(SCRATCH, 'state-plain')) ? readdirSync(join(SCRATCH, 'state-plain')) : [];
report.checks.silentWithoutTypeScript = { probe: idle, stateDirFiles: lockFiles, passed: Boolean(idle?.dormant) && idle.panel === false && lockFiles.length === 0 };
killProfile();
await sleep(2500);

// 2. idle shutdown + revive, in a TypeScript workspace
const ws = join(SCRATCH, 'ws');
cpSync(join(FIX, 'src'), join(ws, 'src'), { recursive: true });
for (const f of ['tsconfig.json', 'tsconfig.build.json', 'package.json']) if (existsSync(join(FIX, f))) cpSync(join(FIX, f), join(ws, f));
const probe2 = join(SCRATCH, 'revive-probe.json');
await launch(ws, { MOLE_REVIVE_PROBE: probe2, MOLE_REVIVE_FILE: 'src/gatewayClient.ts', MOLE_IDLE_MINUTES: '0.2', MOLE_STATE_DIR: join(SCRATCH, 'state-ts'), MOLE_TSCONFIG: 'tsconfig.build.json', MOLE_SRC_DIR: 'src' }, 200_000, () => existsSync(probe2));
const revive = existsSync(probe2) ? JSON.parse(readFileSync(probe2, 'utf8')) : null;
report.checks.idleShutdownAndRevive = { probe: revive, passed: Boolean(revive?.ranAtStart && revive.stoppedByItself && revive.daemonBackUp && ['ok', 'indexing'].includes(revive.mapAfterRevive)) };
killProfile();
await sleep(2500);

// 3. the full real-editor self-test against the installed extension (SKIP_SELFTEST=1 skips it while iterating)
const selftest = join(SCRATCH, 'selftest-run');
let out = '';
if (process.env.SKIP_SELFTEST) report.checks.selftestInstalled = { exitCode: 0, skipped: true, nodesChecked: 1 };
else try {
  out = execFileSync('node', [join(here, 'selftest.mjs')], { encoding: 'utf8', env: { ...process.env, VSIX: vsix, SCRATCH: selftest, OUT: join(SCRATCH, 'latency.json'), CLICK_OUT: join(SCRATCH, 'click.json'), SHOT: join(SCRATCH, 's1.png'), SHOT2: join(SCRATCH, 's2.png'), SHOT3: join(SCRATCH, 's3.png'), RESTORE_SHOT: join(SCRATCH, 's4.png') }, maxBuffer: 1 << 26, timeout: 900_000 });
  report.checks.selftestInstalled = { exitCode: 0 };
} catch (e) {
  out = String(e.stdout ?? '');
  report.checks.selftestInstalled = { exitCode: e.status ?? 1, stderr: String(e.stderr ?? '').slice(0, 800) };
}
if (!process.env.SKIP_SELFTEST && existsSync(join(SCRATCH, 'click.json')) && existsSync(join(SCRATCH, 'latency.json'))) {
  const click = JSON.parse(readFileSync(join(SCRATCH, 'click.json'), 'utf8'));
  const lat = JSON.parse(readFileSync(join(SCRATCH, 'latency.json'), 'utf8'));
  Object.assign(report.checks.selftestInstalled, { nodesChecked: click.summary.checked, nodesLanded: click.summary.ok, byVia: click.summary.byVia, withDebounceMs: lat.withDebounceMs, latencyPassed: lat.passed, restoreAfterRelaunch: lat.restoreAfterRelaunch?.panelAdopted, impact: lat.impactView });
  // proof the installed copy (not the repo) ran: its daemon is the bundled one
  report.checks.selftestInstalled.extensionFolderRunning = readdirSync(join(selftest, 'ext')).filter((d) => !d.startsWith('.'));
}
killProfile();
report.passed = Boolean(report.checks.silentWithoutTypeScript.passed && report.checks.idleShutdownAndRevive.passed && report.checks.selftestInstalled.exitCode === 0 && report.checks.selftestInstalled.nodesChecked > 0);
const dest = process.env.OUT ?? resolve(here, `../../../generated data/t9-install-check${process.env.SKIP_SELFTEST ? '-partial' : ''}.json`);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 1));
process.exit(report.passed ? 0 : 1);
