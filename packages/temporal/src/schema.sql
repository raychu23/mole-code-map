-- T38 bitemporal fact store, now with tenant isolation (T47).
-- Maps 1:1 to PostgreSQL 18's
--   PRIMARY KEY (fact_id, attr, valid WITHOUT OVERLAPS)
-- (see https://wiki.postgresql.org/wiki/ApplicationTimeProgress, https://neon.com/postgresql/18/temporal-constraints).
-- Local Postgres here is 16, so the same guarantee is written as btree_gist + EXCLUDE USING gist: the
-- database itself refuses two overlapping rows for the same (org_id, fact_id, attr) -- not an app check.
--
-- Each row is one *version* of one fact's one attribute. History is append-only in spirit: a row's
-- VALUE and KIND are never changed or removed once written. The one controlled exception is closing:
-- when a fact's successor arrives, the still-open row's valid UPPER BOUND is set exactly once (an
-- UPDATE of that one bound, never of value/kind, and never a DELETE) -- the same "invalidate, never
-- delete" pattern as Graphiti's valid_at/invalid_at edges (edge_operations.py:715-783,
-- resolve_edge_contradictions), which also update a bound rather than removing the edge. See
-- closeFact/recordFact in src/index.ts.
--
-- Two time axes (Snodgrass bitemporal model, SQL:2011 application time + system-versioned time):
--   valid    = when the fact held in the world/code (application time, Graphiti's valid_at/invalid_at)
--   recorded = when Mole learned it (system/transaction time, Graphiti's created_at/expired_at)
-- recorded is always closed-open [recorded_from, recorded_to); a correction never edits recorded_to of
-- an old row's VALUE, it closes the old row's recorded range and inserts a new row with its own
-- recorded range, leaving the old one as history (knownAt below reads this axis).
--
-- Tenant isolation (T47, core-audit/storage-time-memory.md #1): org_id on every row, RLS with FORCE
-- so even the table owner's queries are scoped once run as the non-owner role below, copying
-- packages/server/src/db.ts's existing pattern (FORCE RLS, mole_app role, two-arg current_setting) --
-- also Graphiti's group_id on every Edge subclass (edges.py:51, decorators.handle_multiple_group_ids).
-- Because a bitemporal "correction" legitimately needs two rows with the SAME valid range (recorded
-- ranges disjoint -- the old belief's recorded is closed before the new one opens), the EXCLUDE
-- constraint below conflicts only when BOTH valid AND recorded overlap for the same
-- (org_id, fact_id, attr): that is the real contradiction case recordFact() must flag.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS fact_versions (
  id            bigserial PRIMARY KEY,
  org_id        text NOT NULL DEFAULT 'default',        -- tenant key (T47 #1)
  fact_id       text NOT NULL,                         -- e.g. a decision id 'D24', a node id, an edge id
  kind          text NOT NULL,                          -- decision | tenet | intent | incident | edge
  attr          text NOT NULL,                          -- e.g. 'status'
  value         text NOT NULL,
  valid         tstzrange NOT NULL,                      -- application time: when this value held
  valid_to      timestamptz GENERATED ALWAYS AS (upper(valid)) STORED, -- convenience: null while open
  recorded      tstzrange NOT NULL DEFAULT tstzrange(now(), NULL, '[)'), -- system time: when Mole knew it
  source        text                                     -- file:line or git sha this version came from
);

-- Migration for tables created before org_id/the bitemporal EXCLUDE existed (pre-T47 deployments):
-- additive, no data loss, every pre-existing row is tagged 'default' until a real tenant migration
-- assigns it (core-audit #1's "risk of the fix: low (additive)").
ALTER TABLE fact_versions ADD COLUMN IF NOT EXISTS org_id text NOT NULL DEFAULT 'default';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fact_versions_no_overlap') THEN
    ALTER TABLE fact_versions DROP CONSTRAINT fact_versions_no_overlap;
  END IF;
  ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_no_overlap EXCLUDE USING gist (
    org_id WITH =,
    fact_id WITH =,
    attr WITH =,
    valid WITH &&,
    recorded WITH &&
  );
END $$;

CREATE INDEX IF NOT EXISTS fact_versions_valid_gist ON fact_versions USING gist (org_id, fact_id, valid);
CREATE INDEX IF NOT EXISTS fact_versions_attr_valid_gist ON fact_versions USING gist (org_id, attr, valid);
CREATE INDEX IF NOT EXISTS fact_versions_recorded_gist ON fact_versions USING gist (org_id, fact_id, attr, recorded);

ALTER TABLE fact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_versions FORCE ROW LEVEL SECURITY;

-- decision -> scope (code anchor) edges, also bitemporal, for the recursive-CTE traversal
-- (decision -> scope -> code).
CREATE TABLE IF NOT EXISTS edge_versions (
  id            bigserial PRIMARY KEY,
  org_id        text NOT NULL DEFAULT 'default',
  edge_id       text NOT NULL,
  from_id       text NOT NULL,
  to_id         text NOT NULL,
  edge_type     text NOT NULL,                           -- traces_to | supersedes | overrides | ... (T29 EdgeType)
  valid         tstzrange NOT NULL,
  recorded      tstzrange NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  source        text
);

ALTER TABLE edge_versions ADD COLUMN IF NOT EXISTS org_id text NOT NULL DEFAULT 'default';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_versions_no_overlap') THEN
    ALTER TABLE edge_versions DROP CONSTRAINT edge_versions_no_overlap;
  END IF;
  ALTER TABLE edge_versions ADD CONSTRAINT edge_versions_no_overlap EXCLUDE USING gist (
    org_id WITH =,
    edge_id WITH =,
    valid WITH &&,
    recorded WITH &&
  );
END $$;

CREATE INDEX IF NOT EXISTS edge_versions_from_gist ON edge_versions USING gist (org_id, from_id, valid);
CREATE INDEX IF NOT EXISTS edge_versions_to_gist ON edge_versions USING gist (org_id, to_id, valid);

ALTER TABLE edge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_versions FORCE ROW LEVEL SECURITY;

-- Contradiction flags (core-audit #3, "make closeFact compare candidates" + Graphiti
-- resolve_edge_contradictions + ai-memory's advisory-only contradiction lint, contradiction_lint.rs
-- "writes no supersession and deletes nothing; the source pages are untouched"). recordFact() writes
-- one row here whenever a new fact invalidates an existing live belief instead of merely closing a
-- naturally-ended one; a person resolves it later (no UI here, a durable queryable row is the
-- done-when, per this task's non-goals).
CREATE TABLE IF NOT EXISTS contradiction_flags (
  id                    bigserial PRIMARY KEY,
  org_id                text NOT NULL DEFAULT 'default',
  fact_id               text NOT NULL,
  attr                  text NOT NULL,
  old_fact_version_id   bigint NOT NULL REFERENCES fact_versions(id),
  new_fact_version_id   bigint NOT NULL REFERENCES fact_versions(id),
  old_value             text NOT NULL,
  new_value             text NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  resolved              boolean NOT NULL DEFAULT false,
  resolved_by           text,
  resolved_at           timestamptz
);

ALTER TABLE contradiction_flags ADD COLUMN IF NOT EXISTS org_id text NOT NULL DEFAULT 'default';

ALTER TABLE contradiction_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contradiction_flags FORCE ROW LEVEL SECURITY;

-- Non-owner role every request/job connection must SET ROLE to (T47 #1, copying db.ts's
-- ensureAppRole/mole_app exactly: FORCE RLS is otherwise bypassed by the table owner/superuser,
-- postgresql.org/docs/current/ddl-rowsecurity.html).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mole_temporal_app') THEN
    CREATE ROLE mole_temporal_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO mole_temporal_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO mole_temporal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mole_temporal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO mole_temporal_app;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'fact_versions' AND policyname = 'fact_versions_org_isolation') THEN
    CREATE POLICY fact_versions_org_isolation ON fact_versions
      USING (org_id = current_setting('app.current_org_id', true))
      WITH CHECK (org_id = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'edge_versions' AND policyname = 'edge_versions_org_isolation') THEN
    CREATE POLICY edge_versions_org_isolation ON edge_versions
      USING (org_id = current_setting('app.current_org_id', true))
      WITH CHECK (org_id = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'contradiction_flags' AND policyname = 'contradiction_flags_org_isolation') THEN
    CREATE POLICY contradiction_flags_org_isolation ON contradiction_flags
      USING (org_id = current_setting('app.current_org_id', true))
      WITH CHECK (org_id = current_setting('app.current_org_id', true));
  END IF;
END $$;
