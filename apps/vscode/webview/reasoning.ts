// T62: the panel's "Reasoning" section (T34 one-panel), rendered from the same CLI JSON agents get over MCP (T61):
//   phase       `mole priorities` (phase in force) + `mole priorities compare <current> <adjacent>` (T60)
//   incidents   `mole incident list` (T58 suggestions; accepting stays a person's CLI act, shown as the command)
//   proposals   `mole proposals` (T56 what-if branches vs their baseline)
// Pure data -> HTML (like since.ts): no DOM, every record-supplied string escaped, every line traceable to a JSON field.
import type { FlippedAttack, Phase, PhaseComparison, PhaseEvaluation, RevivalCandidate } from '@mole/decisions';

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export type Failed = { error: string };
export interface PhasePart {
  /** absent when there is no .mole/priorities.md (or no phase in force) */
  current?: Phase;
  adjacent?: Phase;
  /** next = what changes when the adjacent phase starts (compare current -> next); previous = what changed when the
   *  current one started (compare previous -> current) */
  direction?: 'next' | 'previous';
  evaluation: PhaseEvaluation;
  comparison?: PhaseComparison | Failed;
}
/** T73: the panel's "compare with order X" what-if -- the order the person typed and its result (or its
 *  one-line error); absent until they run it. Never written to .mole/priorities.md (STOP clause). */
export interface WhatIf {
  order: string[];
  comparison: PhaseComparison | Failed;
}
export interface IncidentEntry {
  id: string;
  title: string;
  candidates?: RevivalCandidate[];
  error?: string;
}
/** structural copy of @mole/proposals Comparison (apps/vscode does not depend on that package) */
export interface ProposalSummary {
  baselineRevision?: string;
  proposals: Array<{
    name: string;
    changes: {
      arguments: Array<{ id: string; before: string; after: string }>;
      decisions: Array<{ id: string; title: string; before: string; after: string; because: string[] }>;
    };
    problems: Array<{ file: string; line: number; message: string }>;
  }>;
}
export interface ReasoningData {
  phase?: PhasePart | Failed;
  incidents?: IncidentEntry[] | Failed;
  proposals?: ProposalSummary | Failed;
  /** T73: present only once the person has run the what-if control; never part of the passive refresh */
  whatIf?: WhatIf;
}

export const failed = (x: unknown): x is Failed => !!x && typeof x === 'object' && typeof (x as Failed).error === 'string';

function attackLine(a: FlippedAttack, target: string): string {
  const now = a.after.succeeds;
  const [fr, tr] = a.after.ranks;
  const [pfr, ptr] = a.before.ranks;
  return `<li><span class="arg">${esc(a.from)}</span> (${esc(a.fromValue)} #${fr}) ${now ? 'now beats' : 'no longer beats'} <span class="arg">${esc(target)}</span> (${esc(a.toValue)} #${tr}); was #${pfr} vs #${ptr}</li>`;
}

function comparisonBody(c: PhaseComparison): string {
  if (c.decisions.length === 0 && c.arguments.length === 0) return `<p class="rs-none">no decision changes</p>`;
  const args = new Map(c.arguments.map((a) => [a.id, a]));
  const rows = c.decisions.map((d) => {
    const why = d.because.map((id) => {
      const a = args.get(id);
      if (!a) return '';
      const flips = a.flipped.map((f) => attackLine(f, id)).join('');
      const via = a.via.length ? `<li><span class="arg">${esc(id)}</span> ${esc(a.before)} → ${esc(a.after)} via ${a.via.map(esc).join(', ')}</li>` : '';
      return flips + via;
    }).join('');
    return `<li class="rs-dec"><b>${esc(d.id)}</b> ${esc(d.title)}: ${esc(d.before)} → ${esc(d.after)} (${esc(c.from)} → ${esc(c.to)})<ul>${why}</ul></li>`;
  }).join('');
  const others = c.arguments.filter((a) => !c.decisions.some((d) => d.because.includes(a.id)));
  const otherRows = others.length ? `<li class="rs-args">${others.length} more argument(s) change: ${others.map((a) => `${esc(a.id)} ${esc(a.before)} → ${esc(a.after)}`).join(', ')}</li>` : '';
  return `<ul>${rows}${otherRows}</ul>`;
}

