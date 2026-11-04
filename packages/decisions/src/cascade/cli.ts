// `mole cascade-check --base SHA --head SHA` (T46): cascade at check time. Zero-LLM tier decides first; escalates
// to one LLM call per decision only when a governed scope is touched and no rule decided a crisp verdict.
import { loadGraph } from '../graph.js';
import { cascadeCheck, decisionTextFromRecords } from './cascade.js';
import { hermesLlmClient } from '../compile/llm.js';
import type { LlmClient } from '../compile/types.js';
import type { CascadeResult } from './types.js';
import { semanticRouteDocs } from './semantic-docs.js';
import { snapshotWorktree } from './worktree.js';

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export function formatCascade(r: CascadeResult): string {
  if (!r.verdicts.length) return `mole cascade-check: nothing governed these lines (${r.ms} ms)`;
  const out: string[] = [];
  for (const v of r.verdicts) {
    const cost = v.usage?.costUsd !== undefined ? ` $${v.usage.costUsd.toFixed(4)}` : '';
    out.push(`${v.flag.padEnd(9)} ${v.decision}  tier=${v.tier}${cost}  (${v.ms} ms)  ${v.reason}`);
  }
  const llmCalls = r.verdicts.filter((v) => v.tier === 'llm').length;
  out.push(`${r.verdicts.length} decision(s) governed, ${llmCalls} escalated to the LLM tier (${r.ms} ms total)`);
  return out.join('\n');
}

/** T65: the settings the measured runs froze (m2-conflict v2 -> v3 heldout: k=5, minScore 0, confidence 1.01 i.e.
 *  stage 2 always picks, haiku router; B2's 97% catch rate) -- the product default, so the loop runs what was measured. */
export const SEMANTIC_ROUTE_DEFAULTS = { topK: 5, minScore: 0, confidenceRatio: 1.01, routeModel: 'claude-haiku-4-5' } as const;

/** CLI entry used by packages/daemon/src/cli.ts. `--no-llm` runs the zero-LLM tiers only (BM25 routing, never
 *  escalates). `--worktree` (T65) checks uncommitted work: a snapshot commit of the working tree vs HEAD (or --base).
 *  `--no-route` turns T53 semantic routing off (scope/content anchors only, the pre-T65 CLI behaviour). */
export async function cascadeCheckCli(_pos: string[], flags: Record<string, string | true>, root: string, llm?: LlmClient): Promise<number> {
  let base = str(flags.base);
  let head = str(flags.head);
  if (flags.worktree) {
    const snap = snapshotWorktree(root);
    if (!snap.base) {
      console.log(flags.json ? JSON.stringify({ base: '', head: '', verdicts: [], files: [], routing: [], ms: 0 }, null, 2) : 'mole cascade-check: no commit yet, nothing to check');
      return 0;
    }
    base = base ?? snap.base;
    head = snap.head;
    if (head === snap.base && base === snap.base) {
      console.log(flags.json ? JSON.stringify({ base, head, verdicts: [], files: [], routing: [], ms: 0 }, null, 2) : 'mole cascade-check: no uncommitted change');
      return 0;
    }
  }
  if (!base || !head) {
    console.error('usage: mole cascade-check (--base SHA --head SHA | --worktree [--base SHA]) [--root DIR] [--records DIR] [--adr-dir DIR[,DIR]] [--no-llm] [--no-route] [--json]');
    return 2;
  }
  const recordsRoot = str(flags.records) ? str(flags.records)! : root;
  const adrDirs = str(flags['adr-dir'])?.split(',').map((s) => s.trim()).filter(Boolean);
  const graph = loadGraph(recordsRoot, { adrDirs });
  const client = flags['no-llm'] ? undefined : llm ?? hermesLlmClient();
  const routeClient = flags['no-llm'] ? undefined : llm ?? hermesLlmClient({ model: SEMANTIC_ROUTE_DEFAULTS.routeModel });
  const r = await cascadeCheck({
    root,
    base,
    head,
    recordsRoot,
    adrDirs,
    llm: client,
    decisionText: decisionTextFromRecords(recordsRoot, graph.nodes),
    ...(flags['no-route'] ? {} : { semanticRoute: { decisions: semanticRouteDocs(recordsRoot, graph), topK: SEMANTIC_ROUTE_DEFAULTS.topK, minScore: SEMANTIC_ROUTE_DEFAULTS.minScore, confidenceRatio: SEMANTIC_ROUTE_DEFAULTS.confidenceRatio, llm: routeClient } }),
  });
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatCascade(r));
  return 0;
}
