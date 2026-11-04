import type { ArgId, ArgumentSpec, Audience, EvaluationResult, Framework, Label, Why } from './types.js';
import { attackSucceeds, buildGraph, runGrounded, type Graph } from './engine.js';

/** Forward closure: every id reachable from `seeds` by following defeat edges. */
function forwardClosure(graph: Graph, seeds: Iterable<ArgId>): Set<ArgId> {
  const scope = new Set<ArgId>();
  const queue: ArgId[] = [];
  for (const s of seeds) {
    if (!scope.has(s)) {
      scope.add(s);
      queue.push(s);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++]!;
    for (const v of graph.defeatsOf.get(u) ?? []) {
      if (!scope.has(v)) {
        scope.add(v);
        queue.push(v);
      }
    }
  }
  return scope;
}

/**
 * Grounded labelling restricted to `scope`, treating every id outside scope
 * as a fixed fact taken from `externalLabels`/`externalWhy` (the evaluator's
 * last-known cache). Produces the same labels `evaluate()` would for every id
 * in scope, as long as `scope` is a superset of the forward closure of
 * whatever changed (see `forwardClosure`) -- the property this package's
 * randomized test holds to.
 */
function runGroundedScoped(
  graph: Graph,
  scope: Set<ArgId>,
  externalLabels: Map<ArgId, Label>,
  externalWhy: Map<ArgId, Why>,
): { labels: Map<ArgId, Label>; why: Map<ArgId, Why> } {
  const labels = new Map<ArgId, Label>();
  const why = new Map<ArgId, Why>();
  const remaining = new Map<ArgId, number>();

  const getLabel = (id: ArgId): Label => (scope.has(id) ? labels.get(id) ?? 'undecided' : externalLabels.get(id) ?? 'undecided');
  const getWhy = (id: ArgId): Why | undefined => (scope.has(id) ? why.get(id) : externalWhy.get(id));

  for (const id of scope) labels.set(id, 'undecided');

  const queue: ArgId[] = [];

  const resolveOut = (v: ArgId, defeater: ArgId): void => {
    labels.set(v, 'out');
    why.set(v, { defeatedBy: defeater });
    for (const w of graph.defeatsOf.get(v) ?? []) {
      if (!scope.has(w)) continue;
      if (labels.get(w) !== 'undecided') continue;
      remaining.set(w, (remaining.get(w) ?? 0) - 1);
      if (remaining.get(w) === 0) resolveIn(w);
    }
  };

  const resolveIn = (w: ArgId): void => {
    const defenders = new Set<ArgId>();
    for (const attacker of graph.attackersOf.get(w) ?? []) {
      if (getLabel(attacker) === 'out') {
        const d = getWhy(attacker)?.defeatedBy;
        if (d) defenders.add(d);
      }
    }
    labels.set(w, 'in');
    why.set(w, { defendedBy: [...defenders] });
    queue.push(w);
  };

  // Seed remaining counts and immediate forced-outs from external attackers.
  const forcedOut: [ArgId, ArgId][] = [];
  for (const id of scope) {
    let count = 0;
    let forcedBy: ArgId | undefined;
    for (const attacker of graph.attackersOf.get(id) ?? []) {
      if (scope.has(attacker)) {
        count++;
        continue;
      }
      const al = externalLabels.get(attacker) ?? 'undecided';
      if (al === 'in') {
        forcedBy = attacker;
        break;
      }
      if (al === 'undecided') count++;
      // al === 'out': already neutralized, doesn't count.
    }
    if (forcedBy) forcedOut.push([id, forcedBy]);
    else remaining.set(id, count);
  }

  for (const id of scope) {
    if (remaining.get(id) === 0 && labels.get(id) === 'undecided') resolveIn(id);
  }
  for (const [id, attacker] of forcedOut) {
    if (labels.get(id) === 'undecided') resolveOut(id, attacker);
  }

  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++]!;
    for (const v of graph.defeatsOf.get(u) ?? []) {
      if (!scope.has(v)) continue;
      if (labels.get(v) !== 'undecided') continue;
      resolveOut(v, u);
    }
  }

  return { labels, why };
}

/**
 * Incremental grounded evaluator (T42 W6): addArg/removeArg/addAttack/
 * removeAttack each recompute only the component reachable (via defeat
 * edges) from what changed, and are proven equal to full `evaluate()` by
 * this package's randomized property test (test/property.test.ts).
 */
