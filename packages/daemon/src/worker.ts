// The single writer. Runs in a worker thread so a multi-second index never blocks the daemon's query socket.
import { parentPort, workerData } from 'node:worker_threads';
import { TsIndexer, type IndexStats } from '@mole/indexer';
import { ensureQueryIndexes } from './query.js';

export interface WorkerConfig {
  root: string;
  dbPath: string;
  tsconfig?: string;
  srcDir?: string;
  commit?: string;
}
export type ToWorker = { type: 'indexAll' } | { type: 'update'; paths: string[] };
export type FromWorker =
  | { type: 'ready' }
  | { type: 'indexing' }
  | { type: 'done'; stats: IndexStats; commit: string; full: boolean; ms: number }
  | { type: 'error'; message: string };

const cfg = workerData as WorkerConfig;
const port = parentPort;
if (!port) throw new Error('worker.ts must run as a worker thread');
const post = (m: FromWorker): void => port.postMessage(m);

try {
  const ix = new TsIndexer({ root: cfg.root, dbPath: cfg.dbPath, tsconfig: cfg.tsconfig, srcDir: cfg.srcDir, commit: cfg.commit });
  ensureQueryIndexes(ix.db);
  post({ type: 'ready' });
  const stamp = (): void => {
    ix.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexedAt', ?)").run(String(Date.now()));
  };
  port.on('message', (m: ToWorker) => {
    const t0 = performance.now();
    try {
      post({ type: 'indexing' });
      if (m.type === 'indexAll') {
        const stats = ix.indexAll();
        stamp();
        post({ type: 'done', stats, commit: ix.commit, full: true, ms: performance.now() - t0 });
      } else {
        let stats: IndexStats | undefined;
        for (const p of m.paths) stats = ix.updateFile(p);
        stamp();
        if (stats) post({ type: 'done', stats, commit: ix.commit, full: false, ms: performance.now() - t0 });
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  });
} catch (e) {
  post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
}
