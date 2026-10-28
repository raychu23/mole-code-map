// Read-side of the graph: ranked neighbourhood of a file or symbol, and the impact (transitive callers) view.
// Pure functions over a node:sqlite connection so they are testable without the daemon.
import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_MAP_NODES,
  type EdgeKind,
  type MoreGroup,
  type NeighborEdge,
  type NeighborNode,
  type NeighborRole,
  type Neighborhood,
  type NodeKind,
} from '@mole/core';

interface Row {
  id: string;
  kind: NodeKind;
  name: string;
  path: string;
  line: number;
  commit_sha: string;
}

const NODE_COLS = 'id, kind, name, path, line, commit_sha';

/** Share the daemon's hot-path indexes (the indexer only creates the ones it needs). Called by the writer's owner. */
export function ensureQueryIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id); CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);');
}

const toNode = (r: Row, role: NeighborRole, score: number, site?: { line: number; count: number }): NeighborNode => ({
  id: String(r.id), kind: r.kind, name: String(r.name), role, path: String(r.path), line: Number(r.line), score,
  // a call/import edge's evidence path is the file that contains the call, which is the caller's/importer's own file
  ...(site ? { site: { path: String(r.path), line: site.line, count: site.count } } : {}),
  evidence: { path: String(r.path), line: Number(r.line), commit: String(r.commit_sha) },
});

/** Per-role slot budget. Unused slots are refilled by the best remaining candidates, so a quiet file still gets a full map. */
const QUOTA: Record<Exclude<NeighborRole, 'focus'>, number> = { own: 8, callee: 6, caller: 6, importer: 2, imported: 2, container: 1 };

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

interface Cand {
  node: NeighborNode;
}

/** Choose <= MAX_MAP_NODES - 1 candidates: per-role quota first (by score), then fill leftover slots by score. */
function select(cands: Cand[]): { chosen: NeighborNode[]; more: MoreGroup[] } {
  const sorted = [...cands].sort((a, b) => b.node.score - a.node.score || a.node.id.localeCompare(b.node.id));
  const budget = MAX_MAP_NODES - 1;
  const taken = new Set<string>();
  const perRole = new Map<NeighborRole, number>();
  for (const c of sorted) {
    const role = c.node.role as Exclude<NeighborRole, 'focus'>;
    if ((perRole.get(role) ?? 0) < QUOTA[role] && taken.size < budget) {
      taken.add(c.node.id);
      perRole.set(role, (perRole.get(role) ?? 0) + 1);
    }
  }
  for (const c of sorted) if (taken.size < budget && !taken.has(c.node.id)) taken.add(c.node.id);
  const chosen = sorted.filter((c) => taken.has(c.node.id)).map((c) => c.node);
  const more = new Map<NeighborRole, number>();
  for (const c of sorted) if (!taken.has(c.node.id)) more.set(c.node.role, (more.get(c.node.role) ?? 0) + 1);
  return { chosen, more: [...more].map(([role, count]) => ({ role, count })) };
}

function fileId(path: string): string {
  return `file:${path}#${path}`;
}

/** Resolve a user target: `src/a.ts`, `src/a.ts#Cls.method`, or a bare symbol name (alternatives listed when ambiguous). */
export function resolveTarget(db: DatabaseSync, target: string): { row: Row; alternatives: string[] } | undefined {
  const t = target.trim();
  const hash = t.indexOf('#');
  if (hash < 0) {
    const f = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`).get(fileId(t)) as unknown as Row | undefined;
    if (f) return { row: f, alternatives: [] };
    const all = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE name = ? AND kind != 'file' ORDER BY (SELECT COUNT(*) FROM edges WHERE to_id = nodes.id) DESC, id LIMIT 6`).all(t) as unknown as Row[];
    const [best, ...rest] = all;
    return best ? { row: best, alternatives: rest.map((r) => `${r.path}#${String(r.id).slice(String(r.id).indexOf('#') + 1)}`) } : undefined;
  }
  const path = t.slice(0, hash);
  const qn = t.slice(hash + 1).replace(/[\\%_]/g, '\\$&'); // `%` / `_` are literal in a symbol name
  const row = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE path = ? AND id LIKE ? ESCAPE '\\' AND kind != 'file' LIMIT 1`).get(path, `%#${qn}`) as unknown as Row | undefined;
  return row ? { row, alternatives: [] } : undefined;
}

