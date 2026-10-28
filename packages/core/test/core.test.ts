import { describe, expect, it } from 'vitest';
import { anchorKey, isStale, missingEvidence, type GraphNode } from '../src/index.js';

describe('core schema helpers', () => {
  it('anchorKey is stable for the same element', () => {
    const a = { qualifiedName: 'src/a.ts#f', path: 'src/a.ts', kind: 'function' as const };
    expect(anchorKey(a)).toBe(anchorKey({ ...a }));
  });

  it('isStale only when commit differs and the file changed', () => {
    const ev = { path: 'src/a.ts', line: 3, commit: 'abc1234' };
    expect(isStale(ev, 'abc1234def', new Set(['src/a.ts']))).toBe(false);
    expect(isStale(ev, 'fff0000', new Set(['src/b.ts']))).toBe(false);
    expect(isStale(ev, 'fff0000', new Set(['src/a.ts']))).toBe(true);
  });

  it('flags current-layer items without evidence', () => {
    const ok: GraphNode = { id: 'f', kind: 'function', name: 'f', layer: 'current', status: 'observed', evidence: { path: 'a.ts', line: 1, commit: 'x' } };
    const bad: GraphNode = { id: 'g', kind: 'function', name: 'g', layer: 'current', status: 'observed' };
    const roadmap: GraphNode = { id: 'r', kind: 'module', name: 'api', layer: 'roadmap', status: 'accepted' };
    expect(missingEvidence([ok, bad, roadmap])).toEqual([bad]);
  });
});
