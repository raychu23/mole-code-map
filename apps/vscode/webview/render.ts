// Pure rendering of a laid-out Neighborhood to HTML/SVG strings (no DOM), so it is unit-testable and cheap to redraw.
import type { MoreGroup, NeighborEdge, NeighborNode, NeighborRole, Neighborhood, NodeKind } from '@mole/core';
import { labelOf, maxChars, NODE_H, type Layout, type Placed } from '@mole/layout';

/** Callers and importers connect to the focus at a call/import site; clicking should land there, not on the neighbour's declaration. */
export const clickLine = (n: NeighborNode): number => (n.site && (n.role === 'caller' || n.role === 'importer') ? n.site.line : n.line);
const siteNote = (n: NeighborNode): string =>
  n.site && (n.role === 'caller' || n.role === 'importer') ? `\n${n.role === 'caller' ? 'call' : 'import'} at line ${n.site.line}${n.site.count > 1 ? ` (x${n.site.count})` : ''}` : '';


export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const KIND_BADGE: Record<NodeKind, string> = { package: 'pkg', module: 'mod', file: 'file', class: 'class', function: 'fn', method: 'method', type: 'type', variable: 'var' };
const MORE_LABEL: Record<NeighborRole, string> = { focus: '', own: 'defined here', caller: 'callers', callee: 'callees', importer: 'importers', imported: 'imports', container: '' };

export interface RenderOptions {
  impact: boolean;
}

function edgePath(a: Placed, b: Placed): string {
  if (a.column === b.column) {
    // same column (own → own call): bulge out to the right of the column
    const x = a.x + a.w;
    const y1 = a.y + NODE_H / 2;
    const y2 = b.y + NODE_H / 2;
    const bulge = 26 + Math.min(40, Math.abs(y2 - y1) / 6);
    return `M${x} ${y1} C${x + bulge} ${y1} ${x + bulge} ${y2} ${x} ${y2}`;
  }
  const fwd = a.column < b.column;
  const x1 = fwd ? a.x + a.w : a.x;
  const x2 = fwd ? b.x : b.x + b.w;
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

function moreChips(groups: MoreGroup[], placed: Placed[]): string {
  const colBottom = [0, 1, 2].map((c) => Math.max(-Infinity, ...placed.filter((p) => p.column === c).map((p) => p.y + p.h)));
  const used = [0, 0, 0];
  let out = '';
  for (const g of groups) {
    const probe = placed.find((p) => p.column === (g.role === 'caller' || g.role === 'importer' ? 0 : g.role === 'callee' || g.role === 'imported' ? 2 : 1));
    if (!probe) continue;
    const col = probe.column;
    const y = (Number.isFinite(colBottom[col]) ? (colBottom[col] as number) : 0) + 8 + (used[col] as number) * 28;
    used[col] = (used[col] as number) + 1;
    out += `<g class="more" transform="translate(${probe.x} ${y})"><rect width="${probe.w}" height="22" rx="11"/><text x="${probe.w / 2}" y="15" text-anchor="middle">+${g.count} more ${esc(MORE_LABEL[g.role])}</text></g>`;
  }
  return out;
}

/** The SVG for one map. Coordinates are world coordinates; `top` is the y of the viewBox (kept steady by the caller). */
export function renderSvg(map: Neighborhood, layout: Layout, top: number, opts: RenderOptions): string {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));
  const pad = 16;
  const bottom = layout.bounds.y + layout.bounds.h + 8 + 3 * 28;
  const vbH = Math.max(120, bottom - top + pad);
  const vbW = layout.bounds.w + pad * 2;

  let edges = '';
  for (const e of layout.edges as NeighborEdge[]) {
    if (e.kind === 'contains') continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const w = Math.min(4.5, 1.2 + Math.log2(1 + e.count));
    const imp = nodeById.get(e.to)?.impacted ? ' impacted' : ''; // calls INTO an impacted node
    edges += `<path class="edge ${e.kind}${imp}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${edgePath(a, b)}" stroke-width="${w.toFixed(1)}" marker-end="url(#arrow-${e.kind})"><title>${esc(e.kind)} ×${e.count} (first at line ${e.line})</title></path>`;
  }

  // a rail linking the focus to what it defines
  const focus = layout.nodes.find((n) => n.role === 'focus');
  const owns = layout.nodes.filter((n) => n.role === 'own');
  let rail = '';
  if (focus && owns.length) {
    const lastY = Math.max(...owns.map((n) => n.y + NODE_H / 2));
    rail = `<path class="rail" d="M${focus.x - 7} ${focus.y + NODE_H / 2} V${lastY}"/>` + owns.map((n) => `<path class="rail" d="M${focus.x - 7} ${n.y + NODE_H / 2} H${n.x}"/>`).join('');
  }

  let nodes = '';
  for (const p of layout.nodes) {
    const n = nodeById.get(p.id);
    if (!n) continue;
    const cls = `node role-${n.role} kind-${n.kind}${n.impacted ? ' impacted' : ''}`;
    const label = labelOf(n);
    const badge = KIND_BADGE[n.kind];
    nodes += `<g class="${cls}" data-id="${esc(n.id)}" data-path="${esc(n.path)}" data-line="${clickLine(n)}" transform="translate(${p.x} ${p.y})">` +
      `<rect width="${p.w}" height="${p.h}" rx="5"/><text class="label" x="9" y="${NODE_H / 2 + 4.5}">${esc(label.length > maxChars(p.w) ? `${label.slice(0, maxChars(p.w) - 1)}…` : label)}</text>` +
      `<text class="badge" x="${p.w - 8}" y="${NODE_H / 2 + 3.5}" text-anchor="end">${badge}</text>` +
      `<title>${esc(`${labelOf(n)}\n${n.kind} ${n.path}:${n.line}${siteNote(n)}\nscore ${n.score.toFixed(1)} · read at ${n.evidence.commit.slice(0, 9)}`)}</title></g>`;
  }

  return `<svg class="map${opts.impact ? ' impact-mode' : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="${layout.bounds.x - pad} ${top} ${vbW} ${vbH}" width="${vbW}" height="${vbH}">` +
    `<defs><marker id="arrow-calls" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L8 4L0 8z" class="arrowhead"/></marker>` +
    `<marker id="arrow-imports" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L8 4L0 8z" class="arrowhead imports"/></marker></defs>` +
    `${rail}${edges}${nodes}${moreChips(map.more, layout.nodes)}</svg>`;
}

