// spec-kit importer (T36): GitHub spec-kit (github.com/github/spec-kit) projects keep decisions in
// .specify/memory/constitution.md (Core Principles -> tenets) and specs/NNN-*/research.md (## D-NNN: Title
// decision + rationale blocks -> decisions), with spec.md giving each feature's lifecycle status/date.
// Zero new documentation work: a team already running /speckit.constitution + /speckit.specify gets Mole's
// flags/hover/view on exactly the records speckit already wrote, nothing added.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Anchor, GraphEdge, GraphNode, Problem } from '../types.js';

const posix = (p: string) => p.split(sep).join('/');

/** Same status words as graph.ts's normStatus (duplicated, not imported, to avoid a graph.ts <-> import/speckit.ts cycle). */
function normStatus(text: string | undefined): string {
  const s = (text ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (/^(partly|partially)\s+superseded/.test(s)) return 'partly-superseded';
  if (/^superseded/.test(s)) return 'superseded';
  if (/^deprecated/.test(s)) return 'deprecated';
  if (/^(accepted|approved|adopted|agreed|decided|done)\b/.test(s)) return 'accepted';
  if (/^(proposed|pending|draft|open|in review|under review)\b/.test(s)) return 'proposed';
  if (/^(rejected|declined|withdrawn)\b/.test(s)) return 'rejected';
  if (/^retired/.test(s)) return 'retired';
  return 'unknown';
}

/** Structural subset of graph.ts's Builder the importer needs (kept narrow so import/** never reaches into graph.ts internals). */
export interface GraphBuilder {
  readonly root: string;
  has(id: string): boolean;
  node(n: GraphNode): void;
  edge(e: GraphEdge): void;
  problems: Problem[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Path-like backtick spans (`a/b.ext` or `a/b/`), excluding API routes (`/api/...`) and bare filenames with no directory. */
const PATH_SPAN = /`([^`\s][^`]*)`/g;
function pathCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_SPAN)) {
    const tok = m[1]!.trim();
    if (!tok) continue;
    if (tok.startsWith('/')) continue; // API route (`/api/...`), not a file path
    if (!tok.includes('/')) continue; // bare filename/class/identifier: too ambiguous to anchor
    out.push(tok.replace(/\*+$/, '')); // strip a trailing glob (`dir/**` -> `dir/`)
  }
  return out;
}

