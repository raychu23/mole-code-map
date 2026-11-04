// `mole decisions [--json] [--root DIR] [--adr-dir DIR[,DIR]] [--test-report FILE]`: every decision and tenet with its flag,
// reasons and file:line. No daemon, no model.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeFlags } from './flags.js';
import { loadGraph } from './graph.js';
import { formatSections, sectionsOf } from './rationale.js';
import type { DecisionsResult, FlagContext, FlagResult, LoadOptions } from './types.js';
import { CaptureError, linkDecisions, newDecision, readDecisionRecords, recoverTransactions, supersedeDecision } from './capture/records.js';
import { suggestDuplicates } from './capture/dedupe.js';
import { comparePhases, compareWithOrder, evaluatePhase, PrioritiesError, readPriorities, setPriorities } from './priorities.js';
import { acceptIncident, dismissIncident, IncidentError, incidentSummary, suggestRevivals } from './incidents/revive.js';
import { recallSimilar, RecallError } from './recall/recall.js';

/** The JSON `mole decisions --json` prints and the MCP tool mole_decisions returns. Every decision/tenet
 * node (T43) gets its full rationale text attached (bounded, section-aware -- see rationale.ts), read
 * straight from the record's own file so this works the same for .mole/decisions/*.md records and plain
 * ADR-folder records (graph.ts loadAdrDir) alike: both already carry a file:line, and neither needed a
 * new on-disk copy of the text to get this -- it was always right there, just never read past the title. */
export function decisions(root: string, opts: LoadOptions & FlagContext = {}): DecisionsResult {
  const graph = loadGraph(root, { adrDirs: opts.adrDirs });
  const flagged = computeFlags(graph, { testReport: opts.testReport });
  const fileOf = new Map(graph.nodes.map((n) => [n.id, n.file]));
  const withRationale: FlagResult[] = flagged.map((d) => {
    const file = fileOf.get(d.id);
    if (!file) return d;
    let text: string | undefined;
    try {
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      text = undefined;
    }
    if (text === undefined) return d;
    const rationale = formatSections(sectionsOf(text));
    return rationale ? { ...d, rationale } : d;
  });
  return { root, decisions: withRationale, problems: graph.problems };
}

export function formatDecisions(r: DecisionsResult): string {
  const out: string[] = [];
  if (r.decisions.length === 0) out.push('mole: no decisions (.mole/tenets.md, .mole/decisions/*.md, or pass --adr-dir DIR)');
  const w = Math.max(4, ...r.decisions.map((d) => d.id.length));
  for (const d of r.decisions) {
    out.push(`${d.flag.padEnd(6)} ${d.id.padEnd(w)}  ${d.title.length > 70 ? `${d.title.slice(0, 67)}...` : d.title}  ${d.file}:${d.line}`);
    for (const x of d.reasons) out.push(`${' '.repeat(9 + w)}${x.flag} ${x.code}: ${x.text}  ${x.file}:${x.line}`);
  }
  for (const p of r.problems) out.push(`problem ${p.file}:${p.line}: ${p.message}`);
  const count = (f: FlagResult['flag']) => r.decisions.filter((d) => d.flag === f).length;
  out.push(`${r.decisions.length} records: ${count('red')} red, ${count('yellow')} yellow, ${count('green')} green, ${count('grey')} grey`);
  return out.join('\n');
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** CLI entry used by packages/daemon/src/cli.ts. */
export function decisionsCli(_pos: string[], flags: Record<string, string | true>, root: string): number {
  const adr = str(flags['adr-dir']);
  const report = str(flags['test-report']);
  const r = decisions(root, {
    adrDirs: adr ? adr.split(',').map((s) => s.trim()).filter(Boolean) : [],
    testReport: report ? resolve(process.cwd(), report) : undefined,
  });
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatDecisions(r));
  return 0;
}

