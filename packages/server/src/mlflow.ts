// MLflow run format (R0 prior-art.md §10): runs.jsonl (R4 evidence) + an mlruns/-shaped
// directory per run, so the same MLflow-format viewer built for T16 can read T33's runs.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function appendRunsJsonl(filePath: string, line: object): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(line) + '\n');
}

export interface MlflowRunInput {
  experiment: string;
  params: Record<string, string>;
  metrics: Record<string, number>;
}

/** Writes `<dir>/<experiment>/<run_id>/{meta.yaml,params/*,metrics/*}` per MLflow's tracking.rst layout. */
export function writeMlflowRun(dir: string, run: MlflowRunInput): string {
  const runId = crypto.randomUUID();
  const runDir = path.join(dir, run.experiment, runId);
  mkdirSync(path.join(runDir, 'params'), { recursive: true });
  mkdirSync(path.join(runDir, 'metrics'), { recursive: true });
  writeFileSync(
    path.join(runDir, 'meta.yaml'),
    `run_id: ${runId}\nexperiment_id: "${run.experiment}"\nstart_time: ${Date.now()}\nstatus: FINISHED\n`
  );
  for (const [k, v] of Object.entries(run.params)) {
    writeFileSync(path.join(runDir, 'params', k), v);
  }
  const ts = Date.now();
  for (const [k, v] of Object.entries(run.metrics)) {
    writeFileSync(path.join(runDir, 'metrics', k), `${ts} ${v} 0\n`);
  }
  return runId;
}