/** Anchor a decision to the code paths it names, keeping only ones that exist in the project (precision over recall: T36 M29b). */
function resolveAnchors(root: string, file: string, line: number, text: string): Anchor[] {
  const out: Anchor[] = [];
  const seen = new Set<string>();
  for (const tok of pathCandidates(text)) {
    const clean = tok.replace(/^\.\//, '');
    if (seen.has(clean)) continue;
    const abs = join(root, clean);
    const isDirTarget = clean.endsWith('/') || isDir(abs);
    if (isDirTarget ? isDir(abs) : isFile(abs)) {
      seen.add(clean);
      out.push({ target: isDirTarget && !clean.endsWith('/') ? `${clean}/` : clean, file, line });
    }
  }
  return out;
}

function mdFile(root: string, rel: string): { text: string; abs: string } | undefined {
  const abs = join(root, rel);
  if (!isFile(abs)) return undefined;
  return { text: readFileSync(abs, 'utf8'), abs };
}

/** `.specify/memory/constitution.md`'s `### N. Name` headings under `## Core Principles` -> tenet nodes. */
function loadConstitution(b: GraphBuilder): void {
  const rel = '.specify/memory/constitution.md';
  const f = mdFile(b.root, rel);
  if (!f) return;
  const lines = f.text.split(/\r?\n/);
  const coreIdx = lines.findIndex((l) => /^##\s+Core Principles/i.test(l.trim()));
  if (coreIdx < 0) {
    b.problems.push({ file: rel, line: 1, message: 'spec-kit constitution has no "## Core Principles" section' });
    return;
  }
  const versionLine = lines.findIndex((l) => /\*\*Version\*\*/i.test(l));
  const vm = versionLine >= 0 ? /\*\*Version\*\*:\s*([\d.]+)/i.exec(lines[versionLine]!) : null;
  const confirmed = versionLine >= 0 ? /\*\*Last Amended\*\*:\s*([\d-]+)/i.exec(lines[versionLine]!)?.[1] : undefined;
  let i = coreIdx + 1;
  let any = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (/^##\s+(?!#)/.test(l) && i > coreIdx) break; // next top-level section ends Core Principles
    const m = /^###\s+(?:[IVXLC]+\.|\d+\.)?\s*(.+?)\s*$/.exec(l);
    if (m) {
      any = true;
      const rawTitle = m[1]!.replace(/\s*\(NON-NEGOTIABLE\)\s*$/i, '').trim();
      const nonNegotiable = /\(NON-NEGOTIABLE\)/i.test(m[1]!);
      const slug = rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const id = `speckit-tenet:${slug}`;
      if (b.has(id)) {
        b.problems.push({ file: rel, line: i + 1, message: `duplicate spec-kit principle id ${id} (first one kept)` });
      } else {
        b.node({
          id,
          kind: 'tenet',
          title: rawTitle,
          status: 'accepted', // a ratified constitution principle is accepted until amended
          statusText: vm ? `ratified ${vm[1]}` : undefined,
          format: 'speckit',
          confirmed,
          source: rel,
          file: rel,
          line: i + 1,
          retired: false,
          scope: [],
          evidence: [],
          fields: { heading: i + 1, ...(nonNegotiable ? { non_negotiable: i + 1 } : {}) },
        });
      }
    }
    i++;
  }
  if (!any) b.problems.push({ file: rel, line: coreIdx + 1, message: 'spec-kit constitution Core Principles has no "### Name" headings' });
}

/** one `specs/NNN-xxx` feature folder: spec.md gives Status/Created/title, research.md's `## D-NNN:` blocks are the decisions. */
function loadFeature(b: GraphBuilder, dir: string): void {
  const slug = dir.split('/').pop()!;
  const specRel = `${dir}/spec.md`;
  const spec = mdFile(b.root, specRel);
  let statusText: string | undefined;
  let created: string | undefined;
  if (spec) {
    statusText = /\*\*Status\*\*:\s*(.+?)\s*$/m.exec(spec.text)?.[1];
    created = /\*\*Created\*\*:\s*([\d-]+)/.exec(spec.text)?.[1];
  }
  const researchRel = `${dir}/research.md`;
  const research = mdFile(b.root, researchRel);
  if (!research) return; // a feature with no research.md has no decisions to import (spec/plan alone carry no D-NNN)
  if (!created) created = /\*\*Date\*\*:\s*([\d-]+)/.exec(research.text)?.[1];
  const lines = research.text.split(/\r?\n/);
  const heads: Array<{ id: string; title: string; line: number }> = [];
  lines.forEach((l, i) => {
    const m = /^##\s+(D-\d+)\s*:\s*(.+?)\s*$/.exec(l);
    if (m) heads.push({ id: m[1]!, title: m[2]!, line: i + 1 });
  });
  if (heads.length === 0) return;
  const status = normStatus(statusText);
  for (let h = 0; h < heads.length; h++) {
    const cur = heads[h]!;
    const next = heads[h + 1];
    const end = next ? next.line - 1 : lines.length;
    const body = lines.slice(cur.line, end).join('\n');
    const id = `speckit:${slug}:${cur.id}`;
    if (b.has(id)) {
      b.problems.push({ file: researchRel, line: cur.line, message: `duplicate spec-kit decision id ${id} (first one kept)` });
      continue;
    }
    const scope = resolveAnchors(b.root, researchRel, cur.line, body);
    b.node({
      id,
      kind: 'decision',
      title: cur.title,
      status,
      statusText,
      format: 'speckit',
      confirmed: created,
      source: researchRel,
      file: researchRel,
      line: cur.line,
      scope,
      evidence: [],
      fields: { title: cur.line, status: cur.line, date: cur.line }, // status/date are read from spec.md/research.md's header, not a per-D field; both point at the D- heading of this record
    });
    for (const a of scope) b.edge({ from: id, to: a.target, type: 'applies_to', file: researchRel, line: a.line });
  }
}

/** Scan `specs/*` for spec-kit feature folders (spec.md present) and import constitution.md's principles. One call from graph.ts. */
export function loadSpecKit(b: GraphBuilder): void {
  loadConstitution(b);
  const specsDir = join(b.root, 'specs');
  if (!isDir(specsDir)) return;
  for (const e of readdirSync(specsDir, { withFileTypes: true }).sort((a, b2) => (a.name < b2.name ? -1 : a.name > b2.name ? 1 : 0))) {
    if (!e.isDirectory()) continue;
    const dir = posix(relative(b.root, join(specsDir, e.name)));
    if (!existsSync(join(b.root, dir, 'spec.md')) && !existsSync(join(b.root, dir, 'research.md'))) continue; // not a spec-kit feature folder
    loadFeature(b, dir);
  }
}
