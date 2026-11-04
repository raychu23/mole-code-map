// T30 annotated file tree, core ((internal reference removed) insights.md section 0). Imports no flag/anchor code (and so no
// TypeScript compiler): the VS Code extension bundles this file alone and gets the flags from `mole decisions --json`. Pure core: (graph + cached flags + intent records)
// -> per file/folder {flag, badge, tooltip} and per folder an intent card. The only I/O is in readTreeRecords / loadTree.
//   flag   worst of the decisions in force (accepted, partly superseded) scoped to the path or below: red > yellow > green.
//          Proposed (grey), superseded, deprecated and rejected records never color and never count.
//   badge  how many decisions in force are scoped to the path or below (<= 2 characters, VS Code's limit; the tooltip has the exact count)
//   card   purpose · end state · risk (.mole/intent/<folder>.md) · tenets traced · decisions with flag + evidence state + exceptions
//          · proposed · replaced · who to ask (intent ask + approvers) · your read state. A field with no record is left out.
//   empty  a path with no records gets no decoration and no card (done-when 4).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontMatter, loadGraph } from '../graph.js';
import type { DecisionGraph, Flag, FlagContext, FlagResult, GraphNode, LoadOptions } from '../types.js';

export type TreeFlag = 'green' | 'yellow' | 'red';
export type EvidenceState = 'tested' | 'test missing' | 'test failing' | 'incident' | 'no test';

export interface ReadState {
  lastRead?: string;
  explainedBack?: boolean;
}

export interface IntentRecord {
  folder: string;
  file: string;
  purpose?: string;
  endState?: string;
  risk?: string;
  ask: string[];
  tenets: string[];
}

export interface CardDecision {
  id: string;
  title: string;
  status: string;
  flag: Flag;
  /** the decision's scope paths at or below the card's folder */
  anchors: string[];
  evidence: EvidenceState;
  /** decisions that override this one (its exceptions) */
  exceptions: string[];
  /** decisions that supersede this one */
  replacedBy: string[];
  /** each yellow/red reason as 'text (file:line)' */
  reasons: string[];
  summary?: string;
  approver?: string;
  file: string;
  line: number;
}

export interface IntentCard {
  folder: string;
  purpose?: string;
  endState?: string;
  risk?: string;
  ask: string[];
  tenets: Array<{ id: string; title: string; flag: Flag }>;
  decisions: CardDecision[];
  proposed: CardDecision[];
  replaced: CardDecision[];
  intentFile?: string;
  read?: ReadState;
}

export interface Decoration {
  path: string;
  flag?: TreeFlag;
  badge?: string;
  count: number;
  tooltip: string;
}

export interface TreeInput {
  graph: DecisionGraph;
  flags: FlagResult[];
  intents?: IntentRecord[];
  summaries?: Record<string, string>;
  reads?: Record<string, ReadState>;
}

export interface TreeIndex {
  root: string;
  /** every folder that has a decoration or a card (repo-relative, '' = root), sorted */
  folders: string[];
  decoration(path: string): Decoration | undefined;
  card(path: string): IntentCard | undefined;
}

export type TreeOptions = LoadOptions & FlagContext & { reads?: Record<string, ReadState> };

type Group = 'force' | 'proposed' | 'replaced';
const IN_FORCE = new Set(['accepted', 'partly-superseded']);
const REPLACED = new Set(['superseded', 'deprecated']);
const groupOf = (status: string): Group | undefined => (IN_FORCE.has(status) ? 'force' : status === 'proposed' ? 'proposed' : REPLACED.has(status) ? 'replaced' : undefined);
const RANK: Record<Flag, number> = { red: 3, yellow: 2, green: 1, grey: 0 };
const MARK: Record<Flag, string> = { green: '✓', yellow: '!', red: '✗', grey: '○' };

/** 'path', './path', 'path/', 'path#Symbol' -> 'path' (repo-relative, POSIX, '' = root) */
export function normPath(p: string): string {
  return p
    .split('#')[0]!
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');
}

