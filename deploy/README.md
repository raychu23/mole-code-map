# Mole team server (T33) — deploy

What this gives a 10–100 person team that repo files alone can't: when an agent (or a
person) pushes code, the team server tells everyone who already shares this repo **which
decisions, tenets and past exceptions govern the lines that changed, who owns the answer if
there's a question, and whether anything the team agreed on got violated** — the same "the
decisions behind the code" center the rest of Mole (T29 decision graph, T30 annotated tree,
T37 plugin) serves inside one developer's editor, now serving a whole team from one shared
place. It is reachable over MCP so it shows up where the developer and their agents already
work (the same VS Code/Claude surfaces T34/T37 wire up), not as a separate dashboard to
remember to open.

## Pieces, and which established design each follows (full detail + sources/dates in
`../(internal reference removed) log/prior-art.md`)

| piece | follows |
|---|---|
| Webhook ingest (`src/webhook.ts`, `src/crypto.ts`) | GitHub's own webhook contract: HMAC-SHA256 verify over the raw body with a constant-time compare, ack within (well under) GitHub's 10s window, dedupe on `X-GitHub-Delivery` via a DB unique constraint — not an in-memory set, per GitHub's own docs. Dispatch shape (verify → route by event name → authenticated client) follows Probot's architecture. |
| Queue (`src/queue.ts`) | pg-boss: a Postgres-backed queue (`SELECT ... FOR UPDATE SKIP LOCKED`), so there's no Redis/broker to operate separately from the one database this server already needs. |
| Outbox (`src/outbox.ts`) | Chris Richardson's transactional-outbox pattern (microservices.io): every notification (a check-run result, a question route) is written to an `outbox` table in the SAME transaction as the state change that produced it, and a separate relay delivers it — so a crash between "decide to notify" and "actually notify" can never silently drop one. |
| Index rebuild from git (`src/rebuild.ts`) | Backstage's catalog ingestion model (ingest → process → stitch) combined with the "index is a rebuildable derived artifact of versioned source" principle from Sourcegraph/zoekt's design: git is always the source of truth; the Postgres index can be thrown away and rebuilt byte-identically from `.mole/` files in git history at any time (this is what M25's "index == rebuild from git" and the task's "missed deliveries → reconcile from git history" both measure). |
| Decision graph (`src/graph.ts`) | the recursive-CTE shape used to answer "what governs this file" across tenets → decisions → exceptions → code, per D31 ("center = decisions behind the code"); this is the same graph T29/T30/T37 already use, just served to a team instead of one editor. |
| Row-level security (`src/db.ts`) | Postgres RLS multi-tenancy (AWS's and thenile.dev's published pool-model guides): every tenant table carries `org_id`, the app connects as a non-owner `FORCE ROW LEVEL SECURITY` role (never the schema owner), and `SET LOCAL app.current_org_id` scopes every request's transaction — "an automated WHERE the app code can't forget," which is what the M25 permission-leak test (API and MCP) checks. |
| Remote MCP server (`src/mcpServer.ts`, `src/oauth.ts`) | the official MCP TypeScript SDK's streamable-HTTP transport plus `requireBearerAuth`, per the MCP 2025-06-18 authorization spec (OAuth 2.1 bearer tokens on HTTP transports). A local test issuer stands in for a real OAuth 2.1 authorization server (non-goal: no real OAuth provider in Mole code); the bearer token's org claim becomes the RLS scope for that MCP call, so a team's agent plugin (T37) gets the same leak protection a human API caller gets. |
| Observability (`src/telemetry.ts`) | OpenTelemetry's GenAI span-naming convention (`{operation} {target}`, e.g. `execute_tool governing_decisions`); every webhook ack, queue job and MCP call emits a span, exported in-memory for tests and via OTLP/HTTP to the collector below in a real deploy. |
| Eval runs (`src/mlflow.ts`) | MLflow's run/experiment tracking format (`mlruns/<experiment>/<run_id>/{meta.yaml,params/*,metrics/*}`); the M25 bench writes the same `runs.jsonl` shape every other Mole task uses AND an MLflow-format run per run, so the MLflow-format viewer already built for T16 reads T33's numbers without a second reader. |

## Running it

**Local dev / CI (what the tracking log checks actually run):** no Docker. A local Postgres via
`pg_ctl`/`initdb` in a temp dir (see `(internal reference removed) start.md` non-goals: never start
Docker Desktop, disk is tight). `npm run build -w @mole/server` then
`M25_DATABASE_URL=postgresql://... node packages/server/dist/bench/m25.js`.

**A real deploy** (this `deploy/` directory, not exercised by the tracking log checks):

```
cd deploy
docker compose up --build
```

- `postgres` — the index + outbox + RLS tables.
- `otel-collector` — receives OTLP/HTTP spans from the server, forwards to Jaeger.
- `jaeger` — trace viewer (http://localhost:16686).
- `mlflow` — run/experiment viewer (http://localhost:5000) over the same `mlruns/` the bench writes.
- `server` — the webhook + MCP server (webhook ingest on the HTTP port, MCP at `/mcp`). It writes decisions through
  `@mole/temporal` (schema applied at startup; `TEMPORAL_DATABASE_URL`, default `DATABASE_URL`) and checks the two stores
  agree after every rebuild. Env: `MOLE_WEBHOOK_SECRET`, `MOLE_ORG_REPO_DIRS` (JSON org → repo dir), and `MOLE_AUTH_SECRET`
  (signs the bearer tokens for `GET /reconcile/<org>`; a caller's token must name that org. Unset = the endpoint is closed,
  401. Set a long random value: `MOLE_AUTH_SECRET=$(openssl rand -hex 32) docker compose up`). `/health` returns 503 when
  the temporal store is unreachable. Known gap: compose starts `server` before Postgres is ready on a cold first boot;
  `docker compose start server` recovers.

No GitHub App, Slack workspace or real OAuth provider is registered by this deploy or by any
Mole code — those stay outside Mole's scope per the task's non-goals.
