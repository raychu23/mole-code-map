#!/usr/bin/env node
// mole daemon | map | impact | status | stop | reindex  — thin CLI over the daemon (offerings F1.9).
import { defaultSources } from './detect.js';
import { resolve } from 'node:path';
import { formatNeighborhood } from '@mole/core';
import { ensureDaemon, MoleClient } from './client.js';
import { Daemon } from './server.js';

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

async function main(): Promise<number> {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  const root = resolve(str(flags.root) ?? process.cwd());
  const stateDir = str(flags['state-dir']);
  const common = { root, stateDir, ...defaultSources(root, str(flags.tsconfig), str(flags['src-dir'])) };

  if (cmd === 'daemon') {
    // a background process nobody asked for must not outlive its editor: stop after 30 idle minutes (0 = never)
    const idleMinutes = Number(str(flags['idle-minutes']) ?? 30);
    const d = new Daemon({ ...common, idleMs: Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60_000 : 0, log: (l) => console.error(`[mole] ${l}`) });
    await d.start();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void d.stop());
    await d.closed;
    return 0;
  }
  if (cmd === 'map' || cmd === 'impact') {
    const target = pos[0];
    if (!target) {
      console.error(`usage: mole ${cmd} <path | path#Symbol | symbol> [--root DIR]`);
      return 2;
    }
    const client = flags['no-start'] ? new MoleClient({ root, stateDir }) : await ensureDaemon(common);
    let n = await client.map(target, cmd === 'impact');
    for (let i = 0; i < 100 && n.state === 'indexing'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      n = await client.map(target, cmd === 'impact');
    }
    console.log(flags.json ? JSON.stringify(n, null, 2) : formatNeighborhood(n));
    return n.state === 'ok' ? 0 : 1;
  }
  const client = new MoleClient({ root, stateDir });
  if (cmd === 'status') {
    try {
      console.log(JSON.stringify(await client.status(), null, 2));
      return 0;
    } catch {
      console.log('mole: daemon not running');
      return 1;
    }
  }
  if (cmd === 'stop' || cmd === 'reindex') {
    try {
      await client.call(cmd === 'stop' ? 'shutdown' : 'reindex');
      return 0;
    } catch {
      console.log('mole: daemon not running');
      return 1;
    }
  }
  console.error('usage: mole <daemon|map|impact|status|reindex|stop> [target] [--root DIR] [--state-dir DIR] [--tsconfig F] [--src-dir D] [--idle-minutes N] [--json]');
  return cmd === 'help' ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`mole: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
