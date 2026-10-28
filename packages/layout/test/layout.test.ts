import { describe, expect, it } from 'vitest';
import { MAX_MAP_NODES, type Neighborhood, type NeighborNode } from '@mole/core';
import { layoutNeighborhood, newHome, ROW_H } from '../src/index.js';

const node = (id: string, role: NeighborNode['role'], score = 1): NeighborNode => ({
  id, kind: id.startsWith('file:') ? 'file' : 'function', name: id.replace(/^\w+:/, ''), role, path: 'src/x.ts', line: 1, score,
  evidence: { path: 'src/x.ts', line: 1, commit: 'abc' },
});
const map = (nodes: NeighborNode[]): Neighborhood => ({ state: 'ok', focus: { id: nodes[0]?.id ?? '', kind: 'file', name: 'f', path: 'src/f.ts', line: 1 }, nodes, edges: [], more: [] });
const overlaps = (l: ReturnType<typeof layoutNeighborhood>) => {
  for (const a of l.nodes) for (const b of l.nodes) {
    if (a.id >= b.id) continue;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return `${a.id}/${b.id}`;
  }
  return undefined;
};

describe('layoutNeighborhood', () => {
  it('callers left, focus + own middle, callees right, no overlaps, focus at row 0', () => {
    const l = layoutNeighborhood(map([node('file:f', 'focus'), node('o1', 'own', 5), node('o2', 'own'), node('c1', 'caller'), node('c2', 'caller'), node('e1', 'callee')]));
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    expect(at('c1').x).toBeLessThan(at('file:f').x);
    expect(at('file:f').x).toBe(at('o1').x);
    expect(at('o1').x).toBeLessThan(at('e1').x);
    expect(at('file:f').y).toBe(0);
    expect(overlaps(l)).toBeUndefined();
  });

  it('a node drawn before keeps its row when the map changes around it', () => {
    const home = newHome();
    const a = layoutNeighborhood(map([node('file:f', 'focus'), node('o1', 'own', 9), node('o2', 'own', 8), node('o3', 'own', 7), node('c1', 'caller')]), home);
    const rowOf = (l: typeof a, id: string) => l.nodes.find((n) => n.id === id)!.y;
    // o1 vanishes, two new ones appear: o2 and o3 must not move
    const b = layoutNeighborhood(map([node('file:f', 'focus'), node('o2', 'own', 8), node('o3', 'own', 7), node('n1', 'own', 50), node('n2', 'own', 40), node('c1', 'caller')]), home);
    expect(rowOf(b, 'o2')).toBe(rowOf(a, 'o2'));
    expect(rowOf(b, 'o3')).toBe(rowOf(a, 'o3'));
    expect(rowOf(b, 'c1')).toBe(rowOf(a, 'c1'));
    expect(overlaps(b)).toBeUndefined();
  });

  it('a node whose role changes columns takes the nearest free row there, never overlapping', () => {
    const home = newHome();
    layoutNeighborhood(map([node('file:f', 'focus'), node('x', 'callee'), node('y', 'callee')]), home);
    const l = layoutNeighborhood(map([node('file:g', 'focus'), node('x', 'caller'), node('y', 'own'), node('file:f', 'importer')]), home);
    expect(overlaps(l)).toBeUndefined();
    expect(l.nodes.find((n) => n.id === 'file:g')?.y).toBe(0);
  });

  it('stays within MAX_MAP_NODES and on the row grid', () => {
    const many = [node('file:f', 'focus'), ...Array.from({ length: MAX_MAP_NODES - 1 }, (_, i) => node(`n${i}`, (['own', 'caller', 'callee'] as const)[i % 3] as NeighborNode['role'], i))];
    const l = layoutNeighborhood(map(many));
    expect(l.nodes).toHaveLength(MAX_MAP_NODES);
    expect(l.nodes.every((n) => n.y % ROW_H === 0)).toBe(true);
    expect(overlaps(l)).toBeUndefined();
  });

  it('an empty map lays out to nothing', () => {
    expect(layoutNeighborhood({ state: 'not-indexed', nodes: [], edges: [], more: [] }).nodes).toEqual([]);
  });
});
