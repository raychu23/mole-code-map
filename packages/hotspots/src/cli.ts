// `mole hotspots [--top N] [--since DATE] [--fix-rule RE] [--by hotspot|volatility|fixes] [--all]
// [--json]` (T70, D68): churn x indentation complexity (Tornhill/code-maat's hotspot method),
// ranked; decision volatility and incident/fix density reported as separate columns and optional
// sort keys (review-1 HIGH 1: never a gate on the score). Same JSON as the `mole_hotspots` MCP tool.
import { computeHotspots, formatHotspots, type HotspotSortKey } from './index.js';

const SORT_KEYS: HotspotSortKey[] = ['hotspot', 'volatility', 'fixes'];

export async function hotspotsCli(_pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const usage = 'usage: mole hotspots [--top N] [--since DATE] [--fix-rule RE] [--by hotspot|volatility|fixes] [--all] [--json] [--root DIR]';
  const top = typeof flags.top === 'string' ? Number(flags.top) : undefined;
  if (top !== undefined && (!Number.isFinite(top) || top < 1)) {
    console.error(usage);
    return 2;
  }
  const by = typeof flags.by === 'string' ? flags.by : undefined;
  if (by !== undefined && !SORT_KEYS.includes(by as HotspotSortKey)) {
    console.error(usage);
    return 2;
  }
  const r = await computeHotspots(root, {
    top,
    since: typeof flags.since === 'string' ? flags.since : undefined,
    fixRule: typeof flags['fix-rule'] === 'string' ? flags['fix-rule'] : undefined,
    by: by as HotspotSortKey | undefined,
    all: flags.all === true,
  });
  console.log(flags.json === true ? JSON.stringify(r, null, 2) : formatHotspots(r));
  return 0;
}