/** Write-side decision-record CLI. Kept separate from `decisionsCli` so existing read-only output is unchanged. */
export function decisionCli(pos: string[], flags: Record<string, string | true>, root: string): number {
  const [sub] = pos;
  if (sub === 'recover') {
    try {
      console.log(`recovered ${recoverTransactions(root)} transaction(s)`);
      return 0;
    } catch (error) {
      console.error(`mole decision recover: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  if (sub === 'supersede') {
    const oldId = str(flags.old);
    const newId = str(flags.new);
    if (!oldId || !newId) {
      console.error('usage: mole decision supersede --old ID --new ID');
      return 2;
    }
    try {
      supersedeDecision(root, oldId, newId);
      console.log(`superseded ${oldId} with ${newId}`);
      return 0;
    } catch (error) {
      console.error(`mole decision supersede: ${error instanceof Error ? error.message : String(error)}`);
      return error instanceof CaptureError ? 2 : 1;
    }
  }
  if (sub === 'link') {
    const from = str(flags.from);
    const to = str(flags.to);
    const relation = str(flags.relation);
    if (!from || !to || !relation) {
      console.error('usage: mole decision link --from ID --to ID --relation amends|overrides');
      return 2;
    }
    try {
      linkDecisions(root, from, to, relation);
      console.log(`linked ${from} ${relation} ${to}`);
      return 0;
    } catch (error) {
      console.error(`mole decision link: ${error instanceof Error ? error.message : String(error)}`);
      return error instanceof CaptureError ? 2 : 1;
    }
  }
  if (sub === 'suggest') {
    // read-only: which existing records look like this incoming one (exact, then near); never writes or merges
    const id = str(flags.id);
    const title = str(flags.title);
    if (!id || !title) {
      console.error('usage: mole decision suggest --id ID --title TITLE [--body TEXT]');
      return 2;
    }
    try {
      const suggestions = suggestDuplicates({ id, title, body: str(flags.body) ?? '' }, readDecisionRecords(root));
      console.log(JSON.stringify({ id, suggestions }, null, 2));
      return 0;
    } catch (error) {
      console.error(`mole decision suggest: ${error instanceof Error ? error.message : String(error)}`);
      return error instanceof CaptureError ? 2 : 1;
    }
  }
  if (sub !== 'new') {
    console.error('usage: mole decision <new|supersede|link|suggest|recover> ...');
    return 2;
  }
  const id = str(flags.id);
  const title = str(flags.title);
  const status = str(flags.status);
  const body = str(flags.body);
  if (!id || !title) {
    console.error('usage: mole decision new --id ID --title TITLE [--status proposed|accepted] [--body TEXT]');
    return 2;
  }
  try {
    const r = newDecision(root, { id, title, status, body });
    console.log(`wrote ${r.file}`);
    return 0;
  } catch (error) {
    console.error(`mole decision new: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CaptureError ? 2 : 1;
  }
}

/** `mole incident suggest <id>` (read-only advice) · `mole incident accept|dismiss <id> --argument <A>` (the person's step).
 *  T58, plan update 11-01 §6: an incident never changes a decision's status by itself. */
export function incidentCli(pos: string[], flags: Record<string, string | true>, root: string): number {
  const [sub, id] = pos;
  const usage = 'usage: mole incident list | mole incident suggest <incident-id> [--phase P | --at YYYY-MM-DD] | mole incident accept|dismiss <incident-id> --argument <argument-id> [--phase P | --at YYYY-MM-DD]';
  // T68: default (neither flag) = the phase in force today (D93), same selector suggest/accept/MCP all share
  const sel = { ...(str(flags.phase) ? { phase: str(flags.phase)! } : {}), ...(str(flags.at) ? { at: str(flags.at)! } : {}) };
  if (sub === 'list') {
    // T62: every incident with its top 3 suggestions (the VS Code panel's Reasoning section); read-only
    try {
      const incidents = loadGraph(root).nodes.filter((n) => n.kind === 'incident');
      console.log(JSON.stringify(incidents.map((n) => {
        try {
          return incidentSummary(root, n.id, 3);
        } catch (error) {
          return { id: n.id, title: n.title, error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
        }
      }), null, 2));
      return 0;
    } catch (error) {
      console.error(`mole incident list: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (!sub || !id || !['suggest', 'accept', 'dismiss'].includes(sub)) {
    console.error(usage);
    return 2;
  }
  try {
    if (sub === 'suggest') {
      console.log(JSON.stringify({ incident: id, candidates: suggestRevivals(root, id, sel) }, null, 2));
      return 0;
    }
    const arg = str(flags.argument);
    if (!arg) {
      console.error(usage);
      return 2;
    }
    const r = sub === 'accept' ? acceptIncident(root, id, arg, sel) : dismissIncident(root, id, arg);
    console.log(JSON.stringify(r, null, 2));
    return 0;
  } catch (error) {
    console.error(`mole incident ${sub}: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof IncidentError ? 2 : 1;
  }
}

/** `mole priorities [--phase P | --at YYYY-MM-DD]` · `mole priorities list` · `mole priorities compare <A> <B>` (T60) ·
 *  `mole priorities set --phase P --order a,b,c` (T73: writes .mole/priorities.md, a person's act) ·
 *  `mole priorities whatif --order a,b,c [--phase P | --at D]` (T73: compares the phase in force against an
 *  arbitrary order, never writes -- the panel's/CLI's "compare with order X"). */
export async function prioritiesCli(pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const [sub, a, b] = pos;
  try {
    let out: unknown;
    if (sub === 'compare') {
      if (!a || !b) {
        console.error('usage: mole priorities compare <phase> <phase>');
        return 2;
      }
      out = comparePhases(root, a, b);
    } else if (sub === 'list') {
      out = readPriorities(root);
    } else if (sub === 'set') {
      const phase = str(flags.phase);
      const orderStr = str(flags.order);
      if (!phase || !orderStr) {
        console.error('usage: mole priorities set --phase P --order a,b,c');
        return 2;
      }
      out = await setPriorities(root, phase, orderStr.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (sub === 'whatif') {
      const orderStr = str(flags.order);
      if (!orderStr) {
        console.error('usage: mole priorities whatif --order a,b,c [--phase P | --at YYYY-MM-DD]');
        return 2;
      }
      out = compareWithOrder(root, orderStr.split(',').map((s) => s.trim()).filter(Boolean), { ...(str(flags.phase) ? { phase: str(flags.phase)! } : {}), ...(str(flags.at) ? { at: str(flags.at)! } : {}) });
    } else if (sub === undefined) {
      out = evaluatePhase(root, { ...(str(flags.phase) ? { phase: str(flags.phase)! } : {}), ...(str(flags.at) ? { at: str(flags.at)! } : {}) });
    } else {
      console.error('usage: mole priorities [--phase P | --at YYYY-MM-DD] | list | compare <A> <B> | set --phase P --order a,b,c | whatif --order a,b,c');
      return 2;
    }
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } catch (error) {
    console.error(`mole priorities: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof PrioritiesError ? 2 : 1;
  }
}

/** `mole recall <text> | --record ID [--adr-dir DIR[,DIR]] [--limit N] [--root DIR] [--json]` (T71, done-when 4):
 *  past decisions/incidents that resemble the given text or an existing record, nearest first (Klein RPD /
 *  CBR Retrieve -- see recall/recall.ts's header). Always JSON, same shape mole_recall returns; `--json` is
 *  accepted for the contract's own spelling but this CLI has no other output mode, same convention as
 *  `mole incident suggest` / `mole priorities`. Read-only: never writes, never calls a model. */
export function recallCli(pos: string[], flags: Record<string, string | true>, root: string): number {
  const record = str(flags.record);
  const text = pos.length ? pos.join(' ') : undefined;
  if (record && text) {
    console.error('usage: mole recall <text> | --record ID -- give one, not both');
    return 2;
  }
  const adr = str(flags['adr-dir']);
  const limitStr = str(flags.limit);
  try {
    const r = recallSimilar(
      root,
      record ? { record } : { text },
      { adrDirs: adr ? adr.split(',').map((s) => s.trim()).filter(Boolean) : [], ...(limitStr ? { limit: Number(limitStr) } : {}) },
    );
    console.log(JSON.stringify(r, null, 2));
    return 0;
  } catch (error) {
    console.error(`mole recall: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof RecallError ? 2 : 1;
  }
}
