// T58: incidents revive recorded dissent (plan update 11-01 §6 steps 1-5; prior art: (internal reference removed) log/prior-art.md).
//
//   suggest   read-only advice. A candidate is a LOSING argument (grounded label 'out') in the attack neighbourhood of a
//             decision the incident shares a node with: named in its `decisions:` list, or whose `scope:` overlaps the
//             incident's `scope:` (Graphiti get_edge_invalidation_candidates: must share a node; similarity only ranks).
//             Ranked by char-3gram Jaccard between the incident text and the argument text. No LLM.
//   accept    the person's step, only for a current candidate. ONE atomic write of the incident record: `revives: [arg]`
//             + `attacks: [its IN attackers]`, frozen at accept time. The loader (graph.ts loadIncidents) turns
//             `attacks:` into the argument `incident-<id>` (Dung reinstatement). No second file, so no crash between
//             writes and no completion path (review 3).
//   dismiss   records `dismissed: [arg]` in the incident record only.
// Decision records are never written: a decision turns contested/defeated only because the engine re-labels its arguments.
// A person may also write `attacks:` in an incident record by hand: that is an explicit authoring act, like editing an
// .argdown file (review 4 agreed); the tool's own paths only ever write it through accept.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, type Label } from '@mole/reasoning';
import { argumentDefinitions, type ArgumentDefinition } from '../argdown/definitions.js';
import { argumentFramework } from '../argdown/framework.js';
import { frontMatter, loadGraph } from '../graph.js';
import { phaseInForce, tenetValues, type Phase } from '../priorities.js';
import type { DecisionGraph, GraphNode } from '../types.js';

export class IncidentError extends Error {}

export interface RevivalEvidence {
  kind: 'decision' | 'scope' | 'text';
  value: string;
  /** record + line the evidence comes from */
  file: string;
  line: number;
}

export interface RevivalCandidate {
  incident: string;
  /** the losing argument the incident may vindicate */
  argument: string;
  text: string;
  /** label under the resolved phase (or plain Dung when none applies); this is what admits a candidate */
  label: Label;
  /** T68: always the plain-Dung label (no audience), shown beside `label` so a phase-driven candidate is never
   *  silently substituted for the plain-Dung reading (STOP clause: show both, never pick silently) */
  plainLabel: Label;
  /** T68: the phase name `label` was resolved under; undefined = no audience (no priorities file, or none in force) */
  phase?: string;
  /** the decision whose reasoning it lost in */
  decision: string;
  /** its current IN attackers -- what accept would attack */
  attackers: string[];
  /** other arguments that go out -> in if this is accepted (dry run): the knock-on the person approves along with it */
  alsoReinstates: string[];
  score: number;
  evidence: RevivalEvidence[];
}

/** the incident's argument id: the record id itself is already taken by the incident node (the loader keeps the first id) */
export const incidentArgumentId = (incidentId: string): string => `incident-${incidentId}`;

interface IncidentRecord {
  id: string;
  file: string;
  text: string;
  title: string;
  decisions: Array<{ value: string; line: number }>;
  scope: Array<{ value: string; line: number }>;
  revives: string[];
  dismissed: string[];
}

function readIncident(root: string, graph: DecisionGraph, id: string): IncidentRecord {
  const node = graph.nodes.find((n) => n.kind === 'incident' && n.id === id);
  if (!node) throw new IncidentError(`no incident record with id '${id}' in .mole/incidents`);
  const text = readFileSync(join(root, node.file), 'utf8');
  const fm = frontMatter(text, node.file);
  if (!fm || 'error' in fm) throw new IncidentError(`incident ${id}: unreadable front matter in ${node.file}`);
  const items = (k: string) => (fm.fields.get(k)?.items ?? []).filter((i) => i.value).map((i) => ({ value: i.value!, line: i.line }));
  const one = (k: string) => fm.fields.get(k)?.value ?? fm.fields.get(k)?.items?.[0]?.value;
  const lines = text.split(/\r?\n/);
  const close = lines.indexOf('---', 1);
  const body = close > 0 ? lines.slice(close + 1).join('\n') : '';
  const title = one('title') ?? id;
  return {
    id,
    file: node.file,
    title,
    text: `${title}\n${body}`,
    decisions: items('decisions'),
    scope: items('scope'),
    revives: items('revives').map((i) => i.value),
    dismissed: items('dismissed').map((i) => i.value),
  };
}