interface EdgeAgg {
  other: string;
  kind: EdgeKind;
  n: number;
  line: number;
}

const aggOut = (db: DatabaseSync, ids: string[], kind: EdgeKind): EdgeAgg[] =>
  ids.length ? (db.prepare(`SELECT to_id AS other, kind, COUNT(*) AS n, MIN(line) AS line FROM edges WHERE kind = ? AND from_id IN (${ids.map(() => '?').join(',')}) GROUP BY to_id`).all(kind, ...ids) as unknown as EdgeAgg[]) : [];
const aggIn = (db: DatabaseSync, ids: string[], kind: EdgeKind): EdgeAgg[] =>
  ids.length ? (db.prepare(`SELECT from_id AS other, kind, COUNT(*) AS n, MIN(line) AS line FROM edges WHERE kind = ? AND to_id IN (${ids.map(() => '?').join(',')}) GROUP BY from_id`).all(kind, ...ids) as unknown as EdgeAgg[]) : [];

function nodeById(db: DatabaseSync, id: string): Row | undefined {
  return db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`).get(id) as unknown as Row | undefined;
}

/** Callers of `ids` (and of what those callers are, transitively) up to `depth`; returns id -> distance. */
export function impactSet(db: DatabaseSync, ids: string[], depth = 3, cap = 400): Map<string, number> {
  const seen = new Map<string, number>();
  let frontier = ids;
  for (let d = 1; d <= depth && frontier.length && seen.size < cap; d++) {
    const next: string[] = [];
    for (const a of aggIn(db, frontier, 'calls')) {
      if (!seen.has(a.other) && !ids.includes(a.other)) {
        seen.set(a.other, d);
        next.push(a.other);
      }
    }
    frontier = next;
  }
  return seen;
}

export interface MapOptions {
  impact?: boolean;
}

/** The ranked per-file / per-symbol neighbourhood. `target` is a repo-relative path or symbol (see resolveTarget). */
export function neighborhood(db: DatabaseSync, target: string, opts: MapOptions = {}): Neighborhood {
  const t0 = performance.now();
  const resolved = resolveTarget(db, target);
  const focusRow = resolved?.row;
  if (!focusRow) return { state: 'not-indexed', message: `${target} is not in the index (outside the indexed sources, or not a symbol)`, nodes: [], edges: [], more: [] };
  const meta = db.prepare("SELECT key, value FROM meta WHERE key IN ('commit')").all() as unknown as Array<{ key: string; value: string }>;
  const commit = meta.find((m) => m.key === 'commit')?.value;
  const isFile = focusRow.kind === 'file';

  // The "inside" of the focus: a file's own symbols, or a symbol's children. Edges are folded onto them.
  const inside: Row[] = isFile
    ? (db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE path = ? AND kind != 'file'`).all(focusRow.path) as unknown as Row[])
    : (db.prepare(`SELECT n.id AS id, n.kind AS kind, n.name AS name, n.path AS path, n.line AS line, n.commit_sha AS commit_sha FROM edges e JOIN nodes n ON n.id = e.to_id WHERE e.kind = 'contains' AND e.from_id = ?`).all(focusRow.id) as unknown as Row[]);
  const insideIds = inside.map((r) => String(r.id));
  const ownIds = new Set([String(focusRow.id), ...insideIds]);
  const focusIds = [String(focusRow.id), ...insideIds];

  const cands: Cand[] = [];
  const edges = new Map<string, NeighborEdge>();
  const addEdge = (from: string, to: string, kind: EdgeKind, n: number, line: number): void => {
    const k = `${from}>${to}>${kind}`;
    const e = edges.get(k);
    if (e) e.count += n;
    else edges.set(k, { from, to, kind, count: n, line });
  };

  // own symbols ranked by how connected they are
  const degree = new Map<string, number>();
  const inCalls = insideIds.length ? (db.prepare(`SELECT to_id AS id, COUNT(*) AS n FROM edges WHERE kind = 'calls' AND to_id IN (${insideIds.map(() => '?').join(',')}) GROUP BY to_id`).all(...insideIds) as unknown as Array<{ id: string; n: number }>) : [];
  const outCalls = insideIds.length ? (db.prepare(`SELECT from_id AS id, COUNT(*) AS n FROM edges WHERE kind = 'calls' AND from_id IN (${insideIds.map(() => '?').join(',')}) GROUP BY from_id`).all(...insideIds) as unknown as Array<{ id: string; n: number }>) : [];
  for (const r of [...inCalls, ...outCalls]) degree.set(String(r.id), (degree.get(String(r.id)) ?? 0) + Number(r.n));
  const topKinds = new Set<NodeKind>(['class', 'function', 'type', 'variable']);
  for (const r of inside) {
    // methods are folded into their class on a file map; a symbol map lists its children directly
    if (isFile && r.kind === 'method') continue;
    cands.push({ node: toNode(r, 'own', (degree.get(String(r.id)) ?? 0) + (topKinds.has(r.kind) ? 0.5 : 0)) });
    addEdge(String(focusRow.id), String(r.id), 'contains', 1, Number(r.line));
  }
  if (!isFile) {
    const f = nodeById(db, fileId(String(focusRow.path)));
    if (f) {
      cands.push({ node: toNode(f, 'container', 1000) });
      addEdge(String(f.id), String(focusRow.id), 'contains', 1, Number(focusRow.line));
    }
  }

  // callees / callers: external symbols (or files, for top-level calls) connected to anything inside the focus
  const calleeAgg = aggOut(db, focusIds, 'calls').filter((a) => !ownIds.has(a.other));
  const callerAgg = aggIn(db, focusIds, 'calls').filter((a) => !ownIds.has(a.other));
  const connect = (aggs: EdgeAgg[], role: 'callee' | 'caller'): void => {
    const rows = new Map<string, Row>();
    for (const a of aggs) {
      const r = nodeById(db, a.other);
      if (r) rows.set(a.other, r);
    }
    for (const a of aggs) {
      const r = rows.get(a.other);
      if (!r) continue;
      const total = db.prepare('SELECT COUNT(*) AS n FROM edges WHERE to_id = ? OR from_id = ?').get(a.other, a.other) as unknown as { n: number };
      // test files call everything; keep them on the map but below real callers
      const weight = TEST_PATH.test(String(r.path)) ? 0.2 : 1;
      cands.push({ node: toNode(r, role, (Number(a.n) * 10 + Math.min(Number(total.n), 9)) * weight, role === 'caller' ? { line: Number(a.line), count: Number(a.n) } : undefined) });
    }
  };
  connect(calleeAgg, 'callee');
  connect(callerAgg, 'caller');

  // file-level import neighbours (file focus only: a symbol map stays about calls)
  if (isFile) {
    for (const a of aggOut(db, [String(focusRow.id)], 'imports').filter((x) => x.other !== focusRow.id)) {
      const r = nodeById(db, a.other);
      if (r) cands.push({ node: toNode(r, 'imported', Number(a.n)) });
    }
    for (const a of aggIn(db, [String(focusRow.id)], 'imports').filter((x) => x.other !== focusRow.id)) {
      const r = nodeById(db, a.other);
      if (r) cands.push({ node: toNode(r, 'importer', Number(a.n) * (TEST_PATH.test(String(r.path)) ? 0.2 : 1), { line: Number(a.line), count: Number(a.n) }) });
    }
  }

  // de-duplicate (a symbol can be both caller and callee): keep the stronger role
  const best = new Map<string, Cand>();
  for (const c of cands) {
    const prev = best.get(c.node.id);
    if (!prev || c.node.score > prev.node.score) best.set(c.node.id, c);
  }
  const { chosen, more } = select([...best.values()]);
  const focusNode = toNode(focusRow, 'focus', 1e6);
  const nodes: NeighborNode[] = [focusNode, ...chosen];
  const shown = new Set(nodes.map((x) => x.id));

  // edges between shown nodes (folded: inside-focus endpoints attach to the focus node itself)
  // an inside symbol that did not make the map is folded into its container (a method into its class) or the focus
  const parentOf = new Map<string, string>();
  for (const r of db.prepare(`SELECT from_id AS parent, to_id AS child FROM edges WHERE kind = 'contains' AND to_id IN (${focusIds.map(() => '?').join(',')})`).all(...focusIds) as unknown as Array<{ parent: string; child: string }>) parentOf.set(String(r.child), String(r.parent));
  const fold = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 4 && ownIds.has(cur) && !shown.has(cur); i++) cur = parentOf.get(cur) ?? String(focusRow.id);
    return ownIds.has(cur) && !shown.has(cur) ? String(focusRow.id) : cur;
  };
  const place = (aggs: EdgeAgg[], out: boolean, insideSources: Map<string, string[]>): void => {
    for (const a of aggs) {
      if (!shown.has(a.other)) continue;
      for (const src of insideSources.get(a.other) ?? [String(focusRow.id)]) {
        const s = fold(src);
        out ? addEdge(s, a.other, a.kind, Number(a.n), Number(a.line)) : addEdge(a.other, s, a.kind, Number(a.n), Number(a.line));
      }
    }
  };
  // which inside symbol each external neighbour attaches to (so the edge starts at the right own node)
  const attach = (out: boolean): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    const sql = out
      ? `SELECT from_id AS src, to_id AS other, COUNT(*) AS n FROM edges WHERE kind = 'calls' AND from_id IN (${focusIds.map(() => '?').join(',')}) GROUP BY from_id, to_id`
      : `SELECT to_id AS src, from_id AS other, COUNT(*) AS n FROM edges WHERE kind = 'calls' AND to_id IN (${focusIds.map(() => '?').join(',')}) GROUP BY to_id, from_id`;
    for (const r of db.prepare(sql).all(...focusIds) as unknown as Array<{ src: string; other: string; n: number }>) {
      if (ownIds.has(String(r.other))) continue;
      const arr = m.get(String(r.other)) ?? [];
      arr.push(String(r.src));
      m.set(String(r.other), arr);
    }
    return m;
  };
  place(calleeAgg, true, attach(true));
  place(callerAgg, false, attach(false));
  if (isFile) {
    place(aggOut(db, [String(focusRow.id)], 'imports'), true, new Map());
    place(aggIn(db, [String(focusRow.id)], 'imports'), false, new Map());
  }
  // own-to-own calls inside the focus (shown own nodes only)
  if (insideIds.length) {
    for (const a of db.prepare(`SELECT from_id AS a, to_id AS b, COUNT(*) AS n, MIN(line) AS line FROM edges WHERE kind = 'calls' AND from_id IN (${insideIds.map(() => '?').join(',')}) GROUP BY from_id, to_id`).all(...insideIds) as unknown as Array<{ a: string; b: string; n: number; line: number }>) {
      if (shown.has(String(a.a)) && shown.has(String(a.b)) && a.a !== a.b) addEdge(String(a.a), String(a.b), 'calls', Number(a.n), Number(a.line));
    }
  }

  let impactTotal: number | undefined;
  if (opts.impact) {
    const imp = impactSet(db, focusIds);
    impactTotal = imp.size;
    for (const n of nodes) if (imp.has(n.id)) n.impacted = true;
    // an own symbol is impacted when something OUTSIDE the focus calls it (calls among a file's own symbols do not count)
    const external = new Set<string>();
    if (insideIds.length) {
      for (const r of db.prepare(`SELECT to_id AS id, from_id AS other FROM edges WHERE kind = 'calls' AND to_id IN (${insideIds.map(() => '?').join(',')}) GROUP BY to_id, from_id`).all(...insideIds) as unknown as Array<{ id: string; other: string }>) {
        if (!ownIds.has(String(r.other))) external.add(String(r.id));
      }
    }
    for (const n of nodes) if (n.role === 'own' && external.has(n.id)) n.impacted = true;
  }

  const idx = db.prepare("SELECT value FROM meta WHERE key = 'indexedAt'").get() as unknown as { value: string } | undefined;
  return {
    state: 'ok',
    focus: { id: String(focusRow.id), kind: focusRow.kind, name: String(focusRow.name), path: String(focusRow.path), line: Number(focusRow.line) },
    nodes,
    edges: [...edges.values()].filter((e) => shown.has(e.from) && shown.has(e.to)),
    more,
    impactTotal,
    alternatives: resolved?.alternatives.length ? resolved.alternatives : undefined,
    commit,
    indexedAt: idx ? Number(idx.value) : undefined,
    ms: performance.now() - t0,
  };
}
