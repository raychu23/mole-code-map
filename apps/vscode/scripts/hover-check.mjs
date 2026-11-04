// T15 clean-profile hover check (done-when 5 + 6), in the style of T9's selftest/install-check:
//   node scripts/hover-check.mjs                 (repo build: --extensionDevelopmentPath, after `npm run build && npm run bundle`)
//   VSIX=<file> node scripts/hover-check.mjs     (the packaged extension, installed into a clean --user-data-dir/--extensions-dir)
// Scratch repo: `git clone --shared` of this repository at bdeff14 under $TMPDIR (never the real checkout), with one recorded look
// at Daemon.startWatching (so `mole since` has something to list) and packages/history/bench/fixtures/planted-m8.diff applied as
// an uncommitted edit on the lines past fix 9e19c51 wrote. VS Code runs the extension's MOLE_HOVER_CHECK routine: it asks
// vscode.executeHoverProvider at a touched line, records the hover text + gutter decorations, clicks the hover's links, waits for
// the panel's "Since you last looked" list, then stops the daemon and asks again (daemon down: no hover, no marks, no popups).
// Writes OUT (default "generated data/t15-hover-check.json", gitignored). Exit 0 = every check passed.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '..');
const repo = resolve(ext, '../..');
const CODE = process.env.CODE_BIN ?? 'code';
const VSIX = process.env.VSIX ? resolve(process.env.VSIX) : undefined;
const SCRATCH = process.env.SCRATCH ?? join(process.env.TMPDIR ?? tmpdir(), 'mole-t15-hover');
const OUT = process.env.OUT ?? resolve(repo, 'generated data/t15-hover-check.json');
const BASE = process.env.HOVER_BASE ?? 'bdeff14';
const DIFF = join(repo, 'packages/history/bench/fixtures/planted-m8.diff');
const FILE = 'packages/daemon/src/server.ts';
const LINE = Number(process.env.HOVER_LINE ?? 210); // 1-based: the line before the deleted "editing counts as use" comment
const EXPECT = { sha: '9e19c51', why: 'editing counts as use', test: 'idle shutdown (T9)' };
const cli = join(repo, 'packages/daemon/dist/cli.js');

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ws = join(SCRATCH, 'ws');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
sh('git', ['clone', '-q', '--shared', '--no-checkout', repo, ws]);
sh('git', ['-C', ws, 'checkout', '-q', '--detach', BASE]);
// a look before the edit (T13), so the panel's since list has an entry once the planted edit lands
const seenOut = sh(process.execPath, ['--no-warnings', cli, 'seen', `${FILE}#Daemon.startWatching`, '--root', ws]).trim();
sh('git', ['-C', ws, 'apply', DIFF]);
const status = sh('git', ['-C', ws, 'status', '--short']).trim();

const cfgPath = join(SCRATCH, 'hover-check.json');
const resultPath = join(SCRATCH, 'result.json');
writeFileSync(cfgPath, JSON.stringify({ out: resultPath, file: FILE, line: LINE, expect: EXPECT }));
const ud = join(SCRATCH, 'ud');
const extDir = join(SCRATCH, 'ext');
let installOutput = null;
if (VSIX) installOutput = sh(CODE, ['--install-extension', VSIX, '--force', '--user-data-dir', ud, '--extensions-dir', extDir]).trim();
const extArg = VSIX ? [] : ['--extensionDevelopmentPath', ext];
const env = { ...process.env, MOLE_HOVER_CHECK: cfgPath, MOLE_STATE_DIR: join(SCRATCH, 'state') };
const child = spawn(CODE, ['--new-window', '--user-data-dir', ud, '--extensions-dir', extDir, ...extArg, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', ws], { env, stdio: 'ignore', detached: true });
child.unref();

const deadline = Date.now() + Number(process.env.HOVER_TIMEOUT_MS ?? 300_000);
while (!existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 1500));
try {
  execFileSync('pkill', ['-f', SCRATCH]);
} catch {}
const res = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { error: 'hover check did not finish in time' };

const up = res.up ?? {};
const down = res.down ?? {};
const hoverText = String(up.hoverText ?? '');
const checks = {
  hoverShowsPastFix: [EXPECT.sha, EXPECT.why, EXPECT.test].every((s) => hoverText.includes(s)),
  gutterMarks: (up.decorations ?? 0) > 0,
  clickOpensCommit: up.clickCommit?.ok === true,
  clickOpensSource: up.clickSource?.ok === true,
  panelListsSince: (res.since?.rendered ?? 0) > 0,
  daemonDownNoHover: down.daemonRunning === false && down.moleHovers === 0,
  daemonDownNoMarks: down.daemonRunning === false && down.decorations === 0,
  noErrorPopups: res.popups?.patched === true && (res.popups?.count ?? -1) === 0,
};
const report = {
  generatedAt: new Date().toISOString(),
  what: 'T15 hover + gutter mark + since list in a clean VS Code profile, then the same with the daemon stopped',
  vscode: sh(CODE, ['--version']).split('\n').slice(0, 2),
  extension: VSIX ? { vsix: VSIX.split('/').pop(), installOutput } : { developmentPath: ext },
  scratch: { ws, base: BASE, diff: 'packages/history/bench/fixtures/planted-m8.diff', status, seenBeforeEdit: seenOut, note: 'git clone --shared of this repo under $TMPDIR; the real checkout is never written' },
  hoverAt: `${FILE}:${LINE}`,
  expect: EXPECT,
  result: res,
  checks,
  passed: !res.error && Object.values(checks).every(Boolean),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out: OUT, passed: report.passed, checks, error: res.error, hoverExcerpt: hoverText.slice(0, 600), decorations: up.decorations, since: res.since, down }, null, 1));
process.exit(report.passed ? 0 : 1);