const STATE_COPY: Record<string, { title: string; hint: string }> = {
  indexing: { title: 'Indexing the repository…', hint: 'The map appears as soon as the first index finishes.' },
  'not-indexed': { title: 'Not indexed', hint: 'This file is outside the indexed sources (or is not TypeScript). If the whole project shows this, set the "mole.srcDir" setting to your source folder (and "mole.tsconfig" if needed).' },
  'index-unavailable': { title: 'Index unavailable', hint: 'The Mole daemon is not answering. Run "Mole: Re-index repository" or check the Mole output channel.' },
};

export function renderEmpty(map: Neighborhood): string {
  const c = STATE_COPY[map.state] ?? { title: map.state, hint: '' };
  return `<div class="empty ${esc(map.state)}"><div class="title">${esc(c.title)}</div><div class="hint">${esc(map.state !== 'not-indexed' && map.message && map.message.replace(/…|\./g, '').toLowerCase() !== c.title.replace(/…|\./g, '').toLowerCase() ? map.message : c.hint)}</div></div>`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export function renderHeader(map: Neighborhood, opts: RenderOptions, now = Date.now()): string {
  const f = map.focus;
  const title = f ? (f.kind === 'file' ? f.path : `${f.path}#${f.name}`) : 'Mole';
  const STATE_NAME: Record<string, string> = { indexing: 'Indexing…', 'not-indexed': 'Not indexed', 'index-unavailable': 'Index unavailable' };
  const sub = f ? [f.kind, map.commit ? `@${map.commit.slice(0, 9)}` : '', map.indexedAt ? `indexed ${ago(now - map.indexedAt)}` : '', `${map.nodes.length} nodes`, map.impactTotal !== undefined ? `${map.impactTotal} callers reach this` : ''].filter(Boolean).join(' · ') : (STATE_NAME[map.state] ?? map.state);
  return `<div class="head"><div class="titles"><div class="title" title="${esc(title)}">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>` +
    `<button class="chip${opts.impact ? ' on' : ''}" data-act="impact" title="Highlight everything that calls into this file">Impact</button>` +
    `<button class="chip" data-act="reindex" title="Re-index the repository">⟳</button></div>` +
    (f ? `<div class="legend"><span class="l caller">calls it</span><span class="l own">defined here</span><span class="l callee">it calls</span><span class="l imp">imports</span></div>` : '');
}