const ancestors = (p: string): string[] => {
  const parts = p ? p.split('/') : [];
  const out = [''];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
};
const within = (p: string, folder: string): boolean => folder === '' || p === folder || p.startsWith(`${folder}/`);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

interface Rec {
  node: GraphNode;
  flag: FlagResult | undefined;
  group: Group;
  anchors: string[];
}

class Tree implements TreeIndex {
  readonly folders: string[];
  private recs = new Map<string, Rec>();
  /** path -> ids of records (any group) scoped to it or below */
  private under = new Map<string, Set<string>>();
  private intents = new Map<string, IntentRecord>();
  private intentTenets = new Map<string, string[]>();
  private exceptions = new Map<string, string[]>();
  private replacedBy = new Map<string, string[]>();
  private traces = new Map<string, string[]>();
  private tenets = new Map<string, { title: string; flag: Flag }>();
  private decorations = new Map<string, Decoration | null>();
  private cards = new Map<string, IntentCard | null>();

  constructor(
    readonly root: string,
    input: TreeInput,
    private readonly summaries: Record<string, string>,
    private readonly reads: Record<string, ReadState>,
  ) {
    const flags = new Map(input.flags.map((f) => [f.id, f]));
    const folders = new Set<string>();
    for (const n of input.graph.nodes) {
      if (n.kind === 'tenet') this.tenets.set(n.id, { title: n.title, flag: flags.get(n.id)?.flag ?? (n.retired ? 'red' : 'green') });
      if (n.kind === 'intent') {
        const folder = normPath(n.scope[0]?.target ?? n.title);
        this.intentTenets.set(folder, input.graph.edges.filter((e) => e.from === n.id && e.type === 'traces_to').map((e) => e.to));
      }
      if (n.kind !== 'decision') continue;
      const group = groupOf(flags.get(n.id)?.status ?? n.status);
      if (!group) continue;
      const anchors = uniq(n.scope.map((a) => normPath(a.target)));
      if (anchors.length === 0) continue;
      this.recs.set(n.id, { node: n, flag: flags.get(n.id), group, anchors });
      for (const a of n.scope) {
        const p = normPath(a.target);
        const isFolder = a.target.split('#')[0]!.endsWith('/');
        for (const anc of ancestors(p)) {
          let s = this.under.get(anc);
          if (!s) this.under.set(anc, (s = new Set()));
          s.add(n.id);
          if (anc !== p || isFolder) folders.add(anc);
        }
      }
    }
    for (const e of input.graph.edges) {
      const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, uniq([...(m.get(k) ?? []), v]));
      if (e.type === 'overrides') push(this.exceptions, e.to, e.from);
      if (e.type === 'supersedes') push(this.replacedBy, e.to, e.from);
      if (e.type === 'traces_to') push(this.traces, e.from, e.to);
    }
    for (const i of input.intents ?? []) {
      const f = normPath(i.folder);
      this.intents.set(f, { ...i, folder: f });
      folders.add(f);
    }
    for (const f of this.intentTenets.keys()) folders.add(f);
    this.folders = [...folders].sort();
  }

  private hasRecords(p: string): boolean {
    return this.under.has(p) || this.intents.has(p) || this.intentTenets.has(p);
  }

  decoration(path: string): Decoration | undefined {
    const p = normPath(path);
    const hit = this.decorations.get(p);
    if (hit !== undefined) return hit ?? undefined;
    let out: Decoration | undefined;
    if (this.hasRecords(p)) {
      const force = [...(this.under.get(p) ?? [])].map((id) => this.recs.get(id)!).filter((r) => r.group === 'force');
      let flag: TreeFlag | undefined;
      for (const r of force) {
        const f = r.flag?.flag ?? 'green';
        if (f !== 'grey' && (!flag || RANK[f] > RANK[flag])) flag = f;
      }
      const card = this.card(p);
      out = {
        path: p,
        count: force.length,
        ...(flag ? { flag } : {}),
        ...(force.length > 0 ? { badge: force.length > 99 ? '99' : String(force.length) } : {}),
        tooltip: card ? formatCard(card) : '',
      };
    }
    this.decorations.set(p, out ?? null);
    return out;
  }

  private cardDecision(r: Rec, folder: string): CardDecision {
    const n = r.node;
    const reasons = r.flag?.reasons ?? [];
    const codes = new Set(reasons.map((x) => x.code));
    const evidence: EvidenceState = codes.has('evidence_failing')
      ? 'test failing'
      : codes.has('evidence_missing') && n.evidence.some((e) => e.test !== undefined)
        ? 'test missing'
        : n.evidence.some((e) => e.test !== undefined)
          ? 'tested'
          : n.evidence.some((e) => e.incident !== undefined)
            ? 'incident'
            : 'no test';
    const summary = this.summaries[n.id];
    return {
      id: n.id,
      title: n.title,
      status: n.status,
      flag: r.flag?.flag ?? (r.group === 'force' ? 'green' : 'grey'),
      anchors: r.anchors.filter((a) => within(a, folder)),
      evidence,
      exceptions: [...(this.exceptions.get(n.id) ?? [])].sort(),
      replacedBy: [...(this.replacedBy.get(n.id) ?? [])].sort(),
      reasons: reasons.map((x) => `${x.text} (${x.file}:${x.line})`),
      ...(summary ? { summary } : {}),
      ...(n.approver ? { approver: n.approver } : {}),
      file: n.file,
      line: n.line,
    };
  }

  card(path: string): IntentCard | undefined {
    const p = normPath(path);
    const hit = this.cards.get(p);
    if (hit !== undefined) return hit ?? undefined;
    let out: IntentCard | undefined;
    if (this.hasRecords(p)) {
      const recs = [...(this.under.get(p) ?? [])].map((id) => this.recs.get(id)!);
      const list = (g: Group) => recs.filter((r) => r.group === g).map((r) => this.cardDecision(r, p)).sort(byId);
      const decisions = list('force');
      const intent = this.intents.get(p);
      const tenetIds = uniq([...(intent?.tenets ?? []), ...(this.intentTenets.get(p) ?? []), ...decisions.flatMap((d) => (this.traces.get(d.id) ?? []).filter((t) => this.tenets.has(t)))]).sort();
      const ask = uniq([...(intent?.ask ?? []), ...decisions.map((d) => d.approver).filter((a): a is string => Boolean(a))]);
      const read = this.reads[p];
      out = {
        folder: p,
        ...(intent?.purpose ? { purpose: intent.purpose } : {}),
        ...(intent?.endState ? { endState: intent.endState } : {}),
        ...(intent?.risk ? { risk: intent.risk } : {}),
        ask,
        tenets: tenetIds.map((id) => ({ id, title: this.tenets.get(id)?.title ?? '', flag: this.tenets.get(id)?.flag ?? 'grey' })),
        decisions,
        proposed: list('proposed'),
        replaced: list('replaced'),
        ...(intent ? { intentFile: intent.file } : {}),
        ...(read ? { read } : {}),
      };
    }
    this.cards.set(p, out ?? null);
    return out;
  }

  /** decorated paths strictly below a folder, sorted */
  below(folder: string): string[] {
    const keys = new Set<string>([...this.under.keys(), ...this.intents.keys()]);
    return [...keys].filter((k) => k !== folder && within(k, folder)).sort();
  }

  private folderSet?: Set<string>;
  isFolder(p: string): boolean {
    return (this.folderSet ??= new Set(this.folders)).has(p);
  }
}

