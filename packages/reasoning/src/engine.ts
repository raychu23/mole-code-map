import type { ArgId, ArgumentSpec, Audience, EvaluationResult, Framework, Label, Why } from './types.js';

/** Adjacency form of a framework, shared by full evaluation and the incremental evaluator. */
export interface Graph {
  ids: ArgId[];
  valueOf: Map<ArgId, string | undefined>;
  /** attacker -> set of targets, AFTER the audience filter (i.e. "defeats", not raw "attacks"). */
  defeatsOf: Map<ArgId, Set<ArgId>>;
  /** target -> set of attackers, AFTER the audience filter. */
  attackersOf: Map<ArgId, Set<ArgId>>;
}

export function validateFramework(framework: Framework, audience?: unknown): void {
  const seen = new Set<ArgId>();
  for (const a of framework.args) {
    if (!a || typeof a.id !== 'string' || a.id.length === 0) throw new Error(`argument needs a non-empty string id: ${JSON.stringify(a)}`);
    if (a.value !== undefined && typeof a.value !== 'string') throw new Error(`argument value must be a string: ${a.id}`);
    if (seen.has(a.id)) throw new Error(`duplicate argument id: ${a.id}`);
    seen.add(a.id);
  }
  if (audience !== undefined && (!Array.isArray(audience) || audience.some((v) => typeof v !== 'string'))) {
    throw new Error('audience must be an array of value names (strings)');
  }
  for (const [from, to] of framework.attacks) {
    if (!seen.has(from)) throw new Error(`attack references unknown argument: ${from}`);
    if (!seen.has(to)) throw new Error(`attack references unknown argument: ${to}`);
  }
}

/**
 * Bench-Capon value-based filter: an attack from `a` to `b` succeeds (becomes
 * a "defeat") unless both ends carry a value known to the audience and the
 * audience strictly prefers b's value to a's value. No audience, or either
 * side missing/unranked a value, means the attack is unfiltered -- plain
 * Dung semantics. Lower index in `audience` = more preferred.
 */
export function attackSucceeds(
  valueOf: Map<ArgId, string | undefined>,
  audience: Audience | undefined,
  from: ArgId,
  to: ArgId,
): boolean {
  if (!audience || audience.length === 0) return true;
  const va = valueOf.get(from);
  const vb = valueOf.get(to);
  if (va === undefined || vb === undefined) return true;
  const ia = audience.indexOf(va);
  const ib = audience.indexOf(vb);
  if (ia === -1 || ib === -1) return true;
  // ib < ia means vb is strictly more preferred than va -> the attack fails.
  return !(ib < ia);
}

export function buildGraph(framework: Framework, audience?: Audience): Graph {
  validateFramework(framework, audience);
  const ids = framework.args.map((a) => a.id);
  const valueOf = new Map<ArgId, string | undefined>(framework.args.map((a: ArgumentSpec) => [a.id, a.value]));
  const defeatsOf = new Map<ArgId, Set<ArgId>>(ids.map((id) => [id, new Set<ArgId>()]));
  const attackersOf = new Map<ArgId, Set<ArgId>>(ids.map((id) => [id, new Set<ArgId>()]));
  for (const [from, to] of framework.attacks) {
    if (!attackSucceeds(valueOf, audience, from, to)) continue;
    defeatsOf.get(from)!.add(to);
    attackersOf.get(to)!.add(from);
  }
  return { ids, valueOf, defeatsOf, attackersOf };
}

export interface GroundedState {
  labels: Map<ArgId, Label>;
  why: Map<ArgId, Why>;
  /** attackers of v not yet neutralized ("out") and not yet proven fatal ("in"). */
  remaining: Map<ArgId, number>;
}

/**
 * Grounded-extension labelling via a BFS/worklist propagation: O(|A|+|attacks|),
 * mirrors Dung's least-fixpoint characteristic function (same shape as
 * carneades-4's dung.go:GroundedExtension and TweetyProject's
 * SimpleGroundedReasoner -- see research memo §3/§5) without the memo's
 * O(|A|^2) re-scan.
 *
 * `seed`, when given, restricts labelling to exactly the argument ids in
 * `seed` (used by the incremental evaluator to recompute only the affected
 * component); `remaining`/`labels`/`why` may be pre-seeded with state for
 * ids outside the restricted set, treated as fixed/external facts.
 */
export function runGrounded(graph: Graph, scope?: Set<ArgId>, state?: GroundedState): GroundedState {
  const ids = scope ? [...scope] : graph.ids;
  const labels = state?.labels ?? new Map<ArgId, Label>();
  const why = state?.why ?? new Map<ArgId, Why>();
  const remaining = state?.remaining ?? new Map<ArgId, number>();

  for (const id of ids) {
    if (!labels.has(id)) labels.set(id, 'undecided');
    if (!remaining.has(id)) remaining.set(id, graph.attackersOf.get(id)?.size ?? 0);
  }

  const inScope = (id: ArgId): boolean => !scope || scope.has(id);
  const queue: ArgId[] = [];
  for (const id of ids) {
    if (labels.get(id) === 'undecided' && remaining.get(id) === 0) {
      labels.set(id, 'in');
      why.set(id, { defendedBy: [] });
      queue.push(id);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++]!;
    for (const v of graph.defeatsOf.get(u) ?? []) {
      if (!inScope(v)) continue;
      if (labels.get(v) !== 'undecided') continue;
      labels.set(v, 'out');
      why.set(v, { defeatedBy: u });
      for (const w of graph.defeatsOf.get(v) ?? []) {
        if (!inScope(w)) continue;
        if (labels.get(w) !== 'undecided') continue;
        remaining.set(w, (remaining.get(w) ?? 0) - 1);
        if (remaining.get(w) === 0) {
          const defenders = new Set<ArgId>();
          for (const attacker of graph.attackersOf.get(w) ?? []) {
            const al = labels.get(attacker);
            const aw = why.get(attacker);
            if (al === 'out' && aw?.defeatedBy) defenders.add(aw.defeatedBy);
          }
          labels.set(w, 'in');
          why.set(w, { defendedBy: [...defenders] });
          queue.push(w);
        }
      }
    }
  }

  return { labels, why, remaining };
}

export function toResult(state: GroundedState, ids: ArgId[]): EvaluationResult {
  const labels: Record<ArgId, Label> = {};
  const why: Record<ArgId, Why> = {};
  for (const id of ids) {
    labels[id] = state.labels.get(id) ?? 'undecided';
    const w = state.why.get(id);
    if (w) why[id] = w;
  }
  return { labels, why };
}

/** Full grounded evaluation of a framework (no incremental state carried). */
export function evaluate(framework: Framework, audience?: Audience): EvaluationResult {
  const graph = buildGraph(framework, audience);
  const state = runGrounded(graph);
  return toResult(state, graph.ids);
}
