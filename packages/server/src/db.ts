// Postgres pool + schema migrations + RLS (R0 prior-art.md §6: non-owner FORCE ROW LEVEL
// SECURITY role, org_id on every tenant table, SET LOCAL app.current_org_id per request).
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}

const SCHEMA_SQL = `
create table if not exists orgs (
  id text primary key,
  name text not null
);

create table if not exists deliveries (
  delivery_id text not null,
  org_id text not null,
  event text not null,
  commit_sha text,
  received_at timestamptz not null default now(),
  primary key (delivery_id)
);

create table if not exists index_rebuild_log (
  id bigserial primary key,
  org_id text not null,
  commit_sha text not null,
  rebuilt_at timestamptz not null default now()
);

create table if not exists nodes (
  id text not null,
  org_id text not null,
  kind text not null, -- tenet | decision | exception | code | test | person | agent
  title text not null,
  file_path text,
  commit_sha text,
  owner text, -- CODEOWNERS/front-matter owner for this node, persisted by rebuild.ts so
              -- questions.ts routeQuestion can resolve "records first, else CODEOWNERS owner"
              -- (review round 1 P0 #2) without re-parsing CODEOWNERS on every read.
  primary key (org_id, id)
);
alter table nodes enable row level security;
alter table nodes force row level security;
-- Migration for pre-existing tables created before the owner column existed.
alter table nodes add column if not exists owner text;

create table if not exists relations (
  org_id text not null,
  from_id text not null,
  to_id text not null,
  type text not null,
  primary key (org_id, from_id, to_id, type)
);
alter table relations enable row level security;
alter table relations force row level security;

create table if not exists outbox (
  id bigserial primary key,
  org_id text not null,
  kind text not null,
  ref text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
alter table outbox enable row level security;
alter table outbox force row level security;
create unique index if not exists outbox_org_kind_ref_uniq on outbox (org_id, kind, ref) where ref is not null;

create table if not exists questions_log (
  id bigserial primary key,
  org_id text not null,
  file_path text not null,
  owner text not null,
  via text not null,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (select from pg_policies where tablename = 'nodes' and policyname = 'nodes_org_isolation') then
    create policy nodes_org_isolation on nodes
      using (org_id = current_setting('app.current_org_id', true))
      with check (org_id = current_setting('app.current_org_id', true));
  end if;
  if not exists (select from pg_policies where tablename = 'relations' and policyname = 'relations_org_isolation') then
    create policy relations_org_isolation on relations
      using (org_id = current_setting('app.current_org_id', true))
      with check (org_id = current_setting('app.current_org_id', true));
  end if;
  if not exists (select from pg_policies where tablename = 'outbox' and policyname = 'outbox_org_isolation') then
    create policy outbox_org_isolation on outbox
      using (org_id = current_setting('app.current_org_id', true))
      with check (org_id = current_setting('app.current_org_id', true));
  end if;
end $$;
`;

/** Creates (idempotently) a non-owner role used for every RLS-scoped request/job connection. */
async function ensureAppRole(pool: Pool | pg.PoolClient): Promise<void> {
  await pool.query(`
    do $$ begin
      if not exists (select from pg_roles where rolname = 'mole_app') then
        create role mole_app login;
      end if;
    end $$;
  `);
  await pool.query('grant usage on schema public to mole_app');
  await pool.query('grant all on all tables in schema public to mole_app');
  await pool.query('grant usage, select on all sequences in schema public to mole_app');
  await pool.query('alter default privileges in schema public grant all on tables to mole_app');
}

export async function runMigrations(pool: Pool): Promise<void> {
  // Multiple test files run their own migrations concurrently against one DB; take a
  // session advisory lock so "create table if not exists" races don't duplicate-key on
  // Postgres's implicit row type for a table (a known concurrent-DDL race, not an M25 bug).
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query(SCHEMA_SQL);
    await ensureAppRole(client as any);
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
}

/**
 * Runs fn with a connection scoped (via SET LOCAL + SET ROLE, inside one transaction) to
 * orgId, so every RLS policy above applies for the duration of fn. This is the only way
 * server code should ever touch nodes/relations/outbox (R0 §6 "automated WHERE").
 */
export async function withOrgTx<T>(pool: Pool, orgId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role mole_app');
    await client.query('select set_config($1, $2, true)', ['app.current_org_id', orgId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Read-only variant: same org scoping, no transaction mutation implied beyond SET LOCAL. */
export async function withOrgRead<T>(pool: Pool, orgId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withOrgTx(pool, orgId, fn);
}