export function buildTree(input: TreeInput): TreeIndex {
  return new Tree(input.graph.root, input, input.summaries ?? {}, input.reads ?? {});
}

export function decorationFor(t: TreeIndex, path: string): Decoration | undefined {
  return t.decoration(path);
}

export function intentCard(t: TreeIndex, folder: string): IntentCard | undefined {
  return t.card(folder);
}

const label = (p: string) => (p === '' ? '(repo root)' : p);

function decisionLines(d: CardDecision, indent: string): string[] {
  const bits = [`${MARK[d.flag]} ${d.id} ${d.title}`];
  if (d.status !== 'accepted' && d.status !== 'superseded' && d.status !== 'proposed') bits.push(d.status);
  bits.push(d.evidence);
  if (d.exceptions.length > 0) bits.push(`exceptions: ${d.exceptions.join(', ')}`);
  if (d.anchors.length > 0) bits.push(d.anchors.join(', '));
  const out = [`${indent}${bits.join(' · ')}`];
  if (d.summary) out.push(`${indent}    why: ${d.summary}`);
  for (const r of d.reasons) out.push(`${indent}    ${d.flag === 'red' ? '✗' : '!'} ${r}`);
  return out;
}

/** The card as plain text (VS Code tooltip, M22 prompt). Only fields that have a record are written. */
export function formatCard(card: IntentCard, opts: { only?: (d: CardDecision) => boolean } = {}): string {
  const keep = opts.only ?? (() => true);
  const lines: string[] = [`${label(card.folder)}${card.intentFile ? `  (intent: ${card.intentFile})` : ''}`];
  if (card.purpose) lines.push(`Purpose: ${card.purpose}`);
  if (card.endState) lines.push(`End state: ${card.endState}`);
  if (card.risk) lines.push(`Risk accepted: ${card.risk}`);
  if (card.tenets.length > 0) lines.push(`Traces to: ${card.tenets.map((t) => `${t.id}${t.title ? ` "${t.title}"` : ''}${t.flag === 'red' ? ' (retired)' : ''}`).join(' · ')}`);
  const force = card.decisions.filter(keep);
  if (force.length > 0) {
    lines.push(`Decisions in force (${force.length}):`);
    for (const d of force) lines.push(...decisionLines(d, '  '));
  }
  const proposed = card.proposed.filter(keep);
  if (proposed.length > 0) {
    lines.push(`Proposed, not decided (${proposed.length}):`);
    for (const d of proposed) lines.push(`  ${MARK.grey} ${d.id} ${d.title}${d.anchors.length > 0 ? ` · ${d.anchors.join(', ')}` : ''}`);
  }
  const replaced = card.replaced.filter(keep);
  if (replaced.length > 0) {
    lines.push(`Replaced (${replaced.length}):`);
    for (const d of replaced) lines.push(`  ${MARK.red} ${d.id} ${d.title}${d.replacedBy.length > 0 ? ` → replaced by ${d.replacedBy.join(', ')}` : ` · ${d.status}`}`);
  }
  if (card.ask.length > 0) lines.push(`Who to ask: ${card.ask.join(', ')}`);
  if (card.read) {
    const r = card.read;
    const when = r.lastRead ? `read ${r.lastRead}` : 'not read yet';
    lines.push(`You: ${when}, ${r.explainedBack ? 'explained back' : 'not explained back yet'}`);
  }
  return lines.join('\n');
}

