// pg-boss (Postgres-backed queue, no Redis). R0 prior-art.md §8: jobs enqueued in the same
// DB transaction as the delivery row that produced them (an outbox application), SKIP
// LOCKED-based workers, dead-letter via pg-boss's own retry/DLQ support.
import PgBoss from 'pg-boss';

export type Boss = PgBoss;

export const QUEUES = ['rebuild-index', 'compute-check-run', 'relay-outbox'] as const;

/**
 * Root-cause fix (T33 review round 2 blocking finding, 2026-10-29): with no retention/retry
 * bound, pg-boss jobs from old bench runs (each run builds fresh temp fixture repo dirs via
 * `mkdtempSync`, then deletes them on exit) accumulated in this long-lived local Postgres
 * instance (`/tmp/mole-pg-1OjR`) and got replayed by a *later* run's `boss.work(...)` against
 * the same DB, pointing at since-deleted dirs. Combined with rebuild.ts's old
 * swallow-git-failure-as-empty bug, that silently wiped an org's index. Fixing rebuild.ts to
 * throw (see GitReadError) stops the wipe outright, but a permanently-failing job referencing
 * a deleted dir would otherwise retry forever and the job table would grow unbounded across
 * many bench reruns — so this also bounds both.
 *
 * Per pg-boss README (queue "Retry" and "Maintenance" options, pg-boss 10.x):
 *  - `retryLimit` / `retryDelay` / `retryBackoff`: bound how many times a failing job is
 *    retried before pg-boss gives up on it (default retryLimit is 0 — a job that always
 *    throws would otherwise keep failing and sitting around as 'failed' forever if nothing
 *    else expires it).
 *  - `deadLetter`: on exhausting retries, pg-boss moves the job's payload to the named
 *    dead-letter queue instead of leaving it in the original queue's failed state, so stale
 *    jobs stop being candidates the next `boss.work(...)` call has to look at.
 *  - `archiveCompletedAfterSeconds` (constructor/maintenance option): moves
 *    completed/failed/cancelled jobs out of the active `job` table into `archive` quickly.
 *  - `deleteAfterDays` (constructor/maintenance option): purges archived jobs so the table
 *    can't grow unbounded across many reruns of a long-lived instance like this one.
 */
const QUEUE_RETRY_OPTS = {
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: 60,
} as const;

export async function createQueue(connectionString: string): Promise<Boss> {
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    // Archive quickly and delete archived jobs after 1 day: bounds how long any job
    // (completed, failed, or dead-lettered) can sit in/near the active job table across
    // many bench reruns against this one persistent Postgres instance.
    archiveCompletedAfterSeconds: 60 * 10,
    deleteAfterDays: 1,
  });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();
  for (const q of QUEUES) {
    const dlq = `${q}-dlq`;
    // Dead-letter queue must exist before a queue can reference it in `deadLetter`.
    await boss.createQueue(dlq);
    await boss.createQueue(q, { name: q, ...QUEUE_RETRY_OPTS, deadLetter: dlq });
  }
  return boss;
}

export async function closeQueue(boss: Boss): Promise<void> {
  await boss.stop({ graceful: false, wait: false });
}
