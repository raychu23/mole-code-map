// `mole coupling [--top N] [--since DATE] [--min-revs N] [--min-shared-revs N] [--min-coupling PCT]
// [--max-coupling PCT] [--max-changeset-size N] [--all] [--json] [--root DIR]` (T77, D69). Same JSON
// as the `mole_coupling` MCP tool.
import { computeCoupling, formatCoupling } from './index.js';

export async function couplingCli(_pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const usage = 'usage: mole coupling [--top N] [--since DATE] [--min-revs N] [--min-shared-revs N] [--min-coupling PCT] [--max-coupling PCT] [--max-changeset-size N] [--all] [--json] [--root DIR]';
  const num = (v: string | true | undefined): number | undefined => (typeof v === 'string' ? Number(v) : undefined);
  const top = num(flags.top);
  if (top !== undefined && (!Number.isFinite(top) || top < 1)) {
    console.error(usage);
    return 2;
  }
  for (const key of ['min-revs', 'min-shared-revs', 'min-coupling', 'max-coupling', 'max-changeset-size']) {
    const v = num(flags[key]);
    if (v !== undefined && !Number.isFinite(v)) {
      console.error(usage);
      return 2;
    }
  }
  const r = await computeCoupling(root, {
    top,
    since: typeof flags.since === 'string' ? flags.since : undefined,
    minRevs: num(flags['min-revs']),
    minSharedRevs: num(flags['min-shared-revs']),
    minCoupling: num(flags['min-coupling']),
    maxCoupling: num(flags['max-coupling']),
    maxChangesetSize: num(flags['max-changeset-size']),
    all: flags.all === true,
  });
  console.log(flags.json === true ? JSON.stringify(r, null, 2) : formatCoupling(r));
  return 0;
}
