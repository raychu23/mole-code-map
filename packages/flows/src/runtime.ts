// Flows runtime: the hooks instrumented code calls (installed as globalThis.__mf) and the per-test recorder.
// A frame = one running function body, named by its static-graph node. `cur` is the innermost frame of the current
// synchronous stack; async functions and generators hand it back at every await/yield (s) and take it again on
// resume (r), so code after an await is credited to its own function, never to whatever ran in between.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowRuntime, TestFlow } from './types.js';

interface Frame {
  id: string;
  /** logical caller (for call paths) */
  p: Frame | null;
  /** value of `cur` to restore when this frame suspends or returns */
  s: Frame | null;
  /** suspended at an await/yield and not resumed through r() yet */
  z: boolean;
  /** muted: calls made while this frame is current are not recorded */
  m: boolean;
  /** async (muted async frames cannot know what to restore: they restore null) */
  a: boolean;
}

interface Rec {
  test: string;
  file: string;
  /** callee -> caller -> count */
  edges: Map<string, Map<string, number>>;
  roots: Set<string>;
  paths: Map<string, string[]>;
}

const SENTINEL: Frame = { id: '', p: null, s: null, z: false, m: false, a: false };
const MAX_PATH = 40;
const OUTSIDE = '(outside tests)';

const newRec = (test: string, file: string): Rec => ({ test, file, edges: new Map(), roots: new Set(), paths: new Map() });

class Runtime implements FlowRuntime {
  cur: Frame | null = null;
  rec: Rec = newRec(OUTSIDE, '');
  done: Rec[] = [];

  private chain(f: Frame, callee: string): string[] {
    const out: string[] = [callee];
    for (let x: Frame | null = f; x && out.length < MAX_PATH; x = x.p) if (x.id !== out[out.length - 1] && !x.m) out.push(x.id);
    return out.reverse();
  }

  edge(caller: Frame | null, callee: string): void {
    const r = this.rec;
    if (caller === null) {
      if (!r.roots.has(callee)) {
        r.roots.add(callee);
        if (!r.paths.has(callee)) r.paths.set(callee, [callee]);
      }
      return;
    }
    if (caller.m) return;
    let m = r.edges.get(callee);
    if (m === undefined) {
      m = new Map();
      r.edges.set(callee, m);
      if (!r.paths.has(callee)) r.paths.set(callee, this.chain(caller, callee));
    }
    m.set(caller.id, (m.get(caller.id) ?? 0) + 1);
  }

  begin(test: string, file: string): void {
    this.flushRec();
    this.rec = newRec(test, file);
    this.cur = null;
  }

  end(): void {
    this.flushRec();
    this.rec = newRec(OUTSIDE, this.rec.file);
    this.cur = null;
  }

  private flushRec(): void {
    const r = this.rec;
    if (r.test !== OUTSIDE || r.edges.size || r.roots.size) this.done.push(r);
  }

  flows(): TestFlow[] {
    const all = [...this.done, ...(this.rec.edges.size || this.rec.roots.size ? [this.rec] : [])];
    return all.map((r) => ({
      test: r.test,
      file: r.file,
      edges: [...r.edges].flatMap(([callee, callers]) => [...callers].map(([caller, n]) => [caller, callee, n] as [string, string, number])),
      roots: [...r.roots],
      paths: Object.fromEntries(r.paths),
    }));
  }

  reset(): void {
    this.done = [];
    this.rec = newRec(OUTSIDE, '');
    this.cur = null;
  }

  /** write the flows recorded so far to <out>/tests/<name>.json and forget them */
  flush(out: string, name: string): number {
    const flows = this.flows().filter((f) => f.edges.length || f.roots.length);
    this.done = [];
    if (this.rec.test === OUTSIDE) this.rec = newRec(OUTSIDE, this.rec.file);
    if (!flows.length) return 0;
    mkdirSync(join(out, 'tests'), { recursive: true });
    writeFileSync(join(out, 'tests', `${name}.json`), JSON.stringify(flows));
    return flows.filter((f) => f.test !== OUTSIDE).length;
  }
}

/** contained(owner, id): `id` is a member of the class `owner` (C's own field code run by C's constructor is not a call) */
function contained(owner: string, id: string): boolean {
  if (!owner.startsWith('class:')) return false;
  const rest = owner.slice('class:'.length);
  return id.startsWith(`method:${rest}.`);
}

