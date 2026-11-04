// Evidence gathering for a code change governed by decisions (T23): diff hunks, past fixes + guarding tests
// (@mole/history, T12), the decisions whose scope the change touches (@mole/decisions, T29). Deterministic only
// (R6) — no model calls on this path. Silent when nothing governs the change (done-when 5).
import { resolve } from 'node:path';
import { check, parseDiff, type Change, type CheckResult } from '@mole/history';
import { computeFlags, loadGraph } from '@mole/decisions';
import type { DecisionGraph, FlagResult, GraphNode } from '@mole/decisions';
import type { EvidenceItem } from './types.js';

export interface GoverningDecision {
  node: GraphNode;
  flag: FlagResult['flag'];
  /** the scope anchor(s) that matched a touched file */
  matchedScope: string[];
}

export interface EvidencePackage {
  governed: boolean;
  governingDecisions: GoverningDecision[];
  check: CheckResult;
  evidence: EvidenceItem[];
}

/** does a decision's scope anchor (a path, `path#Symbol`, or `folder/`) cover a touched file? */
function scopeCoversFile(target: string, file: string): boolean {
  const path = target.split('#')[0]!;
  if (path.endsWith('/')) return file === path.slice(0, -1) || file.startsWith(path);
  return file === path;
}

/** Which decisions (accepted or flagged) govern the files this change touches, by scope anchor. */
export function governingDecisions(graph: DecisionGraph, flags: FlagResult[], files: string[]): GoverningDecision[] {
  const out: GoverningDecision[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'decision') continue;
    const matched = n.scope.filter((a) => files.some((f) => scopeCoversFile(a.target, f))).map((a) => a.target);
    if (matched.length === 0) continue;
    const flag = flags.find((f) => f.id === n.id);
    out.push({ node: n, flag: flag?.flag ?? 'grey', matchedScope: [...new Set(matched)] });
  }
  return out;
}

/** Gather every fact this interrogation can point at for a code change, with a real evidence link for each. */
export async function gatherEvidence(root: string, change: Change, opts: { adrDirs?: string[] } = {}): Promise<EvidencePackage> {
  const r = resolve(root);
  const result = await check(r, change);
  const graph = loadGraph(r, { adrDirs: opts.adrDirs });
  const flags = computeFlags(graph);
  const files = result.hunks.map((h) => h.file);
  const governed = governingDecisions(graph, flags, files);

  const evidence: EvidenceItem[] = [];
  for (const h of result.hunks) {
    evidence.push({
      kind: 'file_line',
      file: h.file,
      line: h.newStart,
      label: `hunk ${h.file}:${h.newStart} (+${h.newLines}/-${h.oldLines})`,
    });
    for (const fix of h.pastFixes) {
      evidence.push({ kind: 'commit', commit: fix.sha, label: `past fix ${fix.shortSha}: ${fix.subject}` });
      for (const t of fix.tests) evidence.push({ kind: 'file_line', file: t.file, line: 1, label: `guarding test ${t.file}` });
    }
  }
  for (const g of governed) evidence.push({ kind: 'file_line', file: g.node.file, line: g.node.line, label: `decision ${g.node.id}: ${g.node.title}` });

  return { governed: governed.length > 0, governingDecisions: governed, check: result, evidence };
}

export { parseDiff };