export class IncrementalEvaluator {
  private readonly audience: Audience | undefined;
  private readonly args = new Map<ArgId, ArgumentSpec>();
  /** raw (pre-filter) attacks, as "from\u0000to" keys, each mapped to its [from,to] pair. */
  private readonly rawAttacks = new Map<string, [ArgId, ArgId]>();
  private readonly graph: Graph = {
    ids: [],
    valueOf: new Map(),
    defeatsOf: new Map(),
    attackersOf: new Map(),
  };
  private labels = new Map<ArgId, Label>();
  private why = new Map<ArgId, Why>();

  constructor(framework?: Framework, audience?: Audience) {
    this.audience = audience;
    const initial = framework ?? { args: [], attacks: [] };
    // Populate adjacency once before deriving labels, rather than replaying an
    // incremental recomputation for every existing edge (T55 bulk construction).
    this.graph = buildGraph(initial, audience);
    for (const arg of initial.args) this.args.set(arg.id, arg);
    for (const [from, to] of initial.attacks) this.rawAttacks.set(this.key(from, to), [from, to]);
    const state = runGrounded(this.graph);
    this.labels = state.labels;
    this.why = state.why;
  }

  private key(from: ArgId, to: ArgId): string {
    return `${from}\u0000${to}`;
  }

  private recompute(seeds: Iterable<ArgId>): void {
    const scope = forwardClosure(this.graph, seeds);
    if (scope.size === 0) return;
    const { labels, why } = runGroundedScoped(this.graph, scope, this.labels, this.why);
    for (const id of scope) {
      labels.has(id) ? this.labels.set(id, labels.get(id)!) : this.labels.delete(id);
      if (why.has(id)) this.why.set(id, why.get(id)!);
      else this.why.delete(id);
    }
  }

  addArg(spec: ArgumentSpec): void {
    if (this.args.has(spec.id)) throw new Error(`duplicate argument id: ${spec.id}`);
    this.args.set(spec.id, spec);
    this.graph.ids.push(spec.id);
    this.graph.valueOf.set(spec.id, spec.value);
    this.graph.defeatsOf.set(spec.id, new Set());
    this.graph.attackersOf.set(spec.id, new Set());
    this.labels.set(spec.id, 'undecided');
    this.recompute([spec.id]);
  }

  removeArg(id: ArgId): void {
    if (!this.args.has(id)) throw new Error(`unknown argument id: ${id}`);
    const targets = [...(this.graph.defeatsOf.get(id) ?? [])];
    // Drop every attack touching id (raw + effective graph edges).
    for (const [k, [from, to]] of [...this.rawAttacks]) {
      if (from === id || to === id) this.rawAttacks.delete(k);
    }
    for (const t of targets) this.graph.attackersOf.get(t)?.delete(id);
    for (const a of this.graph.attackersOf.get(id) ?? []) this.graph.defeatsOf.get(a)?.delete(id);
    this.graph.defeatsOf.delete(id);
    this.graph.attackersOf.delete(id);
    this.graph.valueOf.delete(id);
    this.graph.ids = this.graph.ids.filter((x) => x !== id);
    this.args.delete(id);
    this.labels.delete(id);
    this.why.delete(id);
    this.recompute(targets);
  }

  addAttack(from: ArgId, to: ArgId): void {
    if (!this.args.has(from)) throw new Error(`unknown argument id: ${from}`);
    if (!this.args.has(to)) throw new Error(`unknown argument id: ${to}`);
    const k = this.key(from, to);
    if (this.rawAttacks.has(k)) return;
    this.rawAttacks.set(k, [from, to]);
    if (!attackSucceeds(this.graph.valueOf, this.audience, from, to)) return; // filtered out, no graph change
    this.graph.defeatsOf.get(from)!.add(to);
    this.graph.attackersOf.get(to)!.add(from);
    this.recompute([to]);
  }

  removeAttack(from: ArgId, to: ArgId): void {
    const k = this.key(from, to);
    if (!this.rawAttacks.has(k)) return;
    this.rawAttacks.delete(k);
    const wasEffective = this.graph.defeatsOf.get(from)?.has(to) ?? false;
    if (!wasEffective) return; // was filtered already, no graph change
    this.graph.defeatsOf.get(from)!.delete(to);
    this.graph.attackersOf.get(to)!.delete(from);
    this.recompute([to]);
  }

  evaluate(): EvaluationResult {
    const labels: Record<ArgId, Label> = {};
    const why: Record<ArgId, Why> = {};
    for (const id of this.graph.ids) {
      labels[id] = this.labels.get(id) ?? 'undecided';
      const w = this.why.get(id);
      if (w) why[id] = w;
    }
    return { labels, why };
  }
}
