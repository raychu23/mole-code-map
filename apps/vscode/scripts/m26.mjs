// T34 one-panel (M26): checked by this script (R1 key committed before implementation; R2 red tests). Drives
// a REAL VS Code instance via the repo's own idiom (same as scripts/hover-check.mjs / install-check.mjs):
// `code --new-window --extensionDevelopmentPath ... --user-data-dir <scratch> --extensions-dir <scratch>`
// plus one env var (MOLE_M26_CHECK=<config path>) that extension.ts checks at activation and answers with a
// JSON dump of what the real vscode API shows (commands, the sidebar view's last-rendered model, diagnostics,
// refresh timings). NOT @vscode/test-electron: that package is not installed, and with the disk this low
// (see (internal reference removed) log/key-changes.md #1) installing anything that might fetch a second VS Code/
// Electron copy is the exact failure mode a previous run already hit. No new binary is downloaded here.
//
// M26a — a feature from (internal reference removed) log/m26-key.json counts as covered if its id (or cli text) shows
//   up in package.json `contributes` (commands/views) OR in the real session's command list OR in the sidebar
//   view's rendered model OR among its diagnostics collection names. Target 14/14.
// M26b — 3 repeated cursor-move/file-switch refreshes per file are timed trigger -> webview postMessage round
//   trip inside the real session; this script computes their p95. Target <= 300 ms.
//
// Usage: node apps/vscode/scripts/m26.mjs
// Writes (internal reference removed) log/runs.jsonl (R4) itself: the evidence is produced by code, not prose (R6).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..'); // apps/vscode
const repoRoot = resolve(extRoot, '../..'); // Mole repo
const taskLog = join(repoRoot, '(internal reference removed) log');
const key = JSON.parse(readFileSync(join(taskLog, 'm26-key.json'), 'utf8'));
const CODE = process.env.CODE_BIN ?? 'code';

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function appendRun(cmd, exit, metrics) {
  mkdirSync(taskLog, { recursive: true });
  appendFileSync(join(taskLog, 'runs.jsonl'), JSON.stringify({ time: new Date().toISOString(), commit: gitSha(), cmd, exit, metrics }) + '\n');
}

// --- M26a static half: contributes.json text -----------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf8'));
const contributesText = JSON.stringify(pkg.contributes ?? {});

// --- real VS Code, driven via `code --extensionDevelopmentPath` (no @vscode/test-electron) -------------------
async function runE2E() {
  const SCRATCH = process.env.SCRATCH ?? join(process.env.TMPDIR ?? tmpdir(), `mole-m26-${Date.now()}`);
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const ud = join(SCRATCH, 'ud');
  const extDir = join(SCRATCH, 'ext');
  const cfgPath = join(SCRATCH, 'm26-check.json');
  const resultPath = join(SCRATCH, 'result.json');
  try {
    // build the extension host bundle first, so the dev host loads current code
    execFileSync('node', ['esbuild.mjs'], { cwd: extRoot, stdio: 'inherit' });
    writeFileSync(cfgPath, JSON.stringify({ out: resultPath }));
    const env = { ...process.env, MOLE_M26_CHECK: cfgPath, MOLE_STATE_DIR: join(SCRATCH, 'state'), ELECTRON_RUN_AS_NODE: undefined };
    const child = spawn(
      CODE,
      ['--new-window', '--user-data-dir', ud, '--extensions-dir', extDir, '--extensionDevelopmentPath', extRoot, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', repoRoot],
      { env, stdio: 'ignore', detached: true },
    );
    child.unref();
    const deadline = Date.now() + Number(process.env.M26_TIMEOUT_MS ?? 180_000);
    while (!existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1000));
    try {
      execFileSync('pkill', ['-f', SCRATCH]); // only matches this run's own scratch profile, never a bare pkill -f
    } catch {
      // nothing left to kill
    }
    await new Promise((r) => setTimeout(r, 1500)); // let killed processes release their file handles before rm
    if (!existsSync(resultPath)) return { ok: false, reason: 'entry routine did not write a result in time (host likely did not activate or crashed)' };
    if (process.env.M26_DEBUG_COPY) writeFileSync(process.env.M26_DEBUG_COPY, readFileSync(resultPath, 'utf8'));
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (result.error) return { ok: false, reason: result.error, result };
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(SCRATCH, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

let e2e = await runE2E();
let attempts = 1;
// Real GUI automation (code --extensionDevelopmentPath with no display server guarantees) is occasionally
// flaky about when the sidebar view's webview finishes resolving before the script's cursor-move loop starts;
// a flaky *timing* run (M26a already 14/14, M26b simply got no samples that time) is retried up to 3 times
// total — this does not loosen the check (R7): every attempt runs the real session and real CLI calls, and a
// genuine regression (e.g. a thrown error, or latency consistently over target) still fails after retries.
while ((!e2e.ok || (e2e.ok && (e2e.result.refreshMs ?? []).length === 0)) && attempts < 3) {
  attempts++;
  console.error(`m26: attempt ${attempts - 1} produced no usable sample (${e2e.ok ? 'empty refreshMs' : e2e.reason}); retrying (${attempts}/3)`);
  e2e = await runE2E();
}

const idKey = (id) => id.replace(/-/g, '').toLowerCase();
const covered = {};
for (const f of key.features) {
  const inContributes = contributesText.toLowerCase().includes(idKey(f.id)) || contributesText.toLowerCase().includes(f.id);
  const inCommands = e2e.ok ? (e2e.result.commands ?? []).some((c) => String(c).toLowerCase().includes(idKey(f.id))) : false;
  const inModel = e2e.ok ? JSON.stringify(e2e.result.model ?? {}).toLowerCase().includes(idKey(f.id)) : false;
  const inDiagnostics = e2e.ok && f.id === 'rules' ? (e2e.result.diagnosticsNames ?? []).some((c) => c.toLowerCase().includes('rule')) : false;
  covered[f.id] = Boolean(inContributes || inCommands || inModel || inDiagnostics);
}
const coveredCount = Object.values(covered).filter(Boolean).length;

const refreshMs = e2e.ok ? (e2e.result.refreshMs ?? []) : [];
const p95 = percentile(refreshMs, 95);

const report = {
  e2e: e2e.ok ? 'ran' : `did not run: ${e2e.reason}`,
  M26a: { coveredCount, of: key.features.length, covered, target: key.m26a_target },
  M26b: { refreshMsSamples: refreshMs, p95, target_max_ms: key.m26b_target.max_ms },
};
console.log(JSON.stringify(report, null, 2));

const exit = coveredCount === key.features.length && p95 !== null && p95 <= key.m26b_target.max_ms ? 0 : 1;
appendRun('node apps/vscode/scripts/m26.mjs', exit, { M26a: `${coveredCount}/${key.features.length}`, M26b_p95_ms: p95 });
process.exit(exit);
