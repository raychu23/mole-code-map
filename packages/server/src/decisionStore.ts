// T69: the server's own second Postgres model (db.ts's nodes/relations) duplicates what a
// decision's content/status already is. This module makes @mole/temporal the single
// authoritative store for a decision's REVISION HISTORY (current + as-of, tenant-scoped),
// while nodes/relations stays exactly as-is as the latency-critical governance-graph index
// checkrun.ts/graph.ts already read (STOP rule: "PR-check latency regresses -> keep separate
// + reconciliation job, documented" -- see 2 insights.md). rebuild.ts's full git-driven
// rebuild IS that reconciliation job: it now writes both the graph index (unchanged) and a
// temporal revision (new), from the same parsed MoleRecord, in the same rebuild pass.
//
// Design borrowed from (see 4 log/prior-art.md for full citations):
//  - XTDB: "current" is not a separate table, it's `asOf(now())` over the bitemporal rows.
//  - Datomic: a correction is a new immutable fact, never an edit of the old one.
//  - @mole/temporal's own recordFact/asOf (already (internal task reference removed) via RLS FORCE) --
//    this module adds ZERO new SQL; it is a thin, server-shaped wrapper.
import type { Pool as TemporalPool } from 'pg';
import { withOrgTx, asOf, recordFact } from '@mole/temporal';
import type { MoleRecord } from './rebuild.js';

export interface DecisionRevision {
  status: string;
  title: string;
  scope: string[];
  owner: string | null;
}

const ATTR = 'record'; // one fact per decision id; its value is the whole revision, JSON-encoded

function toValue(record: MoleRecord): string {
  return JSON.stringify({ status: record.status, title: record.title, scope: record.scope, owner: record.owner ?? null });
}

function fromValue(value: string | null): DecisionRevision | null {
  return value === null ? null : (JSON.parse(value) as DecisionRevision);
}

/**
 * Records one decision as a new temporal revision, tenant-scoped to orgId. Safe to call
 * on every rebuild for every decision-kind record, including unchanged ones: recordFact's own
 * same-value coalescing (see packages/temporal/src/index.ts) makes a byte-identical repeat a
 * no-op, and a genuinely changed status becomes a new forward-dated revision, never an edit of
 * the old one (Datomic/XTDB "as-of" precedent -- see prior-art.md).
 */
export async function recordDecisionRevision(
  temporalPool: TemporalPool,
  orgId: string,
  record: MoleRecord,
  opts: { validFrom?: string; source?: string } = {},
): Promise<void> {
  const validFrom = opts.validFrom ?? new Date().toISOString();
  await withOrgTx(temporalPool, orgId, async (client) => {
    await recordFact(client, {
      orgId,
      factId: record.id,
      kind: 'decision',
      attr: ATTR,
      value: toValue(record),
      validFrom,
      validTo: null,
      source: opts.source,
    });
  });
}

/** Current (as-of now) revision of a decision, scoped to orgId only -- RLS FORCE (T47) means a
 *  caller asking about another org's decision id gets null back, never another org's data or
 *  an error. XTDB framing: "current" is simply asOf(now()), not a second table. */
export async function currentDecision(temporalPool: TemporalPool, orgId: string, factId: string): Promise<DecisionRevision | null> {
  return withOrgTx(temporalPool, orgId, async (client) => {
    const value = await asOf(client, factId, ATTR, new Date().toISOString());
    return fromValue(value);
  });
}

/** What a decision's revision was at a specific application-time instant, scoped to orgId
 *  only. Thin pass-through to @mole/temporal's asOf (valid-time axis; see prior-art.md's
 *  Datomic/XTDB section for why this -- not knownAt -- is the right primitive for "what did
 *  this decision say on date X", as opposed to "what did we believe about date X, as of date
 *  Y" which stays available via @mole/temporal's own knownAt for a future caller that needs it). */
export async function decisionAsOf(temporalPool: TemporalPool, orgId: string, factId: string, at: string): Promise<DecisionRevision | null> {
  return withOrgTx(temporalPool, orgId, async (client) => {
    const value = await asOf(client, factId, ATTR, at);
    return fromValue(value);
  });
}
