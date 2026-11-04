// T69 review round 1 blocking finding #4: a divergence check between the server's own
// nodes/relations decision index and @mole/temporal's authoritative decision store.
//
// Design choice (prior art, see (internal reference removed) log/prior-art.md §5): Fowler's CQRS
// framing (martinfowler.com/bliki/CQRS.html) treats a read-optimized projection as expected
// to lag/drift from the write-side source of truth, with reconciliation as the standard way
// to bound that drift -- NOT a reason to collapse the two models. T69 already has a STOP rule
// ("PR-check latency regresses -> keep separate + reconciliation job, documented") that picked
// exactly this shape for the same reason checkrun.ts/graph.ts must stay on the fast, local
// nodes/relations index. Reversible default recorded here: keep DUAL WRITE (rebuild.ts writes
// both, unchanged) + this reconciliation check, run after every rebuild and exposed read-only,
// rather than making @mole/temporal the sole write path for nodes/relations -- a future task
// can flip that default (route checkrun.ts/graph.ts through @mole/temporal instead) if the
// divergence rate this surfaces ever justifies the latency risk; nothing here forecloses it.
import type { Pool } from './db.js';
import { withOrgTx as withOrgTxServer } from './db.js';
import type { Pool as TemporalPool } from 'pg';
import { withOrgTx as withOrgTxTemporal } from '@mole/temporal';
import { currentDecision } from './decisionStore.js';

export interface ReconcileResult {
  orgId: string;
  /** decision ids present in the graph index (nodes, kind='decision') with no CURRENT
   *  @mole/temporal revision -- e.g. a rebuild wrote the index but the temporal write failed
   *  or was never attempted (temporalPool omitted). */
  missing: string[];
  /** decision ids with a CURRENT @mole/temporal revision but no matching node in the graph
   *  index -- e.g. a decision was recorded into temporal by a caller that bypassed rebuild.ts's
   *  own nodes/relations write, or the node was deleted by a later rebuild that did not also
   *  close the temporal fact. */
  extra: string[];
  /** decision ids present in both stores whose title/owner disagree -- the graph index and the
   *  temporal revision were written from different source data. */
  changed: string[];
}

/** All decision ids with a currently-live (recorded still open, valid contains now) revision
 *  in @mole/temporal for orgId. Scoped by RLS (mole_temporal_app + app.current_org_id), same as
 *  every other @mole/temporal read in this codebase -- this module never filters by org_id on
 *  its own authority. */
async function listCurrentTemporalDecisionIds(temporalPool: TemporalPool, orgId: string): Promise<string[]> {
  return withOrgTxTemporal(temporalPool, orgId, async (client) => {
    const { rows } = await client.query(
      `select distinct fact_id from fact_versions
       where kind = 'decision' and attr = 'record' and upper_inf(recorded) and valid @> now()`
    );
    return rows.map((r: { fact_id: string }) => r.fact_id);
  });
}

/**
 * Compares the server's own graph index (nodes/relations, read by the latency-critical
 * checkrun.ts/graph.ts path) against @mole/temporal's current decisions for orgId. Read-only:
 * never writes to either store. Intended to run after every rebuild (see index.ts's
 * 'rebuild-index' job handler) and be exposed via a read-only endpoint/CLI for inspection.
 */
export async function reconcileDecisions(pool: Pool, temporalPool: TemporalPool, orgId: string): Promise<ReconcileResult> {
  const indexDecisions = await withOrgTxServer(pool, orgId, async (client) => {
    const { rows } = await client.query<{ id: string; title: string; owner: string | null }>(
      "select id, title, owner from nodes where org_id = $1 and kind = 'decision'",
      [orgId]
    );
    return rows;
  });
  const temporalIds = new Set(await listCurrentTemporalDecisionIds(temporalPool, orgId));
  const indexIds = new Set(indexDecisions.map((d) => d.id));

  const missing = [...indexIds].filter((id) => !temporalIds.has(id)).sort();
  const extra = [...temporalIds].filter((id) => !indexIds.has(id)).sort();

  const changed: string[] = [];
  for (const d of indexDecisions) {
    if (!temporalIds.has(d.id)) continue; // already counted in `missing`
    const rev = await currentDecision(temporalPool, orgId, d.id);
    if (!rev) continue; // raced closed between listCurrentTemporalDecisionIds and here
    if (rev.title !== d.title || (rev.owner ?? null) !== (d.owner ?? null)) changed.push(d.id);
  }
  changed.sort();

  return { orgId, missing, extra, changed };
}
