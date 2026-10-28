import { existsSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { neighborhood } from './query.js';
import { dbPath, lockPath, socketPath, stateDir } from './paths.js';
import { unavailable, type DaemonStatus, type RpcRequest, type RpcResponse } from './rpc.js';
import type { FromWorker, ToWorker, WorkerConfig } from './worker.js';

export interface DaemonOptions {
  root: string;
  tsconfig?: string;
  srcDir?: string;
  /** Override where the lock + graph live (default: git common dir). Required for read-only repos. */
  stateDir?: string;
  /** Watch the source tree and re-index changed files (default true). */
  watch?: boolean;
  /** Stop by itself after this long without any client request (0 or unset = never). The editor starts a new one on next use. */
  idleMs?: number;
  log?: (line: string) => void;
}

interface LockInfo {
  pid: number;
  socket: string;
  root: string;
  startedAt: number;
}

export class AlreadyRunning extends Error {
  constructor(readonly info: LockInfo) {
    super(`a mole daemon is already running for ${info.root} (pid ${info.pid})`);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function readLock(dir: string, root: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(lockPath(dir, root), 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/** `./src/a.ts`, `src\\a.ts` and absolute paths inside the repo all mean `src/a.ts`; bare symbol names pass through. */
export function normalizeTarget(root: string, target: string): string {
  let t = target.trim().replace(/\\/g, '/');
  const hash = t.indexOf('#');
  let path = hash < 0 ? t : t.slice(0, hash);
  const sym = hash < 0 ? '' : t.slice(hash);
  if (isAbsolute(path)) {
    const rel = relative(root, path).split(sep).join('/');
    if (rel && !rel.startsWith('..')) path = rel;
  }
  path = path.replace(/^(?:\.\/)+/, '');
  t = path + sym;
  return t;
}

/**
 * Worker file: dist/worker.js next to this module, worker.cjs next to a bundled daemon (the VS Code extension ships
 * dist/daemon.cjs + dist/worker.cjs), or (under vitest, which runs the .ts sources) the built copy.
 */
function workerFile(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) return join(dirname(here), '../dist/worker.js');
  return [join(dirname(here), 'worker.js'), join(dirname(here), 'worker.cjs')].find((f) => existsSync(f)) ?? join(dirname(here), 'worker.js');
}

/**
 * One process per repo. The only writer of the SQLite graph (through a worker thread); answers `map` / `impact` from a
 * read-only connection. Fails open: a crashed index or a missing file becomes a state in the answer, never an exception
 * the client has to handle.
 */
export class Daemon {
  readonly root: string;
  readonly dir: string;
  readonly socket: string;
  private server?: Server;
  private worker?: Worker;
  private db?: DatabaseSync;
  private watchers: FSWatcher[] = [];
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private lastRequest = Date.now();
  /** a worker job (full index or file update) is running: never idle, however long it takes */
  private working = false;
  private status: DaemonStatus;
  private readonly log: (l: string) => void;
  private stopped?: () => void;
  readonly closed: Promise<void>;

  constructor(private readonly opts: DaemonOptions) {
    this.root = resolve(opts.root);
    this.dir = stateDir(this.root, opts.stateDir);
    this.socket = socketPath(this.root, this.dir);
    this.log = opts.log ?? (() => undefined);
    this.status = { state: 'starting', root: this.root, pid: process.pid, files: 0, partialFiles: 0, nodes: 0, edges: 0 };
    this.closed = new Promise((r) => (this.stopped = r));
  }

  /** Take the lock (failing if a live daemon owns it), start the writer, listen. Resolves once the socket accepts. */
  async start(): Promise<void> {
    const prev = readLock(this.dir, this.root);
    if (prev && alive(prev.pid)) throw new AlreadyRunning(prev);
    rmSync(lockPath(this.dir, this.root), { force: true });
    // the lock is taken BEFORE the socket is touched: a loser of the race must never unlink a live daemon's socket
    try {
      writeFileSync(lockPath(this.dir, this.root), JSON.stringify({ pid: process.pid, socket: this.socket, root: this.root, startedAt: Date.now() } satisfies LockInfo), { flag: 'wx' });
    } catch (e) {
      const other = readLock(this.dir, this.root);
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && other) throw new AlreadyRunning(other);
      throw e;
    }
    if (process.platform !== 'win32') rmSync(this.socket, { force: true });

    await new Promise<void>((ok, fail) => {
      this.server = createServer((s) => this.onClient(s));
      this.server.once('error', fail);
      this.server.listen(this.socket, ok);
    });
    this.spawnWorker();
    this.send({ type: 'indexAll' });
    if (this.opts.watch !== false) this.startWatching();
    this.startIdleWatch();
    this.log(`listening on ${this.socket}`);
  }

  private stopping?: Promise<void>;

  /** Idempotent: an idle stop followed by a shutdown request or a test cleanup must not close the database twice. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.timer);
    clearInterval(this.idleTimer);
    this.server?.close();
    await this.worker?.terminate();
    this.db?.close();
    rmSync(lockPath(this.dir, this.root), { force: true });
    if (process.platform !== 'win32') rmSync(this.socket, { force: true });
    this.stopped?.();
  }

  // ---- writer ---------------------------------------------------------------------------------

  private spawnWorker(): void {
    const cfg: WorkerConfig = { root: this.root, dbPath: dbPath(this.dir, this.root), tsconfig: this.opts.tsconfig, srcDir: this.opts.srcDir };
    const w = new Worker(workerFile(), { workerData: cfg, execArgv: [], env: process.env });
    this.worker = w;
    w.on('message', (m: FromWorker) => this.onWorker(m));
    w.on('error', (e) => this.fail(`index worker crashed: ${e.message}`));
    w.on('exit', (code) => {
      if (code !== 0 && this.worker === w) this.fail(`index worker exited with code ${code}`);
    });
  }

  private send(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  private fail(message: string): void {
    this.status = { ...this.status, state: 'error', lastError: message };
    this.log(message);
  }

  private onWorker(m: FromWorker): void {
    if (m.type === 'ready') {
      this.openReader();
    } else if (m.type === 'indexing') {
      this.working = true;
      if (this.status.state !== 'ready') this.status = { ...this.status, state: 'indexing' };
    } else if (m.type === 'done') {
      this.working = false;
      this.lastRequest = Date.now();
      this.status = { ...this.status, state: 'ready', commit: m.commit, files: m.stats.files, partialFiles: m.stats.partialFiles, nodes: m.stats.nodes, edges: m.stats.edges, indexedAt: Date.now(), lastError: undefined };
      this.log(`${m.full ? 'full index' : 'update'} ${m.ms.toFixed(0)} ms: ${m.stats.files} files, ${m.stats.nodes} nodes, ${m.stats.edges} edges`);
    } else {
      this.fail(m.message);
    }
  }

  private openReader(): void {
    try {
      this.db?.close();
      this.db = new DatabaseSync(dbPath(this.dir, this.root), { readOnly: true });
    } catch (e) {
      this.fail(`cannot open graph: ${(e as Error).message}`);
    }
  }

  private startWatching(): void {
    const base = resolve(this.root, this.opts.srcDir ?? 'src');
    if (!existsSync(base)) return;
    // editing counts as use: a person typing in one file for an hour must not lose the map

    try {
      this.watchers.push(
        watch(base, { recursive: true }, (_ev, file) => {
          if (!file || !/\.(?:ts|tsx|mts|cts)$/.test(file) || file.includes('node_modules')) return;
          this.lastRequest = Date.now();
          this.pending.add(relative(this.root, join(base, file)).split(sep).join('/'));
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.flush(), 200);
        }),
      );
    } catch (e) {
      this.log(`watch failed (continuing without live updates): ${(e as Error).message}`);
    }
  }

  private flush(): void {
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length) this.send({ type: 'update', paths });
  }

  // ---- reads ----------------------------------------------------------------------------------

  private query(method: 'map' | 'impact', target: string) {
    if (this.status.state === 'error' && !this.db) return unavailable(this.status.lastError ?? 'index failed');
    if (!this.db) return unavailable('indexing the repository…', 'indexing');
    try {
      const n = neighborhood(this.db, target, { impact: method === 'impact' });
      if (n.state === 'not-indexed' && this.status.state === 'indexing' && this.status.nodes === 0) return unavailable('indexing the repository…', 'indexing');
      return n;
    } catch (e) {
      return unavailable(`query failed: ${(e as Error).message}`);
    }
  }

  private handle(req: RpcRequest): RpcResponse {
    const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: req.id, result });
    const p = req.params ?? {};
    switch (req.method) {
      case 'ping':
        return ok('pong');
      case 'status':
        return ok(this.status);
      case 'map':
      case 'impact': {
        const target = normalizeTarget(this.root, String(p.path ?? p.symbol ?? p.target ?? ''));
        return ok(target ? this.query(req.method, target) : unavailable('missing path or symbol', 'not-indexed'));
      }
      case 'reindex':
        this.send({ type: 'indexAll' });
        return ok(true);
      case 'update': {
        for (const x of (p.paths as string[] | undefined) ?? []) this.pending.add(x);
        this.flush();
        return ok(true);
      }
      case 'shutdown':
        setImmediate(() => void this.stop());
        return ok(true);
      default:
        return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } };
    }
  }

  /** Idle shutdown: a background process nobody asked for must not outlive its editor forever. Indexing never counts as idle. */
  private startIdleWatch(): void {
    const idle = this.opts.idleMs ?? 0;
    if (idle <= 0) return;
    this.idleTimer = setInterval(() => {
      if (this.working || this.status.state === 'indexing' || this.status.state === 'starting') return;
      if (Date.now() - this.lastRequest < idle) return;
      this.log(`idle for ${Math.round(idle / 1000)} s: stopping`);
      void this.stop();
    }, Math.max(50, Math.min(30_000, Math.floor(idle / 4))));
    this.idleTimer.unref();
  }

  private onClient(s: Socket): void {
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        this.lastRequest = Date.now();
        let res: RpcResponse;
        try {
          res = this.handle(JSON.parse(line) as RpcRequest);
        } catch (e) {
          res = { jsonrpc: '2.0', id: null, error: { code: -32700, message: (e as Error).message } };
        }
        s.write(`${JSON.stringify(res)}\n`);
      }
    });
    s.on('error', () => undefined);
  }
}
