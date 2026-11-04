// Citator flags ((internal reference removed) insights.md section 0): red > yellow > green/grey, each with reasons at file:line,
// propagated along traces_to / overrides / cites / amends to a fixed point. Computed by code only: files + git, no model.
import { checkAnchor, Git, testPresent, TestReport } from './anchors.js';
import type { DecisionGraph, Flag, FlagContext, FlagResult, GraphEdge, GraphNode, Reason } from './types.js';

const FLAGGED = new Set(['decision', 'tenet']);
const PROPAGATES = new Set(['traces_to', 'overrides', 'cites', 'amends']);
const rank: Record<Flag, number> = { red: 3, yellow: 2, green: 1, grey: 0 };

function baseFlag(n: GraphNode, reasons: Reason[]): Flag {
  if (reasons.some((r) => r.flag === 'red')) return 'red';
  if (reasons.some((r) => r.flag === 'yellow')) return 'yellow';
  if (n.kind === 'tenet') return 'green';
  return n.status === 'accepted' ? 'green' : 'grey';
}

const raisedBy = (reasons: Reason[], except: string): Reason[] => reasons.filter((r) => r.by !== except);

export function computeFlags(graph: DecisionGraph, ctx: FlagContext = {}): FlagResult[] {
  const root = graph.root;
  const nodes = graph.nodes.filter((n) => FLAGGED.has(n.kind));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const git = new Git(root);
  const report = TestReport.load(ctx.testReport, process.cwd());

  // confirmed: the record's own field, else the last commit that touched the record file (one git log pass)
  const needLast = nodes.filter((n) => n.kind === 'decision' && n.scope.length > 0 && (!n.confirmed || !git.commit(n.confirmed))).map((n) => n.file);
  const last = git.ok ? git.lastCommits([...new Set(needLast)]) : new Map<string, string>();

  const reasons = new Map<string, Reason[]>();
  const add = (id: string, r: Reason) => {
    const list = reasons.get(id)!;
    // the same treatment written twice at one place (an ADR status line that is both status and relation) is one reason
    if (!list.some((x) => x.code === r.code && x.file === r.file && x.line === r.line)) list.push(r);
  };
  for (const n of nodes) reasons.set(n.id, []);

  for (const n of nodes) {
    const id = n.id;
    const statusLine = n.fields.status ?? n.line;
    if (n.kind === 'tenet') {
      if (n.retired) add(id, { flag: 'red', code: 'retired', text: `${id} is retired`, file: n.file, line: n.line });
      continue;
    }
    if (n.status === 'superseded') add(id, { flag: 'red', code: 'superseded', text: `status: ${n.statusText ?? 'superseded'}`, file: n.file, line: statusLine });
    if (n.status === 'deprecated') add(id, { flag: 'red', code: 'deprecated', text: `status: ${n.statusText ?? 'deprecated'}`, file: n.file, line: statusLine });
    if (n.status === 'partly-superseded') add(id, { flag: 'yellow', code: 'partly_superseded', text: `status: ${n.statusText ?? 'partly superseded'}`, file: n.file, line: statusLine });

    // scope anchors
    if (n.scope.length > 0) {
      const own = n.confirmed ? git.commit(n.confirmed) : null;
      const sha = own ?? (last.get(n.file) ? git.commit(last.get(n.file)!) : null);
      const states = n.scope.map((a) => ({ a, s: checkAnchor(root, git, a.target, sha) }));
      const gone = states.filter((x) => !x.s.present);
      if (gone.length === states.length)
        for (const { a } of gone) add(id, { flag: 'red', code: 'orphaned', text: `scope ${a.target} no longer exists (every anchor gone)`, file: a.file, line: a.line });
      else
        for (const { a } of gone) add(id, { flag: 'yellow', code: 'anchor_gone', text: `scope ${a.target} no longer exists`, file: a.file, line: a.line });
      for (const { a, s } of states)
        if (s.present && s.changed)
          add(id, { flag: 'yellow', code: 'scope_changed', text: `code in ${a.target} changed since ${sha!.slice(0, 7)}${own ? ' (confirmed)' : ' (record last committed)'}`, file: a.file, line: a.line });
    }

    // evidence
    for (const ev of n.evidence) {
      if (ev.incident !== undefined) {
        const inc = byId.get(ev.incident);
        if (!inc || inc.kind !== 'incident') add(id, { flag: 'yellow', code: 'evidence_missing', text: `incident ${ev.incident} has no record in .mole/incidents`, file: ev.file, line: ev.line });
        continue;
      }
      if (!ev.test) continue;
      const t = testPresent(root, ev.test);
      if (!t.present) {
        add(id, { flag: 'yellow', code: 'evidence_missing', text: t.name ? `test '${t.name}' not found in ${t.path}` : `test file ${t.path} not found`, file: ev.file, line: ev.line });
        continue;
      }
      if (report?.status(root, ev) === 'failed') add(id, { flag: 'yellow', code: 'evidence_failing', text: `test ${ev.test} fails in the test report`, file: ev.file, line: ev.line });
    }
  }

  // treatment by other records
  const relFlag = (e: GraphEdge, target: string, other: string) => {
    const o = byId.get(other);
    const t = byId.get(target);
    // review 1 P1-1: a record that itself says superseded_by <unknown id> is red, never silently green
    if (!o && t && reasons.has(target) && e.type === 'supersedes' && e.file === t.file) {
      add(target, { flag: 'red', code: 'superseded', text: `superseded by ${other} (not found)`, file: e.file, line: e.line, by: other });
      return;
    }
    if (!o || !t || !reasons.has(target) || o.kind !== 'decision') return;
    if (e.type === 'supersedes') {
      const writtenInTarget = e.file === t.file;
      if (writtenInTarget || o.status === 'accepted')
        add(target, { flag: 'red', code: 'superseded', text: `superseded by ${other}${o.status === 'accepted' ? '' : ` (${o.status})`}`, file: e.file, line: e.line, by: other });
      else if (o.status === 'proposed') add(target, { flag: 'yellow', code: 'proposed_change', text: `proposed ${other} supersedes it`, file: e.file, line: e.line, by: other });
      return;
    }
    if (o.status !== 'proposed') return;
    if (e.type === 'overrides') add(target, { flag: 'yellow', code: 'proposed_change', text: `proposed ${other} overrides it`, file: e.file, line: e.line, by: other });
    if (e.type === 'conflicts_with') add(target, { flag: 'yellow', code: 'proposed_change', text: `proposed ${other} conflicts with it`, file: e.file, line: e.line, by: other });
  };
  for (const e of graph.edges) {
    if (e.type === 'supersedes' || e.type === 'overrides') relFlag(e, e.to, e.from);
    else if (e.type === 'conflicts_with') {
      relFlag(e, e.to, e.from);
      relFlag(e, e.from, e.to); // symmetric
    }
  }

  // propagation to a fixed point: a record whose parent (traces_to / overrides / cites / amends) is yellow or red turns yellow,
  // ignoring the parent's reasons the child itself caused
  const parents = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) if (PROPAGATES.has(e.type) && reasons.has(e.from) && reasons.has(e.to)) parents.set(e.from, [...(parents.get(e.from) ?? []), e]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, edges] of parents) {
      const mine = reasons.get(child)!;
      for (const e of edges) {
        if (mine.some((r) => r.code === 'inherited' && r.by === e.to)) continue;
        const theirs = raisedBy(reasons.get(e.to)!, child);
        if (theirs.length === 0) continue;
        const worst = theirs.some((r) => r.flag === 'red') ? 'red' : 'yellow';
        const why = theirs.find((r) => r.flag === worst)!;
        mine.push({ flag: 'yellow', code: 'inherited', text: `${e.type} ${e.to}, which is ${worst} (${why.code}: ${why.text})`, file: e.file, line: e.line, by: e.to });
        changed = true;
      }
    }
  }

  return nodes.map((n) => {
    const rs = [...reasons.get(n.id)!].sort((a, b) => rank[b.flag] - rank[a.flag]);
    return { id: n.id, kind: n.kind, title: n.title, status: n.status, flag: baseFlag(n, rs), file: n.file, line: n.line, reasons: rs };
  });
}