function badgeLine(t: TreeIndex, p: string, indent: string): string | undefined {
  const d = t.decoration(p);
  if (!d) return undefined;
  const name = p === '' ? '(repo root)' : `${p}${t instanceof Tree && t.isFolder(p) ? '/' : ''}`;
  const tag = d.flag ? `[${d.flag}] ` : '';
  const n = d.count > 0 ? `${d.badge} decision${d.count === 1 ? '' : 's'} in force` : 'no decision in force';
  return `${indent}${name}  ${tag}${n}`;
}

/**
 * The tree as text for one folder: a badge line for each decorated folder on the path from the root (and, with descendants, every
 * decorated path below it), then the cards: the folder's own card in full, and the intent cards of the folders on the path (their
 * decisions that are not already on the folder's card). Folders with no records do not appear.
 */
export function treeText(t: TreeIndex, folder: string, opts: { descendants?: boolean } = {}): string {
  const f = normPath(folder);
  const path = ancestors(f);
  const lines: string[] = [];
  path.forEach((p, i) => {
    const l = badgeLine(t, p, '  '.repeat(i));
    if (l) lines.push(l);
  });
  if (opts.descendants && t instanceof Tree)
    for (const p of t.below(f)) {
      const depth = p.split('/').length - (f ? f.split('/').length : 0);
      const l = badgeLine(t, p, '  '.repeat(path.length - 1 + depth));
      if (l) lines.push(l);
    }
  const cards: string[] = [];
  for (const p of path.slice(0, -1)) {
    const c = t.card(p);
    if (!c || !c.intentFile) continue;
    cards.push(formatCard(c, { only: (d) => !d.anchors.every((a) => within(a, f)) || d.anchors.length === 0 }));
  }
  const own = t.card(f);
  if (own && (f !== '' || own.intentFile)) cards.push(formatCard(own));
  if (opts.descendants && t instanceof Tree)
    for (const p of t.below(f)) {
      const c = t.card(p);
      if (c?.intentFile) cards.push(formatCard(c));
    }
  if (lines.length === 0 && cards.length === 0) return '';
  return [...lines, ...(cards.length > 0 ? ['', ...cards.flatMap((c, i) => (i === 0 ? [c] : ['', c]))] : [])].join('\n');
}

