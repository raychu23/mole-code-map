// `mole arguments capture|approve|reject|list` (T80): CLI surface for captured arguments. No daemon
// needed (same shape as `mole compile` / `mole rules`). MCP stays read-only (contract) -- approval is a
// CLI-only act, same as T46's compile approve.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureAdrArguments, type CapturedArgument } from './arguments.js';
import { allCapturedArguments, approveCapturedArgument, CapturedArgumentError, listCapturedArguments, rejectCapturedArgument, saveCapturedArguments } from './captured-store.js';
import { loadGraph } from '../graph.js';

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function formatRow(d: CapturedArgument): string {
  const targets: string[] = [];
  for (const n of d.attacksNames ?? []) targets.push(`attacks:${n}`);
  for (const n of d.supportsNames ?? []) targets.push(`supports:${n}`);
  const targetStr = targets.length ? ` [${targets.join(', ')}]` : '';
  // review 3: flag a stale (history-only, never a graph node/edge) or ambiguous-target row right in the
  // listing -- a person deciding whether to approve/reject needs to see this BEFORE acting, not discover
  // it only when approve/reject refuses the call.
  const flags: string[] = [];
  if (d.stale) flags.push('STALE');
  if (d.ambiguousTarget) flags.push('AMBIGUOUS-TARGET');
  const flagStr = flags.length ? ` <${flags.join(',')}>` : '';
  const base = `${d.decisionId} ${d.id} [${d.status}]${flagStr} ${d.role} ${d.span.file}:${d.span.startLine}${targetStr} "${d.text.length > 60 ? `${d.text.slice(0, 57)}...` : d.text}"`;
  const withAmbiguous = d.ambiguousTarget ? `${base}\n    PROBLEM: ${d.ambiguousTarget}` : base;
  if (d.status === 'approved') return `${withAmbiguous} (approved by ${d.approvedBy} at ${d.approvedAt})`;
  if (d.status === 'rejected') return `${withAmbiguous} (rejected: ${d.rejectedReason})`;
  return withAmbiguous;
}

/** CLI entry used by packages/daemon/src/cli.ts: `mole arguments <capture|approve|reject|list> --id ID ...` */
export async function argumentsCli(pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const sub = pos[0];
  const recordsRoot = str(flags.records) ? resolve(str(flags.records)!) : root;
  const id = str(flags.id);
  if (sub === 'capture') {
    if (!id) {
      console.error('usage: mole arguments capture --id ID [--from FILE] [--records DIR] [--json]');
      return 2;
    }
    const graph = loadGraph(recordsRoot);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) {
      console.error(`mole arguments capture: no decision ${id} in ${recordsRoot}`);
      return 2;
    }
    const from = str(flags.from);
    const adrText = from ? readFileSync(resolve(from), 'utf8') : readFileSync(resolve(recordsRoot, node.file), 'utf8');
    const fresh = captureAdrArguments(id, node.file, adrText);
    const saved = await saveCapturedArguments(recordsRoot, id, fresh);
    // review 3 HIGH 1: a capture problem (two considered options whose names normalize equal) is reported
    // loudly here, once per distinct colliding pair -- never silently buried in the per-row listing only.
    const problems = Array.from(new Set(saved.filter((r) => r.ambiguousTarget).map((r) => r.ambiguousTarget!)));
    for (const p of problems) console.error(`mole arguments capture: PROBLEM: ${id}: ${p}`);
    console.log(flags.json ? JSON.stringify(saved, null, 2) : saved.map(formatRow).join('\n') || `mole arguments capture: no arguments found in ${node.file}`);
    return 0;
  }
  if (sub === 'approve' || sub === 'reject') {
    const argumentId = str(flags.argument);
    if (!id || !argumentId) {
      console.error(`usage: mole arguments ${sub} --id ID --argument ARGUMENT_ID ${sub === 'approve' ? '--approver NAME' : '--reason TEXT'}`);
      return 2;
    }
    try {
      if (sub === 'approve') {
        const approver = str(flags.approver);
        if (!approver) {
          console.error('mole arguments approve: --approver NAME is required');
          return 2;
        }
        const row = await approveCapturedArgument(recordsRoot, id, argumentId, approver);
        console.log(flags.json ? JSON.stringify(row, null, 2) : `approved ${formatRow(row)}`);
      } else {
        const reason = str(flags.reason);
        if (!reason) {
          console.error('mole arguments reject: --reason TEXT is required');
          return 2;
        }
        const row = await rejectCapturedArgument(recordsRoot, id, argumentId, reason);
        console.log(flags.json ? JSON.stringify(row, null, 2) : formatRow(row));
      }
    } catch (e) {
      console.error(`mole arguments ${sub}: ${(e as CapturedArgumentError).message}`);
      return 2;
    }
    return 0;
  }
  if (sub === 'list') {
    if (id) {
      const rows = listCapturedArguments(recordsRoot, id);
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length) console.log(`mole arguments: ${id} has no captured arguments (run \`mole arguments capture --id ${id}\` first)`);
      else for (const r of rows) console.log(formatRow(r));
      return 0;
    }
    const all = allCapturedArguments(recordsRoot);
    if (flags.json) {
      console.log(JSON.stringify(all, null, 2));
      return 0;
    }
    const ids = Object.keys(all).sort();
    if (!ids.length) console.log('mole arguments: no captured arguments (run `mole arguments capture --id ID` first)');
    for (const i of ids) for (const r of all[i]!) console.log(formatRow(r));
    return 0;
  }
  console.error('usage: mole arguments <capture|approve|reject|list> --id ID ...');
  return 2;
}