/** '<id>: text' on the argument's own definition line (the parser keys items by title only). */
function argumentText(defs: Map<string, ArgumentDefinition[]>, n: GraphNode): string {
  // the definition line, not node.line (first mention may be a bare `-> <id>` reference: T60 review 1, same class)
  return defs.get(n.id)?.[0]?.text ?? '';
}

function trigrams(s: string): Set<string> {
  const t = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** paths overlap when one is a prefix of the other at a path boundary (src/cache/ vs src/cache/prices.ts) */
function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/#.*$/, '');
  const [x, y] = [norm(a), norm(b)];
  const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  return under(x, y) || under(y, x);
}

interface Evaluated {
  graph: DecisionGraph;
  /** phase-resolved labels (or plain Dung, when no phase applies) -- what admits/shows a candidate */
  labels: Record<string, Label>;
  /** T68: always the plain-Dung reading, shown beside `labels` on every candidate */
  plainLabels: Record<string, Label>;
  attacks: [string, string][];
  phase?: Phase;
}

/** T68: `sel` ({ phase, at }) picks the audience the same way `@mole/decisions`' T60 priorities does; absent both,
 *  the phase in force TODAY is used (D93), not plain Dung -- `phaseInForce` (priorities.ts) is the one place that
 *  rule lives. An argument with no #tenet- tag, or a phase with no priorities file, is unaffected (unfiltered
 *  attack / no audience), identical to plain Dung -- so every existing (no-priorities-file) caller is unchanged. */
function evaluated(root: string, sel: { phase?: string; at?: string } = {}): Evaluated {
  const graph = loadGraph(root);
  const { framework } = argumentFramework(graph);
  const plainLabels = evaluate(framework).labels;
  const phase = phaseInForce(root, sel, graph);
  if (!phase) return { graph, labels: plainLabels, plainLabels, attacks: framework.attacks };
  const values = tenetValues(graph);
  const args = framework.args.map((a) => ({ ...a, ...(values.has(a.id) ? { value: values.get(a.id)! } : {}) }));
  const labels = evaluate({ args, attacks: framework.attacks }, phase.order).labels;
  return { graph, labels, plainLabels, attacks: framework.attacks, phase };
}

/** Every argument attack-connected (either direction, any distance) to the decision's cited arguments.
 *  Review 1 MEDIUM: a 3-hop limit silently dropped a real dissent 5 steps away. */
function neighbourhood(ev: Evaluated, decisionId: string): Set<string> {
  const isArg = new Set(ev.graph.nodes.filter((n) => n.kind === 'argument').map((n) => n.id));
  const adj = new Map<string, string[]>();
  const link = (x: string, y: string) => (adj.get(x) ?? adj.set(x, []).get(x)!).push(y);
  for (const [a, b] of ev.attacks) (link(a, b), link(b, a));
  // review 2: adjacency index + queue (was a full attack scan per level: 10k-argument chain 71 s)
  const queue = ev.graph.edges.filter((e) => e.type === 'cites' && e.from === decisionId && isArg.has(e.to)).map((e) => e.to);
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) for (const y of adj.get(queue[i]!) ?? []) if (!seen.has(y)) (seen.add(y), queue.push(y));
  return seen;
}

/** arguments that would go out -> in if `inc` attacked `targets` (the same framework, one more argument) */
function dryRun(ev: Evaluated, inc: string, targets: string[]): string[] {
  const ids = new Set(Object.keys(ev.labels));
  const attacks: [string, string][] = [...ev.attacks, ...targets.map((t) => [inc, t] as [string, string])];
  const after = evaluate({ args: [...ids, ...(ids.has(inc) ? [] : [inc])].map((id) => ({ id })), attacks }).labels;
  return [...ids].filter((id) => ev.labels[id] === 'out' && after[id] === 'in').sort();
}