// ---- I/O: the intent records' fields and each decision's one-paragraph summary

const asList = (v: string | undefined, items: Array<{ value: string }> | undefined): string[] =>
  (items && items.length > 0 ? items.map((i) => i.value) : v ? v.split(',') : []).map((s) => s.trim()).filter(Boolean);

/** First paragraph under '## Decision' (else the first paragraph of the body), whitespace collapsed, at most 240 characters. */
export function summaryOf(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let start = 0;
  if ((lines[0] ?? '').trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    start = end < 0 ? lines.length : end + 1;
  }
  const dIdx = lines.findIndex((l, i) => i >= start && /^#{2,3}\s+decision\b/i.test(l));
  let i = dIdx >= 0 ? dIdx + 1 : start;
  const para: string[] = [];
  for (; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (/^#{1,6}\s/.test(l) || l.startsWith(':::') || l.startsWith('```')) {
      if (para.length > 0) break;
      continue;
    }
    if (!l) {
      if (para.length > 0) break;
      continue;
    }
    para.push(l);
  }
  const s = para.join(' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (s.length <= 240) return s;
  const cut = s.slice(0, 239);
  const sentence = cut.lastIndexOf('. ');
  if (sentence >= 80) return cut.slice(0, sentence + 1); // end on a whole sentence when one fits
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 200))}…`;
}

export function readTreeRecords(root: string, graph: DecisionGraph): { intents: IntentRecord[]; summaries: Record<string, string> } {
  const intents: IntentRecord[] = [];
  const summaries: Record<string, string> = {};
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(join(root, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  for (const n of graph.nodes) {
    if (n.kind === 'intent') {
      const text = read(n.file);
      const fm = text === undefined ? undefined : frontMatter(text, n.file);
      const fields = fm && !('error' in fm) ? fm.fields : undefined;
      const s = (k: string) => {
        const f = fields?.get(k);
        const v = f?.value ?? f?.items?.[0]?.value;
        return v && v.trim() ? v.trim() : undefined;
      };
      const folder = normPath(n.scope[0]?.target ?? n.title);
      const purpose = s('purpose');
      const endState = s('end_state') ?? s('end state') ?? s('endState');
      const risk = s('risk');
      intents.push({
        folder,
        file: n.file,
        ...(purpose ? { purpose } : {}),
        ...(endState ? { endState } : {}),
        ...(risk ? { risk } : {}),
        ask: asList(fields?.get('ask')?.value, fields?.get('ask')?.items),
        tenets: asList(fields?.get('tenets')?.value, fields?.get('tenets')?.items),
      });
    } else if (n.kind === 'decision') {
      const text = read(n.file);
      const sum = text === undefined ? undefined : summaryOf(text);
      if (sum) summaries[n.id] = sum;
    }
  }
  return { intents, summaries };
}

/** Records (files) + flags computed elsewhere (`mole decisions --json`, a cache) -> the tree index. */
export function loadTreeFrom(root: string, flags: FlagResult[], opts: TreeOptions = {}): TreeIndex {
  const graph = loadGraph(root, { adrDirs: opts.adrDirs });
  const { intents, summaries } = readTreeRecords(root, graph);
  return buildTree({ graph, flags, intents, summaries, reads: opts.reads });
}
