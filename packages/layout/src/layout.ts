// Column layout of a Neighborhood: callers/importers left, the focus and what it defines in the middle,
// callees/imports right. Built to hold still: a node that was drawn before keeps its row, new nodes take the free row
// nearest the middle of their column. (ELK layered was tried first; it cannot pin role columns, see the T2 report.)
import type { NeighborEdge, NeighborNode, NeighborRole, Neighborhood } from '@mole/core';

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  role: NeighborRole;
  column: 0 | 1 | 2;
}
export interface Layout {
  nodes: Placed[];
  edges: NeighborEdge[];
  /** Bounding box of the nodes in world coordinates (y can be negative: rows grow both ways from the focus row 0). */
  bounds: { x: number; y: number; w: number; h: number };
}
/**
 * Remembered layout (mutated by layoutNeighborhood): the row of every node drawn recently (bounded, most recent last).
 * A map that shares no node with the last one starts clean. Column widths are fixed, so only rows need remembering.
 */
export interface Home {
  rows: Map<string, { row: number; column: number }>;
}
export const newHome = (): Home => ({ rows: new Map() });

export const ROW_H = 32;
export const NODE_H = 26;
const COL_GAP = 48;
const HOME_LIMIT = 400;
const COLUMN: Record<NeighborRole, 0 | 1 | 2> = { caller: 0, importer: 0, container: 0, focus: 1, own: 1, callee: 2, imported: 2 };

/** Label shown in a node box. Files show their basename, symbols their name. */
export function labelOf(n: Pick<NeighborNode, 'kind' | 'name' | 'path'>): string {
  return n.kind === 'file' ? n.path.slice(n.path.lastIndexOf('/') + 1) : n.name;
}

/** Node width from its label, capped so three columns still fit a half-screen panel at 100% scale. */
export const MAX_NODE_W = 165;
export const MAX_FOCUS_W = 190;
export const CHAR_W = 7.2;
export function widthOf(n: Pick<NeighborNode, 'kind' | 'name' | 'path' | 'role'>): number {
  const cap = n.role === 'focus' ? MAX_FOCUS_W : MAX_NODE_W;
  return Math.max(n.role === 'focus' ? 150 : 100, Math.min(cap, Math.round(labelOf(n).length * CHAR_W + 44)));
}

/** Longest label that fits a box of width w (room for the kind badge). */
export const maxChars = (w: number): number => Math.max(6, Math.floor((w - 44) / CHAR_W));

/** Free row nearest `center` (ties go below), skipping rows in `taken`. */
function nearestFree(center: number, taken: Set<number>, downOnly = false): number {
  for (let d = 0; ; d++) {
    for (const r of d === 0 ? [center] : downOnly ? [center + d] : [center + d, center - d]) if (!taken.has(r)) return r;
  }
}

export function layoutNeighborhood(map: Neighborhood, home: Home = newHome()): Layout {
  const nodes = map.nodes;
  if (!nodes.length) return { nodes: [], edges: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
  if (!map.nodes.some((n) => home.rows.has(n.id))) {
    home.rows.clear();
  }
  const cols: NeighborNode[][] = [[], [], []];
  for (const n of nodes) (cols[COLUMN[n.role]] as NeighborNode[]).push(n);

  const rows = new Map<string, number>(); // node id -> row, all columns
  const recencyOf = new Map([...home.rows.keys()].map((k, i) => [k, i] as const));
  // middle column first: the focus sits on top with what it defines below; callers/callees centre on that list
  let midRow = 0;
  for (const c of [1, 0, 2]) {
    const col = cols[c] as NeighborNode[];
    const taken = new Set<number>();
    const mine = new Map<string, number>(); // this column only
    // 1. nodes drawn before in this same column keep their row; when two remember the same row the more recently drawn wins
    const fresh: NeighborNode[] = [];
    const recency = (id: string): number => recencyOf.get(id) ?? -1;
    const kept = col.filter((n) => n.role !== 'focus' && home.rows.get(n.id)?.column === c).sort((a, b) => recency(b.id) - recency(a.id));
    for (const n of col) if (n.role !== 'focus' && !kept.includes(n)) fresh.push(n); // the focus is always row 0 of the middle column
    for (const n of kept) {
      const h = home.rows.get(n.id) as { row: number; column: number };
      if (!taken.has(h.row)) {
        taken.add(h.row);
        mine.set(n.id, h.row);
      } else fresh.push(n);
    }
    if (c === 1) {
      const f = col.find((n) => n.role === 'focus');
      if (f) {
        // focus row 0; if a kept node squats there (it was the focus last time as an 'own'), it is moved
        for (const [id, r] of mine) if (r === 0 && id !== f.id) {
          mine.delete(id);
          const squatter = col.find((n) => n.id === id);
          if (squatter) fresh.push(squatter);
        }
        taken.add(0);
        mine.set(f.id, 0);
      }
    }
    // 2. the rest take the free row nearest the middle of what is already placed (best score first)
    const mid = c === 1 ? 1 : mine.size ? Math.round([...mine.values()].reduce((a, b) => a + b, 0) / mine.size) : midRow;
    for (const n of fresh.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
      const r = nearestFree(mid, taken, c === 1);
      taken.add(r);
      mine.set(n.id, r);
    }
    for (const [id, r] of mine) rows.set(id, r);
    if (c === 1) midRow = Math.round(Math.max(0, ...mine.values()) / 2);
  }

  // fixed column widths: a column never changes size, so nothing shifts sideways when a long label appears or leaves
  const colW = [MAX_NODE_W, MAX_FOCUS_W, MAX_NODE_W];
  const colX = [0, (colW[0] as number) + COL_GAP, 0];
  colX[2] = (colX[1] as number) + (colW[1] as number) + COL_GAP;
  const placed: Placed[] = nodes.map((n) => {
    const column = COLUMN[n.role];
    return { id: n.id, x: colX[column] as number, y: (rows.get(n.id) as number) * ROW_H, w: colW[column] as number, h: NODE_H, role: n.role, column };
  });

  for (const p of placed) {
    home.rows.delete(p.id);
    home.rows.set(p.id, { row: p.y / ROW_H, column: p.column });
  }
  while (home.rows.size > HOME_LIMIT) home.rows.delete(home.rows.keys().next().value as string);

  const minY = Math.min(...placed.map((p) => p.y));
  const maxY = Math.max(...placed.map((p) => p.y + p.h));
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes: placed, edges: map.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), bounds: { x: 0, y: minY, w: (colX[2] as number) + (colW[2] as number), h: maxY - minY } };
}

/**
 * Where the viewport's top edge goes for the next map. It stays put while shared nodes are on screen; when the new map
 * reaches above it, it extends upward with 3 rows of slack (a fresh start has the same slack) (so the next few maps do not shift again); a map with nothing
 * in common, or one that now sits more than 12 rows below the top, snaps to itself.
 */
export function nextTop(prev: number | undefined, want: number, hadShared: boolean): number {
  if (prev === undefined || !hadShared) return want - 3 * ROW_H;
  if (want < prev) return want - 3 * ROW_H;
  return want - prev > 12 * ROW_H ? want - 3 * ROW_H : prev;
}
