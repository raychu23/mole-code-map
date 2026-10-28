import { describe, expect, it } from 'vitest';
import type { Neighborhood, NeighborNode } from '@mole/core';
import { layoutNeighborhood, newHome } from '@mole/layout';
import { ago, esc, renderEmpty, renderHeader, renderSvg } from '../webview/render.js';
import { debounce, toRepoPath } from '../src/paths.js';

const node = (id: string, role: NeighborNode['role'], extra: Partial<NeighborNode> = {}): NeighborNode => ({
  id, kind: id.startsWith('file:') ? 'file' : 'function', name: id.replace(/^\w+:/, ''), role, path: `src/${id.replace(/\W/g, '')}.ts`, line: 3, score: 1,
  evidence: { path: 'src/x.ts', line: 3, commit: 'abcdef1234' }, ...extra,
});
const map: Neighborhood = {
  state: 'ok', commit: 'abcdef1234', indexedAt: 1000,
  focus: { id: 'file:f', kind: 'file', name: 'f', path: 'src/f.ts', line: 1 },
  nodes: [node('file:f', 'focus'), node('own1', 'own'), node('caller<1>', 'caller', { impacted: true }), node('callee1', 'callee')],
  edges: [
    { from: 'caller<1>', to: 'own1', kind: 'calls', count: 3, line: 5 },
    { from: 'own1', to: 'callee1', kind: 'calls', count: 1, line: 7 },
    { from: 'file:f', to: 'own1', kind: 'contains', count: 1, line: 3 },
  ],
  more: [{ role: 'caller', count: 12 }],
};

describe('renderSvg', () => {
  const layout = layoutNeighborhood(map, newHome());
  const svg = renderSvg(map, layout, layout.bounds.y - 16, { impact: false });

  it('draws one box per node, one path per non-contains edge, and a +N more chip', () => {
    expect((svg.match(/class="node /g) ?? []).length).toBe(4);
    expect((svg.match(/class="edge /g) ?? []).length).toBe(2);
    expect(svg).toContain('+12 more callers');
    expect(svg).toContain('role-focus');
  });

  it('escapes node text (no markup injection from symbol names)', () => {
    expect(svg).not.toContain('caller<1>');
    expect(svg).toContain('caller&lt;1&gt;');
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('impact mode flags the class and marks impacted nodes', () => {
    const on = renderSvg(map, layout, 0, { impact: true });
    expect(on).toContain('class="map impact-mode"');
    expect(on).toContain('impacted');
  });

  it('a caller or importer opens at its call/import site, not at its declaration', () => {
    const m2: Neighborhood = { ...map, nodes: [node('file:f', 'focus'), node('own1', 'own'), node('callerA', 'caller', { line: 3, site: { path: 'src/callerA.ts', line: 42, count: 2 } })], edges: [{ from: 'callerA', to: 'own1', kind: 'calls', count: 2, line: 42 }], more: [] };
    const l2 = layoutNeighborhood(m2, newHome());
    const out = renderSvg(m2, l2, 0, { impact: false });
    expect(out).toMatch(/data-path="src\/callerA\.ts" data-line="42"/);
    expect(out).toContain('call at line 42 (x2)');
  });

  it('every node carries file:line for click-to-open', () => {
    expect(svg).toMatch(/data-path="src\/own1\.ts" data-line="3"/);
  });
});

describe('empty states and header', () => {
  it.each([
    ['indexing', 'Indexing the repository'],
    ['not-indexed', 'Not indexed'],
    ['index-unavailable', 'Index unavailable'],
  ] as const)('%s renders a message, not a diagram', (state, text) => {
    const html = renderEmpty({ state, nodes: [], edges: [], more: [] });
    expect(html).toContain(text);
    expect(html).not.toContain('<svg');
  });

  it('header shows focus, commit, node count and the impact toggle', () => {
    const h = renderHeader(map, { impact: true }, 61_000);
    expect(h).toContain('src/f.ts');
    expect(h).toContain('@abcdef123');
    expect(h).toContain('4 nodes');
    expect(renderHeader({ ...map, impactTotal: 7 }, { impact: true }, 61_000)).toContain('7 callers reach this');
    expect(h).toContain('chip on');
    expect(ago(30_000)).toBe('30s ago');
  });
});

describe('extension helpers', () => {
  it('toRepoPath maps files inside the repo and rejects outside / the root itself', () => {
    expect(toRepoPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
    expect(toRepoPath('/repo', '/other/a.ts')).toBeUndefined();
    expect(toRepoPath('/repo', '/repo')).toBeUndefined();
    expect(toRepoPath('/repo', '/repo/../etc/passwd')).toBeUndefined();
  });

  it('debounce: the first call runs at once, a burst collapses to one trailing call with the last args', async () => {
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 30);
    d(1);
    expect(seen).toEqual([1]); // leading edge: no waiting for a lone switch
    d(2);
    d(3);
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual([1, 3]);
    d(4); // quiet again: immediate
    expect(seen).toEqual([1, 3, 4]);
  });
});
