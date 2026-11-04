// T30 annotated file tree: the pure core (./core.ts) + loadTree, which computes the flags in-process (files + git).
import { computeFlags } from '../flags.js';
import { loadGraph } from '../graph.js';
import { buildTree, readTreeRecords, type TreeIndex, type TreeOptions } from './core.js';

export * from './core.js';

/** Records + flags (files and git, computed once) -> the cached tree index. */
export function loadTree(root: string, opts: TreeOptions = {}): TreeIndex {
  const graph = loadGraph(root, { adrDirs: opts.adrDirs });
  const flags = computeFlags(graph, { testReport: opts.testReport });
  const { intents, summaries } = readTreeRecords(root, graph);
  return buildTree({ graph, flags, intents, summaries, reads: opts.reads });
}
