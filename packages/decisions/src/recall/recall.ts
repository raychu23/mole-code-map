// T71: case recall -- Klein RPD "resembles" retrieval ((internal reference removed) log/prior-art.md #1): given a
// new proposal/decision draft (text) or an existing record (id), find past decisions/incidents that lexically
// resemble it, so a person can check whether the past case applies -- never a claim that it does, never a
// causal claim (#1's own point: recognition triggers a fit-check, it is not an explanation). CBR's Retrieve
// step only (Aamodt & Plaza 1994, #2); Reuse/Revise/Retain are out of scope, same as incidents/revive.ts's
// suggest-only boundary. Zero model calls, zero network: reuses route/bm25.ts's Bm25Index (T53's own BM25,
// the named stock baseline) and route/index-text.ts's indexTextOf (same index-text shape T53 already builds
// for routing), scored over loadGraph's own decision/incident nodes -- no new case store.
//
// Held-out result ((internal reference removed) log/results.md): a title+body hybrid BM25 was tried as the one
// candidate custom matcher and did NOT beat plain BM25 on the frozen held-out pair (tied, did not beat) --
// per the task's STOP rule we ship plain BM25 here, unmodified from route/bm25.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGraph } from '../graph.js';
import { Bm25Index } from '../route/bm25.js';
import { indexTextOf } from '../route/index-text.js';
import type { GraphNode } from '../types.js';

export const RECALL_NOTE = 'similar case -- check whether it applies; a resemblance, not an explanation of what will happen';

export class RecallError extends Error {}

export interface RecallCase {
  id: string;
  title: string;
  kind: string;
  file: string;
  score: number;
}

export interface RecallResult {
  query: string;
  cases: RecallCase[];
  note: string;
}

export interface RecallQuery {
  /** free text (a new proposal/decision draft) to recall similar past cases for */
  text?: string;
  /** an existing decision/incident id to use as the query (its own index text); excluded from its own results */
  record?: string;
}

export interface RecallOptions {
  /** max cases returned, nearest first. Default 5 (recall@5, the frozen eval set's own cutoff). */
  limit?: number;
  /** plain ADR folders to include as candidates, same flag shape as `mole decisions --adr-dir` */
  adrDirs?: string[];
}

function readText(root: string, file: string): string {
  try {
    return readFileSync(resolve(root, file), 'utf8');
  } catch {
    return '';
  }
}

/** Retrieve past decisions/incidents that resemble `query` (Klein RPD / CBR Retrieve). Candidates are every
 *  `decision` and `incident` node loadGraph already knows about (.mole/decisions, .mole/incidents, plus any
 *  `adrDirs` folders) -- the existing case base, not a new store. Scoring is plain Okapi BM25
 *  (route/bm25.ts's Bm25Index) over indexTextOf's title+summary+clipped-rationale text, the baseline named by
 *  the tracking log task; see the module header for why a custom matcher was tried and not shipped. */
export function recallSimilar(root: string, query: RecallQuery, opts: RecallOptions = {}): RecallResult {
  const limit = opts.limit ?? 5;
  const graph = loadGraph(root, { adrDirs: opts.adrDirs });
  const candidates = graph.nodes.filter((n): n is GraphNode => n.kind === 'decision' || n.kind === 'incident');
  const byId = new Map<string, GraphNode>(candidates.map((n) => [n.id, n]));

  const idx = new Bm25Index();
  for (const n of candidates) idx.add(n.id, indexTextOf(n.title, readText(root, n.file)));

  let queryText: string;
  let excludeId: string | undefined;
  if (query.record !== undefined) {
    const n = byId.get(query.record);
    if (!n) throw new RecallError(`mole recall: no decision or incident with id '${query.record}'`);
    excludeId = query.record;
    queryText = indexTextOf(n.title, readText(root, n.file));
  } else if (query.text !== undefined && query.text.trim() !== '') {
    queryText = query.text;
  } else {
    throw new RecallError("mole recall: give --text '<draft text>' or --record <id>");
  }

  const hits = idx
    .score(queryText)
    .filter((h) => h.id !== excludeId && h.score > 0)
    .slice(0, limit);
  const cases: RecallCase[] = hits.map((h) => {
    const n = byId.get(h.id)!;
    return { id: n.id, title: n.title, kind: n.kind, file: n.file, score: h.score };
  });
  return { query: query.record ?? query.text!, cases, note: RECALL_NOTE };
}
