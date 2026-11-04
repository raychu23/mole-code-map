// T38 bitemporal decision graph (M32), now with T47 tenant isolation. Schema is
// packages/temporal/src/schema.sql (btree_gist + EXCLUDE USING gist: maps 1:1 to PG18's
// `PRIMARY KEY (..., valid WITHOUT OVERLAPS)`, see that file's header comment). History is
// append-only: insertFact only INSERTs; closeFact performs exactly one UPDATE of an open row's
// upper bound (bounding its range, never rewriting its value) -- the same "invalidate, never
// delete" pattern as Graphiti's valid_at/invalid_at edges (edge_operations.py:715-783).
//
// T47: every table carries org_id and is scoped by Postgres RLS with FORCE (copying
// packages/server/src/db.ts's withOrgTx/mole_app pattern exactly, here as mole_temporal_app --
// see schema.sql's comment block). Callers MUST run every fact/edge/flag query through
// withOrgTx; the functions below accept a Queryable (Pool or a PoolClient already inside a
// withOrgTx callback) and never filter by org_id themselves -- RLS is the enforcement boundary,
// exactly like db.ts's nodes/relations/outbox queries.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export interface FactInput {
  orgId: string;
  factId: string;
  kind: 'decision' | 'tenet' | 'intent' | 'incident' | 'edge';
  attr: string;
  value: string;
  validFrom: string;
  validTo: string | null;
  source?: string;
}

/** Anything with pg's `.query(text, params)` shape: a Pool, or a PoolClient inside withOrgTx. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export function openPool(connectionString: string, config: PoolConfig = {}): Pool {
  // small pool by default: Postgres here is shared across several builders' worktrees
  // (max_connections=100 on this machine) -- never hold more than a courteous slice of it.
  return new Pool({ connectionString, max: 15, ...config });
}

// schema.sql is a checked-in source file, not emitted by tsc: resolve it relative to the package
// root (src/schema.sql) whether this module is running from src (vitest) or dist/src (built).
const hereDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = hereDir.endsWith(join('dist', 'src')) ? join(hereDir, '..', '..', 'src', 'schema.sql') : join(hereDir, 'schema.sql');
const SCHEMA_SQL = readFileSync(schemaPath, 'utf8');

export async function applySchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

/**
 * Runs fn with a connection scoped (via SET LOCAL + SET ROLE, inside one transaction) to orgId,
 * so every RLS policy in schema.sql applies for the duration of fn. This is the only way
 * application code should touch fact_versions/edge_versions/contradiction_flags (T47 #1), copying
 * packages/server/src/db.ts's withOrgTx (mole_app there, mole_temporal_app here) exactly.
 */
