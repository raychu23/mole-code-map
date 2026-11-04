// Index rebuild from `.mole/` files in git (R0 prior-art.md §3 Backstage processors, §4
// zoekt/Sourcegraph: the index is a rebuildable derived artifact of the versioned source;
// git stays the source of truth). Parses a minimal front-matter record format.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { Pool as TemporalPool } from 'pg';
import type { Pool } from './db.js';
import { recordDecisionRevision } from './decisionStore.js';

export interface MoleRecord {
  id: string;
  kind: 'tenet' | 'decision' | 'exception';
  status: string;
  title: string;
  scope: string[];
  owner?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Distinct error type for "git failed to read `.mole/` at this ref/dir" (missing ref,
 * missing/torn-down worktree dir, 'fatal: not a tree object', 'fatal: bad object', etc.).
 *
 * Root-cause fix (T33 review round 2 blocking finding, 2026-10-29): `listMoleFilesAtRef`
 * used to swallow ANY git failure with a bare `catch { return [] }`, which is
 * indistinguishable from "this ref legitimately has zero `.mole/` files". `rebuildIndexFromGit`
 * then treated that [] as ground truth and deleted the org's `nodes`/`relations` rows before
 * inserting nothing, silently wiping the decision index whenever a stale pg-boss job replayed
 * against a since-deleted temp fixture repo dir. A git failure and an empty tree are different
 * facts and must never be conflated: this type lets callers (rebuildIndexFromGit, job
 * handlers) treat "I can't tell what's in git" as a hard failure that leaves the existing
 * index untouched, never as "git says there's nothing here".
 */
export class GitReadError extends Error {
  constructor(repoDir: string, ref: string, cause: unknown) {
    super(`git failed to read .mole/ at ${ref} in ${repoDir}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'GitReadError';
    this.cause = cause;
  }
}

function listMoleFilesAtRef(repoDir: string, ref: string): string[] {
  let out: string;
  try {
    out = git(repoDir, ['ls-tree', '-r', '--name-only', ref, '--', '.mole']);
  } catch (e) {
    // NEVER return [] here: that's indistinguishable from "ref has no .mole/ files" and
    // would make rebuildIndexFromGit wipe the index on a missing ref/dir (the review
    // round 2 blocking bug). Throw a distinct, clearly-labeled error instead.
    throw new GitReadError(repoDir, ref, e);
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.endsWith('.md'));
}

function readFileAtRef(repoDir: string, ref: string, file: string): string {
  return git(repoDir, ['show', `${ref}:${file}`]);
}

/** Minimal YAML-front-matter parser for the fixture `.mole/decisions/*.md` shape used here. */
export function parseMoleRecord(text: string, fallbackId: string): MoleRecord {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const fm: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]!] = kv[2]!.trim();
    }
  }
  const scopeRaw = fm.scope ?? '[]';
  const scope = scopeRaw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: fm.id ?? fallbackId,
    kind: (fm.kind as MoleRecord['kind']) ?? 'decision',
    status: fm.status ?? 'accepted',
    title: fm.title ?? fallbackId,
    scope,
    owner: fm.owner,
  };
}

export interface RebuildOptions {
  shadow?: boolean; // write to a shadow org id, never touch the live org's rows
  // T69: also record each decision-kind record as a new @mole/temporal revision (tenant-scoped
  // current + as-of), the new authoritative store for a decision's content/status. Optional and
  // additive: the graph index (nodes/relations, read by graph.ts/checkrun.ts on the latency-
  // critical PR-check path) is written exactly as before regardless of whether this is set --
  // omitting it (e.g. an older caller, or a deploy that hasn't migrated yet) leaves the git-driven
  // rebuild's existing behaviour completely unchanged.
  temporalPool?: TemporalPool;
}

/**
 * Rebuilds the index for orgId from `.mole/` files at `ref` inside repoDir. Idempotent by
 * commit sha: calling this twice for the same (orgId, ref) logs the attempt but performs
 * the same deterministic replace, so duplicate webhook-triggered rebuilds have 0 extra
 * effect on the resulting index (only index_rebuild_log grows, which the M25 bench reads
 * to measure "duplicate effects", not the index itself).
 */
