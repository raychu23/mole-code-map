// `mole export --format okf [--out DIR]`: writes the decision graph as an OKF v0.2 bundle (T72). No daemon, no
// model -- same shape as decisionsCli in ../cli.ts. DIR defaults to .mole/export/okf.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadGraph } from '../graph.js';
import { buildOkfBundle } from './okf.js';

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export function exportCli(_pos: string[], flags: Record<string, string | true>, root: string): number {
  const format = str(flags.format);
  if (format !== 'okf') {
    console.error(`usage: mole export --format okf [--out DIR]${format ? ` (unsupported format: ${format})` : ''}`);
    return 2;
  }
  const out = str(flags.out) ? resolve(process.cwd(), str(flags.out)!) : resolve(root, '.mole', 'export', 'okf');
  const graph = loadGraph(root);
  const bundle = buildOkfBundle(graph, root);
  for (const file of bundle.files) {
    const abs = join(out, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, 'utf8');
  }
  console.log(`wrote OKF v0.2 bundle (${bundle.files.length} files) to ${out}`);
  return 0;
}
