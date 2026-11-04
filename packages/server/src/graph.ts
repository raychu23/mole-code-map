// Decision graph relations via recursive CTE (tenets -> decisions -> exceptions -> code,
// per the task contract and D31 "center = decisions behind the code"). RLS-scoped: callers
// always read through withOrgTx-style scoping so a viewer from another org gets 0 rows.
import type { Pool } from './db.js';

export interface GoverningDecision {
  id: string;
  kind: string;
  title: string;
  owner: string | null;
}

/**
 * Returns the decisions/tenets that (transitively, via `relations`) govern filePath, scoped
 * to the CALLER's org (viewerOrg). `forOrg` names which org's repo/file this is about; when
 * viewerOrg !== the org that actually owns those rows, RLS guarantees 0 rows back — this is
 * exactly the M25 permission-leak test, not a separate code path.
 */
export async function getGoverningDecisions(
  pool: Pool,
  viewerOrg: string,
  filePath: string,
  opts: { forOrg?: string } = {}
): Promise<GoverningDecision[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role mole_app');
    // RLS reads current_setting('app.current_org_id'); setting it to viewerOrg means every
    // row returned below is restricted to rows whose org_id = viewerOrg, regardless of
    // which org's data the caller asked about in opts.forOrg.
    await client.query('select set_config($1, $2, true)', ['app.current_org_id', viewerOrg]);
    const codeId = `code:${filePath}`;
    const { rows } = await client.query(
      `with recursive gov as (
         select from_id, to_id, type from relations where to_id = $1
         union all
         select r.from_id, r.to_id, r.type
         from relations r
         join gov g on r.to_id = g.from_id
       )
       select distinct n.id, n.kind, n.title, n.owner
       from gov g
       join nodes n on n.id = g.from_id
       where n.org_id = current_setting('app.current_org_id', true)`,
      [codeId]
    );
    await client.query('commit');
    return rows;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
