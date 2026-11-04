// Library re-exports for internal consumers (bench/, test/) that want everything from one
// import. Nothing in this repo currently imports `@mole/server` as a package (bench/test
// files import individual src/*.js modules directly), so this is purely a convenience
// surface — it is NOT the Dockerfile/production entrypoint. See src/index.ts for that
// (review round 1 P1 #3: index.ts used to BE this re-export list, so `node dist/src/index.js`
// started nothing and exited immediately).
export { verifyGithubSignature } from './crypto.js';
export { createPool, closePool, runMigrations, withOrgTx, withOrgRead, type Pool } from './db.js';
export { createQueue, closeQueue, type Boss } from './queue.js';
export { createWebhookHandler } from './webhook.js';
export { writeOutboxInTx, relayOutboxOnce } from './outbox.js';
export { startFakeGithubApi } from './fakeGithub.js';
export { rebuildIndexFromGit, snapshotHash, parseMoleRecord, GitReadError } from './rebuild.js';
export { recordDecisionRevision, currentDecision, decisionAsOf, type DecisionRevision } from './decisionStore.js';
export { reconcileDecisions, type ReconcileResult } from './reconcile.js';
export { getGoverningDecisions } from './graph.js';
export { computeCheckRun } from './checkrun.js';
export { routeQuestion } from './questions.js';
export { createTestIssuer } from './oauth.js';
export { createMcpHttpServer } from './mcpServer.js';
export { initTelemetry, InMemorySpanExporter } from './telemetry.js';
export { appendRunsJsonl, writeMlflowRun } from './mlflow.js';
