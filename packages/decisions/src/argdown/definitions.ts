// Where each Argdown argument is DEFINED (`<id>: text`, also inline after a relation arrow), with its text and #tags.
//
// The graph loader keys nodes by title and keeps the FIRST mention's line (`node.line`), which can be a bare `-> <id>`
// reference (T60 review 1). The definitions come from the Argdown parser itself (parser.ts `definitions`, carried onto
// the node by loader.ts), so fences, prose, link references and arrow spacing follow exactly the rules the graph uses
// (T60 review 2: a second, regex-based scanner disagreed with the parser on all of those).
import type { DecisionGraph } from '../types.js';

export interface ArgumentDefinition {
  id: string;
  file: string;
  line: number;
  /** text after the colon, tags included */
  text: string;
  /** #tags on the definition line, in order */
  tags: string[];
}

const TAG = /#([\w.-]+)/g;

/** id -> every definition of it (usually one), in load order */
export function argumentDefinitions(graph: DecisionGraph): Map<string, ArgumentDefinition[]> {
  const out = new Map<string, ArgumentDefinition[]>();
  for (const n of graph.nodes) {
    if (n.kind !== 'argument' || !n.definitions?.length) continue;
    out.set(n.id, n.definitions.map((d) => ({ id: n.id, file: d.file, line: d.line, text: d.text, tags: [...d.text.matchAll(TAG)].map((t) => t[1]!) })));
  }
  return out;
}
