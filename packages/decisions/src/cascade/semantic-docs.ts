// T65: the T53 semantic-routing corpus for a repo's decision records -- the same docs the measured runs built
// (metrics-proof/m2-conflict/v3/run/run_t53_semantic_route_v3.mjs:43-51): every decision that is not superseded /
// deprecated / rejected / retired, as { id, title, one-line summary, BM25 index text } from its own record text.
import { indexTextOf, oneLineSummaryOf } from '../route/index-text.js';
import type { DecisionGraph } from '../types.js';
import { decisionTextFromRecords } from './cascade.js';

const INACTIVE = new Set(['superseded', 'deprecated', 'rejected', 'retired']);

export function semanticRouteDocs(recordsRoot: string, graph: DecisionGraph): Array<{ id: string; title: string; summary: string; text: string }> {
  const textOf = decisionTextFromRecords(recordsRoot, graph.nodes);
  const docs: Array<{ id: string; title: string; summary: string; text: string }> = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'decision' || INACTIVE.has(n.status)) continue;
    const text = textOf(n.id) ?? n.title;
    docs.push({ id: n.id, title: n.title, summary: oneLineSummaryOf(n.title, text), text: indexTextOf(n.title, text) });
  }
  return docs;
}
