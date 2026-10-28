// M1 measurements on the read-only ui-tui fixture (state kept in a scratch dir, nothing written to the fixture):
//  1. query latency of `map` over the daemon socket + layout, for N file switches (no VS Code: pure core path)
//  2. layout stability over a 10-switch walk: how far a node that stays on the map moves
//   node packages/daemon/bench/m1.mjs   (after npm run build)   -> generated data/m1-stability.json
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon, MoleClient } from '../dist/index.js';
import { layoutNeighborhood, newHome, nextTop, ROW_H } from '../../layout/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = process.env.FIXTURE ?? ''; // path of a TypeScript repository with a src/ folder (a scratch COPY is safest)
if (!FIX) throw new Error('set FIXTURE=<path of a TypeScript repository with a src/ folder>');
const OUT = process.env.OUT ?? resolve(here, '../../../generated data/m1-stability.json');
const SWITCHES = Number(process.env.SWITCHES ?? 10);
const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mole-m1-'));

const d = new Daemon({ root: FIX, stateDir: state, tsconfig: 'tsconfig.build.json', srcDir: 'src', watch: false });
await d.start();
const c = new MoleClient({ root: FIX, stateDir: state });
for (let i = 0; i < 300; i++) if ((await c.status()).state === 'ready') break; else await new Promise((r) => setTimeout(r, 200));

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

// 1. latency over many different files
const first = await c.map('src/gatewayClient.ts');
const files = [...new Set([first.focus.path, ...first.nodes.map((n) => n.path)])];
const lat = [];
const home = newHome();
for (const f of files.slice(0, 80)) {
  const t0 = performance.now();
  const m = await c.map(f);
  const t1 = performance.now();
  if (m.state === 'ok') layoutNeighborhood(m, home);
  lat.push({ rpc: t1 - t0, server: m.ms ?? 0, layout: performance.now() - t1 });
}

// 2. walks of 10 switches (each next file is a neighbour of the current one: what a developer does when following a call/import)
const WALKS = Number(process.env.WALKS ?? 20);
async function walk(start) {
  const home = newHome();
  let cur = start;
  const seen = new Set();
  const steps = [];
  let prev; // id -> { x, y, role }; y is ON-SCREEN (world y minus the viewport top the webview would use)
  let top;
  for (let i = 0; i < SWITCHES + 1; i++) {
    const m = await c.map(cur);
    if (m.state !== 'ok') break;
    const hadShared = m.nodes.some((n) => home.rows.has(n.id));
    const l = layoutNeighborhood(m, home);
    top = nextTop(top, l.bounds.y - 16, hadShared);
    const now = new Map(l.nodes.map((n) => [n.id, { x: n.x, y: n.y - top, role: n.role }]));
    const sameRole = [];
    const roleChanged = [];
    if (prev) for (const [id, p] of now) {
      const q = prev.get(id);
      if (!q) continue;
      (q.role === p.role ? sameRole : roleChanged).push(Math.hypot(p.x - q.x, p.y - q.y));
    }
    steps.push({ focus: cur, nodes: m.nodes.length, sameRole, roleChanged });
    seen.add(cur);
    prev = now;
    const near = m.nodes.filter((n) => n.role !== 'focus' && !n.path.includes('__tests__')).map((n) => n.path);
    const next = near.find((p) => !seen.has(p)) ?? m.nodes.map((n) => n.path).find((p) => !seen.has(p));
    if (!next) break;
    cur = next;
  }
  return steps;
}
const starts = [...new Set([first.focus.path, ...files])].slice(0, WALKS);
const walks = [];
for (const s of starts) walks.push({ start: s, steps: await walk(s) });
const allSame = walks.flatMap((w) => w.steps.flatMap((s) => s.sameRole));
const allChanged = walks.flatMap((w) => w.steps.flatMap((s) => s.roleChanged));
const switchesTotal = walks.reduce((a, w) => a + Math.max(0, w.steps.length - 1), 0);
const report = {
  generatedAt: new Date().toISOString(),
  fixture: FIX,
  latency: {
    files: lat.length,
    note: 'daemon map round trip over the unix socket + column layout; the webview DOM time is measured separately in the real editor (m1-latency.json)',
    rpcMs: { p50: +pct(lat.map((x) => x.rpc), 50).toFixed(2), p95: +pct(lat.map((x) => x.rpc), 95).toFixed(2), max: +Math.max(...lat.map((x) => x.rpc)).toFixed(2) },
    serverQueryMs: { p50: +pct(lat.map((x) => x.server), 50).toFixed(2), p95: +pct(lat.map((x) => x.server), 95).toFixed(2) },
    layoutMs: { p50: +pct(lat.map((x) => x.layout), 50).toFixed(3), p95: +pct(lat.map((x) => x.layout), 95).toFixed(3) },
  },
  stability: {
    rule: 'on-screen distance (world y minus the webview viewport top, same column x) between two consecutive maps, for nodes on both. A node that keeps its role must not move more than the set distance. A node that changes role (callee -> caller) changes column by design and is reported separately, NOT hidden: it is most of the shared nodes.',
    setDistancePx: ROW_H,
    walks: walks.length,
    switches: switchesTotal,
    sharedNodeObservations: allSame.length + allChanged.length,
    sameRole: { n: allSame.length, maxPx: Math.round(Math.max(0, ...allSame)), over32px: allSame.filter((d) => d > ROW_H).length },
    roleChanged: { n: allChanged.length, shareOfShared: +(allChanged.length / Math.max(1, allSame.length + allChanged.length)).toFixed(2), medianPx: Math.round([...allChanged].sort((x, y) => x - y)[Math.floor(allChanged.length / 2)] ?? 0), maxPx: Math.round(Math.max(0, ...allChanged)) },
    sameRoleWithinSetDistance: allSame.every((d) => d <= ROW_H),
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ latency: report.latency, stability: report.stability }, null, 1));
await d.stop();
rmSync(state, { recursive: true, force: true });