export async function withOrgTx<T>(pool: Pool, orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role mole_temporal_app');
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

/**
 * Insert one fact version. The database enforces 0 (valid && recorded) overlaps per
 * (org_id, fact_id, attr) via EXCLUDE USING gist -- this never relies on an app-level check (a
 * bitemporal correction legitimately inserts a second row with the SAME valid range once the old
 * row's recorded range is closed; see schema.sql and recordFact below). A call that is an exact
 * duplicate of an existing LIVE row (same fact/attr/value/valid bounds, recorded still open) is a
 * no-op: idempotent re-insertion is not the same thing as a conflicting fact.
 */
/**
 * recordedFrom is INTERNAL ONLY (T47 fresh-review P1): it exists purely so recordFact() below can
 * hand in the exact clock.timestamp.now() instant it used to CLOSE the conflicting row's recorded
 * range -- Postgres's own now() is frozen to the enclosing transaction's start time (every
 * statement in one tx sees the same now()), so relying on the column DEFAULT here would make this
 * row's recorded START predate the old row's just-closed recorded END within the same
 * transaction, re-triggering the EXCLUDE. It is deliberately NOT a parameter of the exported
 * insertFact -- a prior version took it as a public third argument, which let any caller backdate
 * system time arbitrarily (e.g. "we knew this back in 2015") with zero audit trail. If a caller
 * still reaches past the TypeScript signature (plain JS, `as any`) and passes a third positional
 * argument to the exported insertFact, it is simply ignored: the row is always recorded as of
 * now().
 */
async function insertFactVersion(client: Queryable, f: FactInput, recordedFrom?: string): Promise<number> {
  const dup = await client.query(
    `select id from fact_versions
     where fact_id = $1 and attr = $2 and value = $3
       and lower(valid) = $4::timestamptz
       and (upper(valid) is null) = ($5::timestamptz is null)
       and (upper(valid) is null or upper(valid) = $5::timestamptz)
       and upper_inf(recorded)
     limit 1`,
    [f.factId, f.attr, f.value, f.validFrom, f.validTo],
  );
  if ((dup.rowCount ?? 0) > 0) return dup.rows[0].id;
  const inserted = await client.query(
    `insert into fact_versions (org_id, fact_id, kind, attr, value, valid, recorded, source)
     values ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $7::timestamptz, '[)'),
             tstzrange(coalesce($9::timestamptz, now()), NULL, '[)'), $8)
     returning id`,
    [f.orgId, f.factId, f.kind, f.attr, f.value, f.validFrom, f.validTo, f.source ?? null, recordedFrom ?? null],
  );
  return inserted.rows[0].id;
}

/** Insert one fact version, recorded as of now(). See insertFactVersion's doc comment for why
 *  recordedFrom is not part of this public signature. */
export async function insertFact(client: Queryable, f: FactInput): Promise<void> {
  await insertFactVersion(client, f);
}

/** Close the currently-open version of (factId, attr): bound its valid range's upper end at `at`.
 *  Exactly one UPDATE of the upper bound of the still-open row -- the value itself is never touched,
 *  and once a row's upper bound is set it is never updated again (see test/temporal.test.ts). */
export async function closeFact(client: Queryable, factId: string, attr: string, at: string): Promise<void> {
  await client.query(
    `update fact_versions
     set valid = tstzrange(lower(valid), $3::timestamptz, '[)')
     where fact_id = $1 and attr = $2 and upper_inf(valid) and upper_inf(recorded)`,
    [factId, attr, at],
  );
}

/**
 * Contradiction-aware insert (core-audit #3: "make closeFact compare candidates, not just stamp
 * one row"; Graphiti's resolve_edge_contradictions, edge_operations.py:715-783; ai-memory's
 * advisory-only contradiction_lint.rs: "writes no supersession and deletes nothing"). Looks at
 * every existing LIVE row (recorded still open) for the same (org, fact_id, attr) whose valid
 * range overlaps f's. If none differ in value (or there are none at all, or the one that matches
 * is an exact duplicate of f -- idempotent re-insertion), it is just a normal insertFact.
 *
 * T47 fresh-review fix #2 (P0, retroactive change spanning MULTIPLE live versions): a forward
 * split (the world-change case below) can leave two or more disjoint LIVE rows for the same
 * (fact, attr) -- e.g. OPEN [Jan1,Mar1) and DECIDED [Mar1,inf). A later retroactive correction's
 * valid range can overlap several of those at once (e.g. REJECTED from Feb1 onward overlaps both).
 * The old implementation picked exactly ONE conflicting row via `.find()` and closed only that
 * one; the other stayed live, still overlapping f's about-to-be-inserted range, and the INSERT hit
 * fact_versions_no_overlap (EXCLUDE USING gist) with a raw 23P01 escaping -- no row written, no
 * flag raised, the caller just gets an unhandled exception.
 *
 * This now follows standard SQL:2011 `UPDATE ... FOR PORTION OF` semantics (equivalently, how
 * XTDB handles a `put` whose valid-time range spans several existing versions,
 * docs.xtdb.com/about/time-in-xtdb): EVERY live row overlapping f's valid range is located and
 * locked (SELECT ... FOR UPDATE, so a concurrent recordFact on the same rows can't race past this
 * read), and for each one:
 *   - its RECORDED range is closed now (value/valid never mutated in place, same as before),
 *   - any non-overlapping leftover piece(s) of its ORIGINAL valid range -- the part before f's
 *     range starts, and/or the part after f's range ends, whichever exist -- are re-inserted as
 *     new rows carrying the row's OLD value and a fresh recorded range starting now. A row fully
 *     inside f's range has no leftover at all.
 * f itself is inserted exactly once at the end, covering its own full range.
 *
 * Per-row world-change vs correction (generalizes the single-row 2x2 matrix below to N rows):
 * a row is a pure FORWARD change (no flag) only when f starts strictly after that row's own
 * validFrom AND consuming f's range does not leave a leftover piece AFTER f's range that would
 * revert back to the row's old value -- a genuine world change never un-does itself later. Any
 * row that fails either test (f starts at/before the row's validFrom, i.e. a retroactive overlap;
 * or f's range is a strict interior slice of the row's range, reverting to the old value
 * afterward) is a CORRECTION: one contradiction_flags row is raised for that row (old_value =
 * that row's value, new_value = f.value). A retroactive change spanning several live rows can
 * therefore raise more than one flag -- the returned `flagId` is only the first one; callers that
 * need the full set should query listContradictionFlags.
 *
 * T47 third-review fix (P0, same-value overlap crash): a SAME-value live row that merely
 * overlaps or touches f's valid range (e.g. live OPEN [Jan15,Jan18), new recordFact OPEN
 * [Jan16,Jan19)) is not a "conflict" by value, but it is also not safe to hand to plain
 * insertFact: insertFact's own dedup only short-circuits an EXACT-bounds duplicate, so any other
 * same-value overlap gets inserted as a brand-new row that collides with the still-live row in
 * BOTH `valid` and `recorded` -> fact_versions_no_overlap (EXCLUDE USING gist) raises 23P01.
 * Fixed with standard temporal COALESCING (Snodgrass, "Developing Time-Oriented Database
 * Applications in SQL", ch. 6; SQL:2011 PERIOD coalescing; XTDB `put` semantics,
 * docs.xtdb.com/about/time-in-xtdb): every LIVE same-value row that overlaps OR is immediately
 * adjacent to f's range is routed through the exact same FOR-PORTION-OF machinery as a
 * conflicting row -- its recorded range is closed now, never mutated in place -- and instead of
 * being reinserted as leftover pieces, all of them are merged with f's own range into ONE new
 * row spanning [min(all valid_from), max(all valid_to)]. This keeps the live-row invariant (no
 * two live rows for the same (fact, attr) ever overlap, and none of them sit needlessly
 * fragmented across equal-value adjacent pieces) and makes the same-value fast path a true no-op
 * only when f is a byte-for-byte duplicate of the one live row it would otherwise touch.
 */
export async function recordFact(
  client: Queryable,
  f: FactInput,
  /** Test-only clock hook (T47 third-review fix): lets tests step the system-time axis by
   *  logical offsets instead of real wall-clock `sleep()`s between recordFact calls. Internal --
   *  not meant for production callers, same spirit as insertFactVersion's recordedFrom. */
  opts: { now?: string } = {},
): Promise<{ invalidated: boolean; flagId: number | null }> {
  // Lock every LIVE row that overlaps f's valid range, OR merely touches one of its boundaries
  // (needed to coalesce an adjacent equal-value piece, not just an overlapping one). Any two live
  // rows for the same (org, fact_id, attr) always have disjoint valid ranges (both have recorded
  // ranges open to infinity, so they always overlap in `recorded`; fact_versions_no_overlap
  // therefore already forces their `valid` ranges apart) -- so each candidate below can be
  // processed independently without its leftover/merged pieces colliding with another
  // candidate's.
  const candidates = await client.query(
    `select id, value, lower(valid) as valid_from, upper(valid) as valid_to
     from fact_versions
     where fact_id = $1 and attr = $2
       and upper_inf(recorded)
       and (
         valid && tstzrange($3::timestamptz, $4::timestamptz, '[)')
         or upper(valid) = $3::timestamptz
         or ($4::timestamptz is not null and lower(valid) = $4::timestamptz)
       )
     order by id
     for update`,
    [f.factId, f.attr, f.validFrom, f.validTo],
  );

  const fFrom = new Date(f.validFrom).getTime();
  const fTo = f.validTo ? new Date(f.validTo).getTime() : null;

  const rows = (candidates.rows as Array<{ id: number; value: string; valid_from: string; valid_to: string | null }>).map((r) => ({
    id: r.id,
    value: r.value,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    from: new Date(r.valid_from).getTime(),
    to: r.valid_to ? new Date(r.valid_to).getTime() : null,
  }));

  // True overlap with f (strict -- excludes rows that only touch a boundary), used to decide
  // which different-value rows are genuine conflicts.
  const overlapsF = (rowFrom: number, rowTo: number | null) => {
    const afterFStart = rowTo === null || rowTo > fFrom;
    const beforeFEnd = fTo === null || rowFrom < fTo;
    return afterFStart && beforeFEnd;
  };

  const sameValue = rows.filter((r) => r.value === f.value);
  const conflicting = rows.filter((r) => r.value !== f.value && overlapsF(r.from, r.to));

  if (sameValue.length === 0 && conflicting.length === 0) {
    await insertFactVersion(client, f, opts.now);
    return { invalidated: false, flagId: null };
  }

  // Idempotent no-op, preserved exactly: f is a byte-for-byte duplicate of the one live row it
  // would otherwise touch, and there is nothing else to merge or flag.
  if (conflicting.length === 0 && sameValue.length === 1 && sameValue[0]!.from === fFrom && sameValue[0]!.to === fTo) {
    await insertFactVersion(client, f, opts.now);
    return { invalidated: false, flagId: null };
  }

  // System time comes from the DATABASE clock, never the app server's: existing rows' recorded ranges
  // were opened by Postgres now(), so a Node clock even slightly behind the DB would close a row before
  // it opened ("range lower bound must be less than or equal to range upper bound"; found by the T47
  // review property test, 9/200 sequences). clock_timestamp() advances within the transaction, unlike now().
  const now =
    opts.now ?? ((await client.query('SELECT clock_timestamp()::text AS t')).rows[0] as { t: string }).t;
  const flagTargets: Array<{ rowId: number; oldValue: string }> = [];

  // Coalesce: close every same-value candidate's recorded range now, and widen the range that
  // will be written for f to cover all of them (overlapping or merely adjacent).
  let mergedFromStr = f.validFrom;
  let mergedFromNum = fFrom;
  let mergedToStr = f.validTo;
  let mergedToNum = fTo;
  let mergedToOpen = fTo === null;
  for (const row of sameValue) {
    await client.query(
      `update fact_versions set recorded = tstzrange(lower(recorded), $2::timestamptz, '[)') where id = $1`,
      [row.id, now],
    );
    if (row.from < mergedFromNum) {
      mergedFromNum = row.from;
      mergedFromStr = row.validFrom;
    }
    if (!mergedToOpen) {
      if (row.to === null) {
        mergedToOpen = true;
        mergedToStr = null;
      } else if (mergedToNum === null || row.to > mergedToNum) {
        mergedToNum = row.to;
        mergedToStr = row.validTo;
      }
    }
  }

  for (const row of conflicting) {
    await client.query(
      `update fact_versions set recorded = tstzrange(lower(recorded), $2::timestamptz, '[)') where id = $1`,
      [row.id, now],
    );

    const leftoverBefore = row.from < fFrom;
    const leftoverAfter = fTo !== null && (row.to === null || row.to > fTo);

    if (leftoverBefore) {
      await insertFactVersion(
        client,
        { orgId: f.orgId, factId: f.factId, kind: f.kind, attr: f.attr, value: row.value, validFrom: row.validFrom, validTo: f.validFrom },
        now,
      );
    }
    if (leftoverAfter) {
      await insertFactVersion(
        client,
        { orgId: f.orgId, factId: f.factId, kind: f.kind, attr: f.attr, value: row.value, validFrom: f.validTo as string, validTo: row.validTo },
        now,
      );
    }

    const isWorldChange = fFrom > row.from && !leftoverAfter;
    if (!isWorldChange) {
      flagTargets.push({ rowId: row.id, oldValue: row.value });
    }
  }

  const newId = await insertFactVersion(
    client,
    { ...f, validFrom: mergedFromStr, validTo: mergedToOpen ? null : mergedToStr },
    now,
  );

  let firstFlagId: number | null = null;
  for (const target of flagTargets) {
    const flag = await client.query(
      `insert into contradiction_flags (org_id, fact_id, attr, old_fact_version_id, new_fact_version_id, old_value, new_value)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [f.orgId, f.factId, f.attr, target.rowId, newId, target.oldValue, f.value],
    );
    if (firstFlagId === null) firstFlagId = flag.rows[0]?.id ?? null;
  }

  return { invalidated: flagTargets.length > 0, flagId: firstFlagId };
}
// Concurrency note: two recordFact calls racing on the same (org_id, fact_id, attr) can both try
// to write recorded ranges that overlap once committed -- fact_versions_no_overlap (EXCLUDE USING
// gist over valid && recorded) rejects the loser with a Postgres exclusion-violation error
// (SQLSTATE 23P01), it does not silently corrupt history. Callers must catch 23P01 and retry the
// whole recordFact call (typically after a short backoff) rather than treating it as fatal. The
// FOR UPDATE lock on candidates above narrows this window to the rare case of a brand-new row
// appearing between the lock and the final insertFactVersion(f, now), not the common case.

export interface ContradictionFlag {
  id: number;
  factId: string;
  attr: string;
  oldFactVersionId: number;
  newFactVersionId: number;
  oldValue: string;
  newValue: string;
  detectedAt: string;
  resolved: boolean;
}

/** Durable, queryable list of open (or all) contradiction flags for a person to review -- no UI,
 *  per this task's non-goals, just a row that outlives the process that raised it. */
export async function listContradictionFlags(
  client: Queryable,
  opts: { factId?: string; onlyUnresolved?: boolean } = {},
): Promise<ContradictionFlag[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.factId) {
    params.push(opts.factId);
    conditions.push(`fact_id = $${params.length}`);
  }
  if (opts.onlyUnresolved) {
    conditions.push('resolved = false');
  }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const r = await client.query(
    `select id, fact_id, attr, old_fact_version_id, new_fact_version_id, old_value, new_value, detected_at, resolved
     from contradiction_flags ${where} order by id`,
    params,
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    factId: row.fact_id,
    attr: row.attr,
    oldFactVersionId: row.old_fact_version_id,
    newFactVersionId: row.new_fact_version_id,
    oldValue: row.old_value,
    newValue: row.new_value,
    detectedAt: row.detected_at,
    resolved: row.resolved,
  }));
}

/** What held for (factId, attr) at the given instant (application/valid time), among LIVE rows
 *  (recorded still open) -- the current belief, same contract as before T47. null = no fact yet. */
export async function asOf(client: Queryable, factId: string, attr: string, at: string): Promise<string | null> {
  const r = await client.query(
    `select value from fact_versions
     where fact_id = $1 and attr = $2 and valid @> $3::timestamptz and upper_inf(recorded)
     order by id desc limit 1`,
    [factId, attr, at],
  );
  return r.rows[0]?.value ?? null;
}

/**
 * What did we believe (factId, attr) held at `validAt` (application time), as recorded/known at
 * `recordedAt` (system time) -- the second bitemporal axis (core-audit #2: "schema.sql already has
 * recorded and writes it; asOf/diff/decisionToCode never read it"; XTDB's as-of-system-time vs.
 * the default as-best-known, docs.xtdb.com/about/time-in-xtdb). null = nothing was known yet.
 */
export async function knownAt(
  client: Queryable,
  factId: string,
  attr: string,
  validAt: string,
  recordedAt: string,
): Promise<string | null> {
  const r = await client.query(
    `select value from fact_versions
     where fact_id = $1 and attr = $2
       and valid @> $3::timestamptz
       and recorded @> $4::timestamptz
     order by id desc limit 1`,
    [factId, attr, validAt, recordedAt],
  );
  return r.rows[0]?.value ?? null;
}

/** What (factId, attr) held at t1 vs t2 (both application/valid time, current belief). */
export async function diff(
  client: Queryable,
  factId: string,
  attr: string,
  t1: string,
  t2: string,
): Promise<{ from: string | null; to: string | null }> {
  const [from, to] = await Promise.all([asOf(client, factId, attr, t1), asOf(client, factId, attr, t2)]);
  return { from, to };
}

/**
 * decision -> scope -> code: recursive CTE over edge_versions (traces_to/supersedes/...), as-of a
 * point in time (default: now). Returns every id reachable from `rootId` following edges valid at
 * `at`, with the hop depth.
 */
export async function decisionToCode(
  client: Queryable,
  rootId: string,
  at: string = new Date().toISOString(),
  maxDepth = 8,
): Promise<Array<{ id: string; depth: number; edgeType: string }>> {
  const r = await client.query(
    `with recursive walk(id, depth, edge_type) as (
       select $1::text, 0, ''::text
       union all
       select e.to_id, w.depth + 1, e.edge_type
       from edge_versions e
       join walk w on e.from_id = w.id
       where e.valid @> $2::timestamptz and w.depth < $3
     )
     select id, depth, edge_type from walk where depth > 0`,
    [rootId, at, maxDepth],
  );
  return r.rows;
}

export { loadDecisionsJsonl, loadMoleDecisionsGit } from './loader.js';
