// Real-editor proof for T2: launches a separate VS Code window (own user-data dir) with the built extension on a scratch
// COPY of the read-only fixture, switches through N files, records warm file-switch latency inside the real webview,
// takes a screenshot, then quits. Writes OUT (default "generated data/m1-latency.json") and SHOT (png).
//   node scripts/selftest.mjs        (after `npm run build && npm run bundle`)
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '..');
const FIX = process.env.FIXTURE ?? ''; // path of a TypeScript repository with a src/ folder (a scratch COPY is safest)
if (!FIX) throw new Error('set FIXTURE=<path of a TypeScript repository with a src/ folder>');
const SCRATCH = process.env.SCRATCH ?? join(process.env.TMPDIR ?? tmpdir(), 'mole-m1-selftest');
const OUT = process.env.OUT ?? resolve(ext, '../../generated data/m1-latency.json');
const SHOT = process.env.SHOT ?? resolve(ext, '../../generated data/m1-panel.png');
const RESTORE_SHOT = process.env.RESTORE_SHOT ?? resolve(ext, '../../generated data/m1-panel-restored.png');
const SHOT3 = process.env.SHOT3 ?? resolve(ext, '../../generated data/m1-panel-impact.png');
const SHOT2 = process.env.SHOT2 ?? resolve(ext, '../../generated data/m1-panel-unavailable.png');
const N = Number(process.env.FILES ?? 40);
const SHOT_FILE = process.env.SHOT_FILE ?? 'src/gatewayClient.ts';
const CODE = process.env.CODE_BIN ?? 'code';
// VSIX=<file>: test the INSTALLED extension in a clean profile (own --user-data-dir and --extensions-dir) instead of the repo build
const VSIX = process.env.VSIX ? resolve(process.env.VSIX) : undefined;

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ws = join(SCRATCH, 'ws');
cpSync(join(FIX, 'src'), join(ws, 'src'), { recursive: true });
for (const f of ['tsconfig.json', 'tsconfig.build.json', 'package.json']) if (existsSync(join(FIX, f))) cpSync(join(FIX, f), join(ws, f));

const all = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !p.includes('__tests__')) all.push(relative(ws, p).split('\\').join('/'));
  }
})(join(ws, 'src'));
all.sort();
const step = Math.max(1, Math.floor(all.length / N));
const files = all.filter((_, i) => i % step === 0).slice(0, N);

