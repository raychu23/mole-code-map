// The per-file map: what Mole shows for the file (or symbol) you are looking at. Same shape for the VS Code panel,
// the CLI and the MCP tool; only the rendering differs. Plan M1 (offerings F1.1, F1.3, F1.9).
import type { EdgeKind, Evidence, NodeKind } from './schema.js';

/** Why a node is on the map relative to the focus. */
export type NeighborRole = 'focus' | 'own' | 'caller' | 'callee' | 'importer' | 'imported' | 'container';

/** `ok` = a map; the others are explicit empty states the UI must show (never a crash). */
export type MapState = 'ok' | 'indexing' | 'not-indexed' | 'index-unavailable';

export interface NeighborNode {
  id: string;
  kind: NodeKind;
  name: string;
  role: NeighborRole;
  path: string; // repo-relative file of the declaration
  line: number; // 1-based
  score: number; // ranking score (higher = more connected to the focus)
  /** true when this node is among the transitive callers of the focus (impact view). */
  impacted?: boolean;
  /** where the connection to the focus actually happens (callers: the first call site; importers: the first import statement). `line` stays the declaration line. */
  site?: { path: string; line: number; count: number };
  evidence: Evidence;
}

export interface NeighborEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  count: number; // call sites / import statements folded into this edge
  line: number; // first site
}

/** Nodes that qualified but did not fit the budget, grouped by role ('+N more'). */
export interface MoreGroup {
  role: NeighborRole;
  count: number;
}

export interface Neighborhood {
  state: MapState;
  message?: string; // human-readable reason for any non-ok state
  focus?: { id: string; kind: NodeKind; name: string; path: string; line: number };
  nodes: NeighborNode[]; // <= MAX_MAP_NODES, focus first
  edges: NeighborEdge[];
  more: MoreGroup[];
  /** impact view: how many callers (transitively, depth 3) reach the focus; the map shows only the best-ranked of them */
  impactTotal?: number;
  /** a bare symbol name matched several declarations: the others (path#qualified), best first */
  alternatives?: string[];
  commit?: string; // commit the facts were read at
  indexedAt?: number; // epoch ms of the last index run
  ms?: number; // server-side query time
}

export const MAX_MAP_NODES = 25;

const ROLE_LABEL: Record<NeighborRole, string> = {
  focus: 'focus',
  own: 'defines',
  caller: 'called by',
  callee: 'calls',
  importer: 'imported by',
  imported: 'imports',
  container: 'in file',
};

/** Compact text form for agents (MCP `mole_map`) and the CLI. One line per node, grouped by role. */
export function formatNeighborhood(n: Neighborhood): string {
  if (n.state !== 'ok' || !n.focus) return `mole: ${n.state}${n.message ? ` — ${n.message}` : ''}`;
  const lines: string[] = [];
  const age = n.indexedAt ? `, indexed ${new Date(n.indexedAt).toISOString()}` : '';
  lines.push(`${n.focus.kind} ${n.focus.path}${n.focus.kind === 'file' ? '' : `#${n.focus.name}`}:${n.focus.line} [@${(n.commit ?? '?').slice(0, 9)}${age}]`);
  const roles: NeighborRole[] = ['container', 'own', 'caller', 'callee', 'importer', 'imported'];
  for (const role of roles) {
    const group = n.nodes.filter((x) => x.role === role);
    const more = n.more.find((m) => m.role === role)?.count ?? 0;
    if (!group.length && !more) continue;
    const items = group.map((x) => {
      // callers/importers: the line where the call/import happens (the declaration line of the caller is not where the call is)
      const line = (role === 'caller' || role === 'importer') && x.site ? x.site.line : x.line;
      const sites = (role === 'caller' || role === 'importer') && x.site && x.site.count > 1 ? ` ×${x.site.count}` : '';
      const where = (x.path === n.focus?.path && role === 'own' ? `:${line}` : ` ${x.path}:${line}`) + sites;
      const flag = x.impacted ? ' !impact' : '';
      const siteFile = x.kind === 'file' && (role === 'caller' || role === 'importer') && x.site ? `:${x.site.line}${sites}` : '';
      return `${x.kind === 'file' ? x.path : x.name}${role === 'own' ? where : x.kind === 'file' ? siteFile : where}${flag}`;
    });
    if (more) items.push(`+${more} more`);
    lines.push(`${ROLE_LABEL[role]}: ${items.join(' · ')}`);
  }
  if (n.impactTotal !== undefined) lines.push(`impact: ${n.impactTotal} callers reach this (depth 3), ${n.nodes.filter((x) => x.impacted).length} shown`);
  if (n.alternatives?.length) lines.push(`also matches: ${n.alternatives.join(' · ')}`);
  const calls = n.edges.filter((e) => e.kind === 'calls').length;
  lines.push(`(${n.nodes.length} nodes, ${calls} call edges${n.ms !== undefined ? `, ${n.ms.toFixed(0)} ms` : ''})`);
  return lines.join('\n');
}