/** The hook object instrumented code calls; method names are short because they are inlined into every function. */
function hooks(rt: Runtime) {
  const frame = (id: string, p: Frame | null, m: boolean, a: boolean): Frame => ({ id, p, s: p, z: false, m, a });
  return {
    /** enter a tracked function/method body */
    e(id: string): Frame {
      const p = rt.cur;
      rt.edge(p, id);
      const f = frame(id, p, false, false);
      rt.cur = f;
      return f;
    },
    /** enter a constructor body: the edge names the class for `new C()`, the constructor for `super()` */
    n(id: string, callee: string | null): Frame {
      const p = rt.cur;
      rt.edge(p, callee ?? id);
      const f = frame(id, p, false, false);
      rt.cur = f;
      return f;
    },
    /** enter a closure of a function/method: no edge, its calls belong to the owner */
    l(owner: string): Frame {
      const p = rt.cur;
      if (p !== null && p.id === owner) return SENTINEL;
      const f = frame(owner, p, false, false);
      rt.cur = f;
      return f;
    },
    /** async/generator closure: always its own frame (await/yield hand-off needs one) */
    L(owner: string): Frame {
      const p = rt.cur;
      const f = frame(owner, p, false, true);
      rt.cur = f;
      return f;
    },
    /** enter code of a registry entry / class field / module-level lambda: an edge to that node */
    k(owner: string): Frame {
      const p = rt.cur;
      if (p !== null && p.id === owner) return SENTINEL;
      if (p === null || !contained(owner, p.id)) rt.edge(p, owner);
      const f = frame(owner, p, false, false);
      rt.cur = f;
      return f;
    },
    K(owner: string): Frame {
      const p = rt.cur;
      if (p !== null && p.id !== owner && !contained(owner, p.id)) rt.edge(p, owner);
      else if (p === null) rt.edge(p, owner);
      const f = frame(owner, p, false, true);
      rt.cur = f;
      return f;
    },
    /** muted frame (async generators, for await): the entry edge is recorded, nothing inside it is */
    m(id: string, record: number): Frame {
      const p = rt.cur;
      if (record) rt.edge(p, id);
      const f = frame(id, p, true, true);
      rt.cur = f;
      return f;
    },
    /** code outside the graph (test harness setup files): runs as a muted frame, never an edge end */
    q(id: string): Frame {
      const f = frame(id, rt.cur, true, false);
      rt.cur = f;
      return f;
    },
    /** module initialisation: muted */
    mm(): Frame {
      const p = rt.cur;
      const f = frame('(module)', p, true, false);
      rt.cur = f;
      return f;
    },
    /** about to suspend (await / yield): give `cur` back */
    s<T>(f: Frame, v: T): T {
      if (typeof f !== 'object') return v; // a frame from the no-op hooks (runtime installed mid-call)
      f.z = true;
      rt.cur = f.s;
      return v;
    },
    /** resumed after await / yield */
    r<T>(f: Frame, v: T): T {
      if (typeof f !== 'object') return v;
      f.s = rt.cur;
      f.z = false;
      rt.cur = f;
      return v;
    },
    /** catch / finally block inside an async function or generator: may be a resume after a rejected await */
    c(f: Frame): void {
      if (typeof f !== 'object') return;
      if (f.z) {
        f.s = rt.cur;
        f.z = false;
      }
      rt.cur = f;
    },
    /** leave a frame */
    x(f: Frame): void {
      if (f === SENTINEL || typeof f !== 'object') return;
      if (f.m && f.a) rt.cur = null;
      else if (!f.z) rt.cur = f.s;
    },
  };
}

const KEY = '__mf';
const RT_KEY = '__moleFlowsRuntime';

/** Install the hooks on globalThis (idempotent) and return the recorder. */
export function installRuntime(): FlowRuntime & { flush(out: string, name: string): number } {
  const g = globalThis as Record<string, unknown>;
  const existing = g[RT_KEY] as Runtime | undefined;
  if (existing) return existing;
  const rt = new Runtime();
  g[RT_KEY] = rt;
  g[KEY] = hooks(rt);
  return rt;
}
