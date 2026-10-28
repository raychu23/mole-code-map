import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './server.js';
import { socketPath, stateDir } from './paths.js';
import { unavailable, type DaemonStatus, type MapResult, type RpcResponse } from './rpc.js';

export interface ClientOptions {
  root: string;
  stateDir?: string;
  /** Per-call timeout in ms (default 3000). A timeout becomes an `index-unavailable` map, not an exception. */
  timeoutMs?: number;
}

/** One-connection-per-call JSON-RPC client. Cheap on a local socket; no state to go stale if the daemon restarts. */
export class MoleClient {
  readonly dir: string;
  constructor(private readonly opts: ClientOptions) {
    this.dir = stateDir(opts.root, opts.stateDir);
  }

  private path(): string {
    return readLock(this.dir, this.opts.root)?.socket ?? socketPath(this.opts.root, this.dir);
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((ok, fail) => {
      const s: Socket = connect(this.path());
      let buf = '';
      const timer = setTimeout(() => {
        s.destroy();
        fail(new Error(`daemon timeout on ${method}`));
      }, this.opts.timeoutMs ?? 3000);
      s.setEncoding('utf8');
      s.on('connect', () => s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`));
      s.on('data', (c: string) => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        clearTimeout(timer);
        s.end();
        const res = JSON.parse(buf.slice(0, i)) as RpcResponse;
        res.error ? fail(new Error(res.error.message)) : ok(res.result as T);
      });
      s.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
    });
  }

  /** map / impact never throw: a down daemon is the `index-unavailable` state the UI shows. */
  async map(target: string, impact = false): Promise<MapResult> {
    try {
      return await this.call<MapResult>(impact ? 'impact' : 'map', { path: target });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const why = code === 'ENOENT' || code === 'ECONNREFUSED' ? 'the Mole daemon is not running' : (e as Error).message;
      return unavailable(`daemon not reachable: ${why}`);
    }
  }

  status(): Promise<DaemonStatus> {
    return this.call<DaemonStatus>('status');
  }

  async running(): Promise<boolean> {
    try {
      return (await this.call<string>('ping')) === 'pong';
    } catch {
      return false;
    }
  }
}

export interface EnsureOptions extends ClientOptions {
  tsconfig?: string;
  srcDir?: string;
  /** Node binary + flags to run the daemon with (VS Code: process.execPath with ELECTRON_RUN_AS_NODE=1). */
  nodePath?: string;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
  /** The daemon stops itself after this many idle minutes (default 30, 0 = never). */
  idleMinutes?: number;
}

function defaultCli(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith('daemon.cjs') ? here : join(dirname(here), 'cli.js');
}

/** Start a detached daemon for the repo unless one answers. Returns a client; never throws on spawn failure. */
export async function ensureDaemon(opts: EnsureOptions): Promise<MoleClient> {
  const client = new MoleClient(opts);
  if (await client.running()) return client;
  // next to this module (dist/cli.js), or this very file when it is the bundled daemon.cjs the VS Code extension ships
  const cli = opts.cliPath ?? defaultCli();
  const args = [cli, 'daemon', '--root', opts.root];
  if (opts.stateDir) args.push('--state-dir', opts.stateDir);
  if (opts.tsconfig) args.push('--tsconfig', opts.tsconfig);
  if (opts.srcDir) args.push('--src-dir', opts.srcDir);
  if (opts.idleMinutes !== undefined) args.push('--idle-minutes', String(opts.idleMinutes));
  try {
    const child = spawn(opts.nodePath ?? process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...opts.env } });
    child.unref();
  } catch {
    return client;
  }
  const deadline = Date.now() + (opts.waitMs ?? 8000);
  while (Date.now() < deadline) {
    if (await client.running()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return client;
}
