// Flow store: .mole/local/flows/{run.json, tests/*.json}, and the query behind `mole flows <file#Symbol>`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowsMeta, FlowStore, SymbolFlows, TestFlow } from './types.js';

export const OUTSIDE_TESTS = '(outside tests)';

/** Write a whole store (replaces tests/). Used by tests and tools; the recorder writes tests/*.json from each worker. */
export function writeFlows(dir: string, flows: TestFlow[], meta: Partial<FlowsMeta> = {}): void {
  rmSync(join(dir, 'tests'), { recursive: true, force: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'flows.json'), JSON.stringify(flows));
  writeMeta(dir, meta);
}

export function writeMeta(dir: string, meta: Partial<FlowsMeta>): void {
  const full: FlowsMeta = { time: new Date().toISOString(), root: '', commit: 'unversioned', files: [], wallMs: 0, exit: 0, tests: { passed: 0, failed: 0 }, ...meta };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(full, null, 1)}\n`);
}

export function loadFlows(dir: string): FlowStore {
  const meta = existsSync(join(dir, 'run.json')) ? (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as FlowsMeta) : null;
  const tests: TestFlow[] = [];
  const td = join(dir, 'tests');
  if (existsSync(td)) {
    for (const f of readdirSync(td).filter((x) => x.endsWith('.json')).sort()) {
      try {
        tests.push(...(JSON.parse(readFileSync(join(td, f), 'utf8')) as TestFlow[]));
      } catch {
        // a worker killed mid-write leaves a partial file: skip it, the rest of the run is still valid
      }
    }
  }
  return { dir, meta, tests };
}

/** `path#Qualified` part of an id (`kind:path#Qualified`) */
const tail = (id: string): string => id.slice(id.indexOf(':') + 1);
const pathOf = (id: string): string => {
  const t = tail(id);
  return t.slice(0, t.indexOf('#'));
};

/** ids in the store that `target` names: `path#Symbol` (exact), a bare symbol name, or a file path (all its symbols) */
function resolveTarget(store: FlowStore, target: string): string[] {
  const all = new Set<string>();
  for (const t of store.tests) {
    for (const [a, b] of t.edges) all.add(a).add(b);
    for (const r of t.roots) all.add(r);
  }
  const ids = [...all];
  if (target.includes('#')) return ids.filter((id) => tail(id) === target).sort();
  const bySym = ids.filter((id) => {
    const q = tail(id).slice(tail(id).indexOf('#') + 1);
    return q === target || q.endsWith(`.${target}`);
  });
  if (bySym.length) return bySym.sort();
  return ids.filter((id) => pathOf(id) === target && !id.startsWith('file:')).sort();
}

export function flowsFor(store: FlowStore, target: string): SymbolFlows {
  const ids = resolveTarget(store, target);
  const want = new Set(ids);
  const tests: SymbolFlows['tests'] = [];
  const callers = new Map<string, number>();
  const callees = new Map<string, number>();
  for (const t of store.tests) {
    let hit: string | undefined;
    for (const [a, b, n] of t.edges) {
      if (want.has(b)) {
        callers.set(a, (callers.get(a) ?? 0) + n);
        hit ??= b;
      }
      if (want.has(a)) callees.set(b, (callees.get(b) ?? 0) + n);
    }
    if (!hit) hit = t.roots.find((r) => want.has(r));
    if (hit && t.test !== OUTSIDE_TESTS) tests.push({ test: t.test, file: t.file, path: t.paths[hit] ?? [hit] });
  }
  const sorted = (m: Map<string, number>) => [...m].map(([id, count]) => ({ id, count })).sort((x, y) => y.count - x.count || x.id.localeCompare(y.id));
  tests.sort((x, y) => x.file.localeCompare(y.file) || x.test.localeCompare(y.test));
  return { target, ids, tests, callers: sorted(callers), callees: sorted(callees) };
}

export function formatFlows(r: SymbolFlows, meta: FlowsMeta | null): string {
  if (!r.ids.length) return `mole flows: ${r.target} never ran in the recorded tests${meta ? ` (recorded ${meta.time}, ${meta.files.length || 'all'} test files)` : ''}`;
  const lines: string[] = [`${r.target}  =  ${r.ids.join(', ')}`];
  lines.push(`called by   ${r.callers.length ? r.callers.map((c) => `${c.id} ×${c.count}`).join('\n            ') : '(only tests / the event loop)'}`);
  lines.push(`calls       ${r.callees.length ? r.callees.map((c) => `${c.id} ×${c.count}`).join('\n            ') : '(nothing instrumented)'}`);
  lines.push(`tests (${r.tests.length})`);
  for (const t of r.tests) {
    lines.push(`  ${t.file} > ${t.test}`);
    lines.push(`      ${t.path.join(' → ')}`);
  }
  if (meta) lines.push(`(recorded ${meta.time} at ${meta.commit.slice(0, 7)}; runtime edges: who actually called whom while the tests ran)`);
  return lines.join('\n');
}