function candidates(root: string, ev: Evaluated, inc: IncidentRecord): RevivalCandidate[] {
  const decided = new Set([...inc.revives, ...inc.dismissed]);
  const incText = trigrams(inc.text);
  const nodes = new Map(ev.graph.nodes.map((n) => [n.id, n] as const));
  const byArg = new Map<string, RevivalCandidate>();
  const defs = argumentDefinitions(ev.graph);
  const attackersOf = new Map<string, string[]>();
  for (const [a, b] of ev.attacks) (attackersOf.get(b) ?? attackersOf.set(b, []).get(b)!).push(a);
  const hitByIncident = new Set(ev.attacks.filter(([a]) => a.startsWith('incident-')).map(([, b]) => b));
  for (const d of ev.graph.nodes.filter((n) => n.kind === 'decision').sort((a, b) => a.id.localeCompare(b.id))) {
    const ties: RevivalEvidence[] = [];
    const named = inc.decisions.find((x) => x.value === d.id);
    if (named) ties.push({ kind: 'decision', value: d.id, file: inc.file, line: named.line });
    for (const s of inc.scope) if (d.scope.some((a) => overlaps(a.target, s.value))) ties.push({ kind: 'scope', value: s.value, file: inc.file, line: s.line });
    if (ties.length === 0) continue; // text overlap alone never admits a candidate
    // a dissent is a losing argument that is NOT one the decision itself rests on (an incident knocking out the
    // decision's own argument is the result of an accept, not a new candidate) and not already hit by an incident
    const own = new Set(ev.graph.edges.filter((e) => e.type === 'cites' && e.from === d.id).map((e) => e.to));
    for (const arg of [...neighbourhood(ev, d.id)].sort()) {
      if (ev.labels[arg] !== 'out' || decided.has(arg) || byArg.has(arg) || own.has(arg) || hitByIncident.has(arg)) continue;
      const n = nodes.get(arg)!;
      const text = argumentText(defs, n);
      const score = Math.round(jaccard(incText, trigrams(text)) * 1000) / 1000;
      const attackers = [...new Set((attackersOf.get(arg) ?? []).filter((a) => ev.labels[a] === 'in'))].sort();
      const alsoReinstates: string[] = []; // filled by withKnockOn for the candidates actually shown/accepted
      byArg.set(arg, {
        incident: inc.id,
        argument: arg,
        text,
        label: ev.labels[arg]!,
        plainLabel: ev.plainLabels[arg]!,
        ...(ev.phase ? { phase: ev.phase.name } : {}),
        decision: d.id,
        attackers,
        alsoReinstates,
        score,
        evidence: [...ties, { kind: 'text', value: `char-3gram Jaccard ${score}`, file: n.file, line: n.line }],
      });
    }
  }
  return [...byArg.values()].sort((a, b) => b.score - a.score || a.argument.localeCompare(b.argument));
}

/** the dry run is one full evaluation per candidate: done only for what is shown (Graphiti `limit`) or accepted */
function withKnockOn(ev: Evaluated, inc: IncidentRecord, c: RevivalCandidate): RevivalCandidate {
  return { ...c, alsoReinstates: dryRun(ev, incidentArgumentId(inc.id), c.attackers).filter((x) => x !== c.argument) };
}

export const DEFAULT_SUGGEST_LIMIT = 20;

export interface PhaseSelector {
  phase?: string;
  at?: string;
}

/** Top `limit` candidates by score (default 20), each with its dry-run knock-on. Read-only. */
/** T62 `mole incident list`: the incident's own title (from its record, not the graph node, whose title is the id)
 *  and its top suggestions. Read-only. */
export function incidentSummary(root: string, incidentId: string, limit = 3, sel: PhaseSelector = {}): { id: string; title: string; candidates: RevivalCandidate[] } {
  const ev = evaluated(root, sel);
  const inc = readIncident(root, ev.graph, incidentId);
  return { id: incidentId, title: inc.title, candidates: candidates(root, ev, inc).slice(0, limit).map((c) => withKnockOn(ev, inc, c)) };
}

export function suggestRevivals(root: string, incidentId: string, opts: { limit?: number } & PhaseSelector = {}): RevivalCandidate[] {
  const ev = evaluated(root, { phase: opts.phase, at: opts.at });
  const inc = readIncident(root, ev.graph, incidentId);
  return candidates(root, ev, inc).slice(0, opts.limit ?? DEFAULT_SUGGEST_LIMIT).map((c) => withKnockOn(ev, inc, c));
}

