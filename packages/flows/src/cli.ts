// `mole flows record [test files...] [--out DIR] [--plain]` and `mole flows <file#Symbol> [--out DIR] [--json]` (T28).
import { join, resolve } from 'node:path';
import { recordFlows } from './record.js';
import { flowsFor, formatFlows, loadFlows } from './store.js';

const USAGE =
  'usage: mole flows record [test files...] [--root DIR] [--out DIR] [--plain]   run vitest instrumented, store per-test flows (.mole/local/flows)\n' +
  '       mole flows <file#Symbol | Symbol | file> [--root DIR] [--out DIR] [--json]   tests + call paths that ran it, its runtime callers/callees';

export async function flowsCli(pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const out = typeof flags.out === 'string' ? resolve(flags.out) : join(root, '.mole/local/flows');
  const [first, ...rest] = pos;
  if (!first || flags.help) {
    console.error(USAGE);
    return flags.help ? 0 : 2;
  }
  if (first === 'record') {
    const r = await recordFlows({ root, files: rest, out, instrument: !flags.plain });
    const store = loadFlows(out);
    const edges = new Set(store.tests.flatMap((t) => t.edges.map(([a, b]) => `${a}\t${b}`)));
    console.log(`recorded ${r.flows} test flow${r.flows === 1 ? '' : 's'} (${edges.size} distinct call edges) in ${(r.wallMs / 1000).toFixed(1)} s -> ${out}`);
    console.log(`vitest: ${r.tests.passed} passed, ${r.tests.failed} failed, exit ${r.exit} (log: ${join(out, 'vitest.log')})`);
    return r.exit;
  }
  const store = loadFlows(out);
  if (!store.tests.length) {
    console.error(`mole flows: nothing recorded in ${out}; run \`mole flows record\` first`);
    return 1;
  }
  const r = flowsFor(store, first);
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatFlows(r, store.meta));
  return 0;
}
