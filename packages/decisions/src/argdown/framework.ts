// T48: wires the decision graph's argumentation edges into packages/reasoning's evaluate() /
// IncrementalEvaluator -- "packages/reasoning (T42) evaluates the resulting framework and shows
// in/out/undecided per argument" (this task's own goal line).
//
// Two deliberate readings, cited in full in types.ts's EdgeType doc comment and in the
// consolidation-semantics memo ((internal reference removed)
// consolidation-semantics/memo.md §4):
//   - 'undercuts' collapses to a plain Dung 'attack' in the Framework. Mole's reasoning engine
//     models abstract arguments only (ArgumentSpec has no premises/inference-step structure), so
//     there is no separate "attack the inference link" target to point at -- the two-argument
//     abstraction already *is* the collapse the memo's §4.1 rule requires before handing a graph
//     to a Dung-style grounded reasoner.
//   - 'supports' edges are NOT included in the Framework's `attacks` list at all: a plain Dung AF
//     (and this package's Framework/evaluate) has no support relation (memo §4.3), and building
//     one of the non-equivalent bipolar readings (Cayrol/Lagasquie-Schiex supported/mediated
//     attack, or any TweetyProject org.tweetyproject.arg.bipolar reading) needs its own named,
//     justified choice this task does not make (memo §6 step 5/8, §8 caveats) -- out of scope
//     here. `argumentFramework()` still returns which 'argument' nodes have at least one incoming
//     'supports' edge (`supportedBy`), purely for display, never for evaluation.
import type { Framework } from '@mole/reasoning';
import type { DecisionGraph, GraphNode } from '../types.js';

/** A plain Dung AF built from the subset of a DecisionGraph that the reasoning engine can evaluate. */
export interface ArgumentFramework {
  framework: Framework;
  /** argument id -> ids of 'argument' nodes with an incoming 'supports' edge (display only, unevaluated). */
  supportedBy: Map<string, string[]>;
}

/** Build packages/reasoning's `Framework` from every `argument`-kind node and its supports/attacks/undercuts edges. */
export function argumentFramework(graph: DecisionGraph): ArgumentFramework {
  const argNodes = graph.nodes.filter((n: GraphNode) => n.kind === 'argument');
  const ids = new Set(argNodes.map((n) => n.id));
  const attacks: [string, string][] = [];
  const attackKeys = new Set<string>();
  const supportedBy = new Map<string, string[]>();

  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    if (e.type === 'attacks' || e.type === 'undercuts') {
      const key = `${e.from}\0${e.to}`;
      if (attackKeys.has(key)) continue;
      attackKeys.add(key);
      attacks.push([e.from, e.to]);
    } else if (e.type === 'supports') {
      const list = supportedBy.get(e.to) ?? [];
      if (!list.includes(e.from)) list.push(e.from);
      supportedBy.set(e.to, list);
    }
  }

  return {
    framework: { args: [...ids].map((id) => ({ id })), attacks },
    supportedBy,
  };
}
