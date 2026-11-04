// Webhook ingest (R0 prior-art.md §1 GitHub docs + §2 Probot): verify -> dedupe -> enqueue,
// ack fast, nothing slow on the request path (the queue drains rebuild/check-run jobs).
// Dedupe is enforced by a DB unique constraint (R0 §1: not an in-memory set), and downstream
// jobs are themselves idempotent (deterministic index replace + a unique outbox row per
// (org, kind, ref)), so even a best-effort at-least-once enqueue after commit cannot produce
// a duplicate *effect* (M25's bar), only possibly a duplicate *attempt* that collapses.
import { verifyGithubSignature } from './crypto.js';
import type { Pool } from './db.js';
import type { Boss } from './queue.js';

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  body: { status: string; [k: string]: unknown };
}

export interface WebhookTelemetry {
  withSpan<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
}

export interface WebhookHandlerOptions {
  secret: string;
  pool: Pool;
  boss: Boss;
  /** org id -> local git repo dir standing in for "the repo GitHub would push from" */
  orgRepoDirs: Record<string, string>;
  /** review round 1 P1 #5: webhook.ts had zero telemetry calls on the request path (only the
   * job side, rebuild.ts/checkrun.ts, emitted spans). Optional so unit tests that don't care
   * about tracing can omit it. */
  telemetry?: WebhookTelemetry;
}

export function createWebhookHandler(opts: WebhookHandlerOptions) {
  return async function handle(req: WebhookRequest): Promise<WebhookResponse> {
    const run = async (): Promise<WebhookResponse> => {
      const sig = req.headers['x-hub-signature-256'];
      const deliveryId = req.headers['x-github-delivery'];
      const event = req.headers['x-github-event'] ?? 'unknown';

      if (!verifyGithubSignature(opts.secret, req.rawBody, sig)) {
        return { status: 401, body: { status: 'bad-signature' } };
      }
      if (!deliveryId) {
        return { status: 400, body: { status: 'missing-delivery-id' } };
      }

      let payload: any;
      try {
        payload = JSON.parse(req.rawBody);
      } catch {
        return { status: 400, body: { status: 'bad-json' } };
      }
      const orgLogin: string | undefined = payload?.repository?.owner?.login;
      // Review round 1 P1 #4: an unrecognized repo owner used to silently fall back to
      // Object.keys(opts.orgRepoDirs)[0] — a real cross-org mis-attribution risk (a push from
      // an org we don't know about would get recorded/queued under a DIFFERENT, arbitrary
      // org's id). Reject instead; never guess which org a delivery belongs to.
      if (!orgLogin || !opts.orgRepoDirs[orgLogin]) {
        return { status: 404, body: { status: 'unknown-org', orgLogin: orgLogin ?? null } };
      }
      const orgId = orgLogin;
      const commitSha: string | undefined = payload?.after;
      // T45 P1: GitHub push events carry `before` (the ref's tip immediately before this push)
      // — the correct prCheck base for a multi-commit push. Thread it through to the
      // compute-check-run job instead of discarding it here; checkrun.ts validates it
      // (present, not all-zero, an ancestor of `ref`) before trusting it as a base.
      const commitBefore: string | undefined = payload?.before;

      const client = await opts.pool.connect();
      let isNew = false;
      try {
        // dedupe on X-GitHub-Delivery via a unique-key insert: the DB enforces it, not an
        // in-memory set, so dedupe survives a restart and works across instances.
        const ins = await client.query(
          `insert into deliveries(delivery_id, org_id, event, commit_sha) values ($1,$2,$3,$4)
           on conflict (delivery_id) do nothing returning delivery_id`,
          [deliveryId, orgId, event, commitSha ?? null]
        );
        isNew = ins.rowCount === 1;
      } finally {
        client.release();
      }

      if (isNew && commitSha) {
        await opts.boss.send('rebuild-index', { orgId, ref: commitSha });
        await opts.boss.send('compute-check-run', { orgId, ref: commitSha, before: commitBefore });
        return { status: 202, body: { status: 'queued' } };
      }
      return { status: 202, body: { status: isNew ? 'queued' : 'duplicate' } };
    };

    if (opts.telemetry) {
      return opts.telemetry.withSpan(
        'webhook.request',
        { 'mole.delivery_id': req.headers['x-github-delivery'] ?? null, 'mole.event': req.headers['x-github-event'] ?? 'unknown' },
        run
      );
    }
    return run();
  };
}