/** Add `item` to the front-matter list `key` of the record (creating `key: [item]` before the closing ---). */
function addToListText(text: string, file: string, key: string, item: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const close = lines.indexOf('---', 1);
  if (lines[0] !== '---' || close < 0) throw new IncidentError(`${file}: no front matter`);
  const at = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^${key}:`).test(l));
  if (at < 0) {
    lines.splice(close, 0, `${key}: [${item}]`);
  } else if (/^[^:]+:\s*$/.test(lines[at]!)) {
    // block-style list (review 1 LOW): `key:` then `  - x` lines
    let end = at + 1;
    const items: string[] = [];
    // items may be separated by blank or comment lines (review 2 LOW); the list ends at the first other line
    let last = at;
    for (let i = at + 1; i < close; i++) {
      const l = lines[i]!;
      if (/^\s+-\s+/.test(l)) (items.push(l.replace(/^\s+-\s+/, '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')), (last = i));
      else if (!/^\s*(#.*)?$/.test(l)) break;
    }
    end = last + 1;
    if (items.includes(item)) return text;
    const indent = /^(\s+)-/.exec(lines[at + 1] ?? '')?.[1] ?? '  ';
    lines.splice(end, 0, `${indent}- ${item}`);
  } else {
    const m = /^[^:]+:\s*\[(.*)\]\s*$/.exec(lines[at]!);
    if (!m) throw new IncidentError(`${file}:${at + 1}: ${key} must be a [list] to add to it`);
    const items = m[1]!.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (items.includes(item)) return text;
    lines[at] = `${key}: [${[...items, item].join(', ')}]`;
  }
  return lines.join(nl);
}

function addToList(root: string, file: string, key: string, item: string): boolean {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const next = addToListText(text, file, key, item);
  if (next === text) return false;
  writeFileSync(path, next);
  return true;
}


export interface IncidentWrite {
  incident: string;
  argument: string;
  written: string[];
  /** accept only: the other arguments the accepted attack brought back (same list suggest showed) */
  alsoReinstates?: string[];
}

export function acceptIncident(root: string, incidentId: string, argumentId: string, sel: PhaseSelector = {}): IncidentWrite {
  const ev = evaluated(root, sel);
  const inc = readIncident(root, ev.graph, incidentId);
  if (inc.dismissed.includes(argumentId)) throw new IncidentError(`${argumentId} was already dismissed for ${inc.id}`);
  // already accepted (or hand-recorded): nothing to complete. `revives:` is the record; the attack comes ONLY from the
  // `attacks:` list written with it (review 3: no completion path, no attackers re-derived later)
  if (inc.revives.includes(argumentId)) return { incident: inc.id, argument: argumentId, written: [], alsoReinstates: [] };
  // the person's accept: only for a CURRENT candidate (review 2)
  const c = candidates(root, ev, inc).find((x) => x.argument === argumentId);
  if (!c) throw new IncidentError(`${argumentId} is not a candidate for ${inc.id} (run: mole incident suggest ${inc.id})`);
  const { alsoReinstates } = withKnockOn(ev, inc, c);
  // ONE atomic write (temp file + rename): `revives: [A]` and the frozen `attacks:` targets together
  const path = join(root, inc.file);
  let text = readFileSync(path, 'utf8');
  text = addToListText(text, inc.file, 'revives', argumentId);
  for (const t of c.attackers) text = addToListText(text, inc.file, 'attacks', t);
  const tmp = `${path}.mole-tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return { incident: inc.id, argument: argumentId, written: [inc.file], alsoReinstates };
}

/** T81 (D66): the front-matter TEXT for a candidate incident record -- same shape `readIncident` (above) already
 * parses (`decisions:` list + a title + body), so once a PERSON saves it under `.mole/incidents/<id>.md` the
 * existing `mole incident suggest/accept/dismiss` flow picks it up unchanged. This function only builds the
 * string; it never writes a file and is never called automatically -- the write, and the choice to make one at
 * all, stays a person's act (same boundary as acceptIncident's own comment: "a person's step, only for a
 * current candidate"). Used by outcomes/report.ts when an outcome contradicts its prediction. */
export function draftIncidentRecord(id: string, title: string, text: string, decisionIds: string[]): string {
  const lines = ['---', `id: ${id}`, `title: ${title}`, 'decisions:', ...decisionIds.map((d) => `  - ${d}`), '---', '', text, ''];
  return lines.join('\n');
}

export function dismissIncident(root: string, incidentId: string, argumentId: string): IncidentWrite {
  const ev = evaluated(root);
  const inc = readIncident(root, ev.graph, incidentId);
  if (inc.revives.includes(argumentId)) throw new IncidentError(`${argumentId} was already accepted for ${inc.id}; dismissing it would need a new record, not an edit`);
  const written = addToList(root, inc.file, 'dismissed', argumentId) ? [inc.file] : [];
  return { incident: inc.id, argument: argumentId, written };
}