export async function rebuildIndexFromGit(
  pool: Pool,
  orgId: string,
  repoDir: string,
  ref: string,
  telemetry: { withSpan: <T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>) => Promise<T> } | undefined,
  opts: RebuildOptions = {}
): Promise<string> {
  const run = async () => {
    const files = listMoleFilesAtRef(repoDir, ref);
    const records = files.map((f) => parseMoleRecord(readFileAtRef(repoDir, ref, f), f));

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mole_app');
      await client.query('select set_config($1, $2, true)', ['app.current_org_id', orgId]);
      // Serialize ALL rebuilds for this org (across concurrent pg-boss workers and any
      // direct/reconcile calls): an xact-scoped advisory lock keyed by org_id, released
      // automatically at commit/rollback. Without this, two concurrent delete+insert
      // sequences for the same org can interleave and hit nodes_pkey (org_id, id) races.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [orgId]);
      // deterministic replace: delete then insert, in one transaction, so the index always
      // matches exactly what's in git at ref (never an accumulation of stale rows).
      await client.query('delete from nodes where org_id = $1', [orgId]);
      await client.query('delete from relations where org_id = $1', [orgId]);
      for (const rec of records) {
        await client.query(
          'insert into nodes(id, org_id, kind, title, file_path, commit_sha, owner) values ($1,$2,$3,$4,$5,$6,$7)',
          [rec.id, orgId, rec.kind, rec.title, rec.scope[0] ?? null, ref, rec.owner ?? null]
        );
        for (const file of rec.scope) {
          const codeId = `code:${file}`;
          await client.query(
            `insert into nodes(id, org_id, kind, title, file_path, commit_sha) values ($1,$2,'code',$3,$3,$4)
             on conflict (org_id, id) do nothing`,
            [codeId, orgId, file, ref]
          );
          await client.query(
            `insert into relations(org_id, from_id, to_id, type) values ($1,$2,$3,'applies_to')
             on conflict do nothing`,
            [orgId, rec.id, codeId]
          );
        }
      }
      if (!opts.shadow) {
        await client.query('insert into index_rebuild_log(org_id, commit_sha) values ($1,$2)', [orgId, ref]);
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    // T69: sync decision-kind records into @mole/temporal (the new authoritative decision
    // store) AFTER the nodes/relations transaction commits -- a separate failure domain, same
    // reconciliation-job shape as the STOP rule ("keep separate + reconciliation job"). A
    // temporal write failure here must never roll back or block the graph index the
    // latency-critical PR-check path depends on; it surfaces as a thrown error from this
    // function (same "never swallow silently" rule checkrun.ts's own review history enforces)
    // but the index itself is already durably committed by this point.
    if (opts.temporalPool) {
      for (const rec of records) {
        if (rec.kind !== 'decision') continue;
        await recordDecisionRevision(opts.temporalPool, orgId, rec, { source: ref });
      }
    }
    return snapshotHash(pool, orgId);
  };
  if (telemetry) return telemetry.withSpan('index.rebuild', { 'mole.org_id': orgId, 'mole.ref': ref }, run);
  return run();
}

/** A content hash of the current index for orgId, used to compare "live" vs "freshly rebuilt". */
export async function snapshotHash(pool: Pool, orgId: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('set role mole_app');
    await client.query('select set_config($1, $2, false)', ['app.current_org_id', orgId]);
    const nodes = await client.query('select id, kind, title, file_path from nodes where org_id = $1 order by id', [orgId]);
    const relations = await client.query('select from_id, to_id, type from relations where org_id = $1 order by from_id, to_id, type', [orgId]);
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(nodes.rows));
    hash.update(JSON.stringify(relations.rows));
    return hash.digest('hex');
  } finally {
    await client.query('reset role').catch(() => undefined);
    client.release();
  }
}
