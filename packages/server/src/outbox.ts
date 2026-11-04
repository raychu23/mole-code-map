// Transactional outbox (R0 prior-art.md §5, Richardson microservices.io): write the
// notification in the same DB transaction as the state change; a separate relay delivers
// it to the (fake) GitHub API and marks it delivered only after a successful send.
import type { PoolClient } from 'pg';
import type { Pool } from './db.js';

export async function writeOutboxInTx(client: PoolClient, orgId: string, kind: string, payload: any, ref?: string): Promise<void> {
  await client.query('set local role mole_app');
  await client.query('select set_config($1, $2, true)', ['app.current_org_id', orgId]);
  // idempotent per (org, kind, ref): a duplicate-triggered write for the same ref has 0
  // extra effect (M25 "0 duplicate effects"), it just collapses into the existing row.
  await client.query(
    `insert into outbox(org_id, kind, ref, payload) values ($1,$2,$3,$4)
     on conflict (org_id, kind, ref) where ref is not null do nothing`,
    [orgId, kind, ref ?? payload?.ref ?? null, JSON.stringify(payload)]
  );
}

export interface FakeGithubClient {
  postCheckRun(orgId: string, ref: string, payload: unknown): Promise<void>;
  postNotification?(orgId: string, payload: unknown): Promise<void>;
}

/** Claims and relays one batch of undelivered outbox rows; returns how many were delivered. */
export async function relayOutboxOnce(pool: Pool, sink: FakeGithubClient): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `select id, org_id, kind, payload from outbox where delivered_at is null order by id limit 50 for update skip locked`
    );
    let n = 0;
    for (const row of rows) {
      await sink.postCheckRun(row.org_id, row.payload?.ref ?? 'unknown', row.payload);
      await client.query('update outbox set delivered_at = now() where id = $1', [row.id]);
      n++;
    }
    await client.query('commit');
    return n;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
