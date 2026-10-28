// Runs inside the VS Code webview. Receives a Neighborhood from the extension host, lays it out, draws it, and reports
// how long that took so the extension can measure file-switch latency end to end.
import type { Neighborhood } from '@mole/core';
import { layoutNeighborhood, newHome, nextTop, type Home } from '@mole/layout';
import { renderEmpty, renderHeader, renderSvg } from './render.js';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: `${e.message} @ ${e.filename}:${e.lineno}` }));
const app = document.getElementById('app') as HTMLElement;

interface Saved {
  map?: Neighborhood;
  rows?: Array<[string, { row: number; column: number }]>;
}
const saved = (vscode.getState() as Saved | undefined) ?? {};
const home: Home = newHome();
for (const [k, v] of saved.rows ?? []) home.rows.set(k, v);
let impact = false; // the extension host owns this and sends it with every map
let current: Neighborhood | undefined = saved.map;
let top: number | undefined;

function save(): void {
  vscode.setState({ map: current, rows: [...home.rows] } satisfies Saved);
}

function draw(map: Neighborhood, seq?: number): void {
  const t0 = performance.now();
  current = map;
  const opts = { impact };
  let body: string;
  let layoutMs = 0;
  if (map.state === 'ok' && map.nodes.length) {
    const hadShared = map.nodes.some((n) => home.rows.has(n.id));
    const l0 = performance.now();
    const layout = layoutNeighborhood(map, home);
    layoutMs = performance.now() - l0;
    const want = layout.bounds.y - 16;
    // sticky viewport: keep the previous top while the new map still fits under it and is not far below it (<= 6 rows)
    top = nextTop(top, want, hadShared);
    body = renderSvg(map, layout, top, opts);
  } else body = renderEmpty(map);
  app.innerHTML = `${renderHeader(map, opts)}<div id="stage">${body}</div>`;
  save();
  const drawMs = performance.now() - t0;
  // "rendered" = DOM written (does not depend on the window being visible); "painted" = next animation frame, which the
  // browser withholds while the window is in the background, so it is reported separately and may never arrive.
  if (seq !== undefined) vscode.postMessage({ type: 'rendered', seq, layoutMs, drawMs, nodes: map.nodes.length });
  requestAnimationFrame(() => {
    if (seq !== undefined) vscode.postMessage({ type: 'painted', seq, paintMs: performance.now() - t0 });
  });
}

app.addEventListener('click', (ev) => {
  const t = ev.target as Element;
  const btn = t.closest('button[data-act]') as HTMLElement | null;
  if (btn) {
    if (btn.dataset.act === 'impact') vscode.postMessage({ type: 'impact', on: !impact });
    else vscode.postMessage({ type: 'reindex' });
    return;
  }
  const node = t.closest('.node') as SVGGElement | null;
  if (node) vscode.postMessage({ type: 'open', id: node.dataset.id, path: node.dataset.path, line: Number(node.dataset.line) });
});

window.addEventListener('message', (ev) => {
  const m = ev.data as { type: string; map?: Neighborhood; seq?: number; impact?: boolean; id?: string };
  if (m.type === 'selftestClick') {
    // self-test only: dispatch a real DOM click on a node so the click handler above runs, instead of posting 'open' directly
    const el = Array.from(app.querySelectorAll('.node')).find((n) => (n as SVGGElement).dataset.id === m.id);
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    else vscode.postMessage({ type: 'selftestClickMissing', id: m.id });
    return;
  }
  if (m.type === 'map' && m.map) {
    impact = m.impact === true;
    draw(m.map, m.seq);
  }
});

if (current) draw(current); // restored after a reload, until the first fresh map arrives
vscode.postMessage({ type: 'ready' });
