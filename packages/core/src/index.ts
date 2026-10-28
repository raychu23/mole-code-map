export * from './schema.js';
export * from './neighborhood.js';
import type { Anchor, Evidence, GraphEdge, GraphNode } from './schema.js';

/** Stable key for an anchor: same element → same key across re-indexes. */
export function anchorKey(a: Anchor): string {
  return `${a.kind}:${a.qualifiedName}`;
}

/** A 'current' fact is stale when it was read at a commit other than HEAD and its file changed since. */
export function isStale(ev: Evidence, head: string, changedSince: ReadonlySet<string>): boolean {
  return !head.startsWith(ev.commit) && !ev.commit.startsWith(head) && changedSince.has(ev.path);
}

/** Validate the invariant every surface relies on: current-layer nodes and edges carry evidence. */
export function missingEvidence(items: ReadonlyArray<GraphNode | GraphEdge>): Array<GraphNode | GraphEdge> {
  return items.filter((x) => x.layer === 'current' && !x.evidence);
}