function phaseHtml(p: PhasePart | Failed, whatIf?: WhatIf): string {
  if (failed(p)) return `<div class="rs-part"><h4>Phase</h4><p class="msg">${esc(p.error)}</p></div>`;
  if (!p.current) return `<div class="rs-part"><h4>Phase</h4><p class="rs-none">No .mole/priorities.md: decisions are judged without a phase order (every attack counts).</p></div>`;
  const order = p.current.order.map((t, i) => `${i + 1}. ${esc(t)}`).join(' &nbsp; ');
  let out = `<div class="rs-part"><h4>Phase in force: ${esc(p.current.name)} <span class="rs-from">from ${esc(p.current.from)}</span></h4><p class="rs-order">${order}</p>`;
  if (p.adjacent && p.comparison) {
    const c = p.comparison;
    out += `<p class="rs-sub">${p.direction === 'next' ? `When <b>${esc(p.adjacent.name)}</b> starts (${esc(p.adjacent.from)}):` : `What changed when <b>${esc(p.current.name)}</b> started (${esc(p.current.from)}), against <b>${esc(p.adjacent.name)}</b>:`}</p>`;
    out += failed(c) ? `<p class="msg">${esc(c.error)}</p>` : comparisonBody(c);
  }
  // T73: the what-if control -- compares the phase in force against an order the person types, never writes
  out += `<div class="rs-whatif"><input type="text" data-whatif-order placeholder="compare with order: tenet-a,tenet-b" value="${esc(p.current.order.join(','))}"><button data-whatif-run>Compare</button><div data-whatif-result>${whatIf ? renderWhatIf(whatIf) : ''}</div></div>`;
  return `${out}</div>`;
}

/** T73: the what-if result -- the order tried, and the same comparison rendering the next-phase diff uses
 *  (one source of truth), or its one-line error. Pure data -> HTML, like the rest of this module. */
export function renderWhatIf(w: WhatIf): string {
  const orderLine = `<p class="rs-order">what-if order: ${w.order.map((t, i) => `${i + 1}. ${esc(t)}`).join(' &nbsp; ')}</p>`;
  if (failed(w.comparison)) return `${orderLine}<p class="msg">${esc(w.comparison.error)}</p>`;
  return `${orderLine}${comparisonBody(w.comparison)}`;
}

function incidentsHtml(list: IncidentEntry[] | Failed): string {
  if (failed(list)) return `<div class="rs-part"><h4>Incidents</h4><p class="msg">${esc(list.error)}</p></div>`;
  if (list.length === 0) return '';
  const rows = list.map((i) => {
    if (i.error) return `<li><b>${esc(i.id)}</b> <span class="msg">${esc(i.error)}</span></li>`;
    const cands = i.candidates ?? [];
    const body = cands.length
      ? cands.map((c) => `<li><span class="arg">${esc(c.argument)}</span> lost to ${c.attackers.map(esc).join(', ')} in <b>${esc(c.decision)}</b>${c.alsoReinstates.length ? `; accepting also reinstates ${c.alsoReinstates.map(esc).join(', ')}` : ''}<div class="rs-text">${esc(c.text)}</div><code>mole incident accept ${esc(i.id)} --argument ${esc(c.argument)}</code></li>`).join('')
      : '<li class="rs-none">no losing argument to revive</li>';
    return `<li><b>${esc(i.id)}</b> ${esc(i.title)}<ul>${body}</ul></li>`;
  }).join('');
  return `<div class="rs-part"><h4>Incidents: dissent they may revive</h4><ul>${rows}</ul></div>`;
}

function proposalsHtml(s: ProposalSummary | Failed): string {
  if (failed(s)) return `<div class="rs-part"><h4>Proposals</h4><p class="msg">${esc(s.error)}</p></div>`;
  if (s.proposals.length === 0) return '';
  const rows = s.proposals.map((p) => {
    const decs = p.changes.decisions.map((d) => `<li><b>${esc(d.id)}</b> ${esc(d.title)}: ${esc(d.before)} → ${esc(d.after)}${d.because.length ? ` (because ${d.because.map(esc).join(', ')})` : ''}</li>`).join('');
    const args = p.changes.arguments.length ? `<li class="rs-args">${p.changes.arguments.length} argument(s) change</li>` : '';
    const probs = p.problems.length ? `<li class="msg">${p.problems.length} problem(s), e.g. ${esc(p.problems[0]!.file)}:${p.problems[0]!.line} ${esc(p.problems[0]!.message)}</li>` : '';
    return `<li><b>${esc(p.name)}</b><ul>${decs || '<li class="rs-none">no decision changes</li>'}${args}${probs}</ul></li>`;
  }).join('');
  return `<div class="rs-part"><h4>Proposals vs baseline${s.baselineRevision ? ` ${esc(s.baselineRevision.slice(0, 7))}` : ''}</h4><ul>${rows}</ul></div>`;
}

/** HTML for the section body; parts that are absent (not loaded) or empty are left out. */
export function renderReasoning(d: ReasoningData): string {
  return [d.phase ? phaseHtml(d.phase, d.whatIf) : '', d.incidents ? incidentsHtml(d.incidents) : '', d.proposals ? proposalsHtml(d.proposals) : ''].join('');
}