const cfg = { out: join(SCRATCH, 'out.json'), files, shot: join(SCRATCH, 'shot'), shot2: join(SCRATCH, 'shot2'), shot3: join(SCRATCH, 'shot3'), shotFile: SHOT_FILE };
writeFileSync(join(SCRATCH, 'selftest.json'), JSON.stringify(cfg));
const env = { ...process.env, MOLE_SELFTEST: join(SCRATCH, 'selftest.json'), MOLE_STATE_DIR: join(SCRATCH, 'state'), MOLE_TSCONFIG: 'tsconfig.build.json', MOLE_SRC_DIR: 'src' };
if (VSIX) {
  rmSync(join(SCRATCH, 'ext'), { recursive: true, force: true });
  rmSync(join(SCRATCH, 'ud'), { recursive: true, force: true });
  console.log(execFileSync(CODE, ['--install-extension', VSIX, '--force', '--user-data-dir', join(SCRATCH, 'ud'), '--extensions-dir', join(SCRATCH, 'ext')], { encoding: 'utf8' }).trim());
}
const extArg = VSIX ? [] : ['--extensionDevelopmentPath', ext];
try { execFileSync('osascript', ['-e', 'tell application "Code" to activate']); } catch {}
const child = spawn(CODE, ['--new-window', '--user-data-dir', join(SCRATCH, 'ud'), '--extensions-dir', join(SCRATCH, 'ext'), ...extArg, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', ws], { env, stdio: 'ignore', detached: true });
child.unref();

const deadline = Date.now() + 240_000;
const shots = { shot: false, shot2: false, shot3: false };
const take = async (key, dest) => {
  if (shots[key] || !existsSync(`${cfg[key]}.ready`)) return;
  shots[key] = true;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      execFileSync('osascript', ['-e', 'tell application "Code" to activate']); // other windows (Finder...) must not cover the editor
    } catch {}
    await new Promise((r) => setTimeout(r, 700));
    execFileSync('screencapture', ['-x', dest]);
  } catch (e) {
    console.error('screenshot failed:', e.message);
  }
};
while (!existsSync(cfg.out) && Date.now() < deadline) {
  await take('shot', SHOT);
  await take('shot3', SHOT3);
  await take('shot2', SHOT2);
  await new Promise((r) => setTimeout(r, 300));
}
if (!existsSync(cfg.out)) {
  console.error('self-test did not finish in 240 s');
  process.exit(1);
}
const res = JSON.parse(readFileSync(cfg.out, 'utf8'));
if (res.error) {
  console.error('self-test error:', res.error);
  process.exit(1);
}
// ---- phase 2: relaunch on the same profile; the panel must come back without any command
const restoreOut = join(SCRATCH, 'restore.json');
const child2 = spawn(CODE, ['--new-window', '--user-data-dir', join(SCRATCH, 'ud'), '--extensions-dir', join(SCRATCH, 'ext'), ...extArg, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', ws], { env: { ...env, MOLE_SELFTEST: '', MOLE_SELFTEST_RESTORE: restoreOut }, stdio: 'ignore', detached: true });
child2.unref();
let restored = null;
const d2 = Date.now() + 60_000;
let shot3 = false;
while (Date.now() < d2) {
  if (!shot3 && existsSync(`${restoreOut}.ready`)) {
    shot3 = true;
    try { execFileSync('osascript', ['-e', 'tell application "Code" to activate']); } catch {}
    await new Promise((r) => setTimeout(r, 700));
    try { execFileSync('screencapture', ['-x', RESTORE_SHOT]); } catch {}
  }
  if (existsSync(restoreOut) && shot3) break;
  await new Promise((r) => setTimeout(r, 300));
}
if (existsSync(restoreOut)) restored = JSON.parse(readFileSync(restoreOut, 'utf8'));

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const warm = res.samples.slice(3); // first switches pay for webview start-up + layout caches
const stat = (k) => {
  const xs = warm.map((s) => s[k]).filter((x) => x !== null);
  return xs.length ? { n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), max: +Math.max(...xs).toFixed(1) } : null;
};
const report = {
  generatedAt: new Date().toISOString(),
  what: 'warm file switch -> map rendered (DOM written), measured in a real VS Code window (extension host + real webview), no LLM call',
  fixture: { path: FIX, copiedTo: ws, note: 'scratch COPY of src; the fixture itself is never written' },
  vscode: execFileSync(CODE, ['--version'], { encoding: 'utf8' }).split('\n').slice(0, 2),
  switchesAttempted: files.length,
  switches: res.samples.length,
  warmSamples: warm.length,
  skippedAsColdStart: 3,
  definition: { totalMs: 'debounced handler start -> webview reports the DOM written (daemon RPC + postMessage + layout + DOM)', withDebounceMs: 'editor switch -> DOM written, includes the 120 ms debounce', rpcMs: 'daemon map round-trip', layoutMs: 'webview layout', drawMs: 'webview DOM build', paintMs: 'webview message -> next animation frame (null/omitted when the window is in the background and the browser withholds frames)' },
  totalMs: stat('totalMs'),
  withDebounceMs: stat('withDebounceMs'),
  rpcMs: stat('rpcMs'),
  layoutMs: stat('layoutMs'),
  drawMs: stat('drawMs'),
  paintMs: stat('paintMs'),
  recordedOfAttempted: `${res.samples.length}/${files.length}`,
  target: 'p95 <= 150 ms, judged on withDebounceMs (editor switch -> DOM written; the debounce is leading-edge so a lone switch waits 0 ms)',
  passed: pct(warm.map((s) => s.withDebounceMs), 95) <= 150,
  states: Object.fromEntries([...new Set(res.samples.map((s) => s.state))].map((k) => [k, res.samples.filter((s) => s.state === k).length])),
  editorGroups: res.layoutGroups,
  screenshots: { ok: shots.shot ? SHOT : null, impact: shots.shot3 ? SHOT3 : null, indexUnavailable: shots.shot2 ? SHOT2 : null },
  clickToOpen: res.openCheck ?? null,
  clickAll: { checked: (res.openChecks ?? []).length, ok: (res.openChecks ?? []).filter((c) => c.ok).length, failing: (res.openChecks ?? []).filter((c) => !c.ok), byVia: Object.fromEntries(['openFile', 'dom'].map((v) => [v, { checked: (res.openChecks ?? []).filter((c) => c.via === v).length, ok: (res.openChecks ?? []).filter((c) => c.via === v && c.ok).length }])), byRole: Object.fromEntries([...new Set((res.openChecks ?? []).map((c) => c.role))].map((r) => [r, { checked: res.openChecks.filter((c) => c.role === r).length, ok: res.openChecks.filter((c) => c.role === r && c.ok).length }])), callersTextChecked: (res.openChecks ?? []).filter((c) => c.textHasFocusName !== undefined).length },
  impactView: res.impactCheck ?? null,
  restoreAfterRelaunch: restored,
  failureCases: res.failures.map((f) => ({ file: f.file, state: f.state })),
  samples: res.samples,
};
const CLICK_OUT = process.env.CLICK_OUT ?? resolve(ext, '../../generated data/m1-click-all.json');
mkdirSync(dirname(CLICK_OUT), { recursive: true });
writeFileSync(CLICK_OUT, JSON.stringify({ generatedAt: report.generatedAt, what: 'every non-focus node of 40 sampled file maps + the symbol map of each file\'s most-connected function opened in a real VS Code window; landed path:line read back from the editor after parking it on package.json:1; caller lines of symbol maps must contain a call `name(` or `name<`; the first files are also opened through a real DOM click in the webview', fixture: report.fixture, vscode: report.vscode, summary: report.clickAll, limits: ['one repo (ui-tui), one VS Code build', 'classes are not text-checked (their call sites mention members)', 'DOM click path is exercised for the first MOLE_DOM_CLICK_FILES file maps only (default 6)', 'the text check proves the caller line holds a call of that name, not that it resolves to the same declaration'], records: (res.openChecks ?? []).map((c) => ({ via: c.via, map: c.map, id: c.id, role: c.role, path: c.path, line: c.line, landedPath: c.landedPath, landedLine: c.landedLine, textOk: c.textHasFocusName, ok: c.ok })) }, null, 2) + '\n');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
// a node that does not land on its path:line fails the run (T8)
if (report.clickAll.checked === 0 || report.clickAll.failing.length > 0) {
  console.error(`click check FAILED: ${report.clickAll.failing.length} of ${report.clickAll.checked} nodes did not land (see ${CLICK_OUT})`);
  process.exitCode = 1;
}
// every run is kept: a loaded machine moves p95 by tens of ms, so quote the range, not one run
const RUNS = join(dirname(OUT), 'm1-latency-runs.json');
const runs = existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : [];
runs.push({ at: report.generatedAt, switches: report.switches, totalMsP95: report.totalMs?.p95, withDebounceMsP95: report.withDebounceMs?.p95, rpcMsP95: report.rpcMs?.p95, passed: report.passed });
writeFileSync(RUNS, JSON.stringify(runs, null, 2) + '\n');
console.log(JSON.stringify({ switches: report.switches, totalMs: report.totalMs, withDebounceMs: report.withDebounceMs, rpcMs: report.rpcMs, layoutMs: report.layoutMs, states: report.states, passed: report.passed, screenshots: report.screenshots, failureCases: report.failureCases, clickToOpen: report.clickToOpen, clickAll: report.clickAll, impactView: report.impactView, restoreAfterRelaunch: report.restoreAfterRelaunch }, null, 1));
