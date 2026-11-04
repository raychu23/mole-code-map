// Argdown loader (T48): reads `.mole/arguments/**/*.argdown` files and ```argdown fenced code
// blocks inside `.mole/arguments/**/*.md` / `.mole/decisions/*.md`, turning Argdown's titled
// statements/arguments into `argument`-kind GraphNodes and its support/attack/undercut relations
// into GraphEdges -- "arguments in Markdown, in git, next to the design doc" (core-audit
// capture-records-schema.md rank 2's own cited verdict), using the same opt-in directory
// convention as the other loaders in this package (loadIntent, loadIncidents).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { GraphEdge, GraphNode, Problem } from '../types.js';
import { parseArgdown } from './parser.js';

const posix = (p: string) => p.split(sep).join('/');

/** Structural subset of graph.ts's Builder this loader needs (same pattern as import/speckit.ts). */
export interface GraphBuilder {
  readonly root: string;
  has(id: string): boolean;
  node(n: GraphNode): void;
  /** append definitions found in a later file/block for an id already in the graph (T60) */
  addDefinitions?(id: string, defs: Array<{ file: string; line: number; text: string }>): void;
  /** where an id already in the graph was first defined (T67: lets a duplicate-id Problem name both locations) */
  nodeLocation?(id: string): { file: string; line: number } | undefined;
  edge(e: GraphEdge): void;
  problems: Problem[];
}

const ARGUMENTS_DIR = '.mole/arguments';
const FENCE = /^```argdown\s*$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, exts: string[]): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (e.isFile() && exts.some((ext) => e.name.endsWith(ext))) out.push(p);
  }
  return out;
}

/** Every ```argdown fenced block in a markdown file, each with the file line its content starts at. */
function fencedBlocks(text: string): Array<{ body: string; startLine: number }> {
  const lines = text.split(/\r?\n/);
  const out: Array<{ body: string; startLine: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (FENCE.test((lines[i] ?? '').trim())) {
      const start = i + 2; // 1-based line of the first body line
      const body: string[] = [];
      i++;
      while (i < lines.length && (lines[i] ?? '').trim() !== '```') {
        body.push(lines[i]!);
        i++;
      }
      out.push({ body: body.join('\n'), startLine: start });
    }
    i++;
  }
  return out;
}

function applyParsed(b: GraphBuilder, file: string, offset: number, parsed: ReturnType<typeof parseArgdown>): void {
  for (const p of parsed.problems) b.problems.push({ file, line: p.line + offset - 1, message: p.message });
  for (const it of parsed.items) {
    const defs = it.definitions.map((d) => ({ file, line: d.line + offset - 1, text: d.text }));
    if (b.has(it.id)) {
      // T67: a bare cross-file reference to an already-defined title (no `: text` of its own) is
      // normal Argdown usage -- the same statement/argument reused across documents by design (the
      // parser's own header comment: "Argdown keys its statement/argument dictionaries by title") --
      // and stays silent. But a second `<title>: text` definition for the same id IS a real conflict
      // (two different texts claiming the same id) and must be reported, naming both locations,
      // instead of silently winning/losing with no signal (loader.ts used to just merge here).
      if (defs.length) {
        const first = b.nodeLocation?.(it.id);
        const where = first ? `${first.file}:${first.line}` : 'an earlier definition';
        b.problems.push({ file, line: defs[0]!.line, message: `duplicate argument id '${it.id}': also defined at ${where} (first kept; this definition appended to it)` });
        b.addDefinitions?.(it.id, defs);
      }
      continue;
    } // another record (or an earlier .argdown file) already defined this title: first one kept, same rule as graph.ts's Builder.node
    b.node({
      id: it.id,
      kind: 'argument',
      title: it.title,
      status: 'recorded',
      statusText: it.kind,
      format: 'argdown',
      file,
      line: it.line + offset - 1,
      scope: [],
      evidence: [],
      fields: { title: it.line + offset - 1 },
      definitions: defs,
    });
  }
  for (const r of parsed.relations) {
    const type = r.type === 'supports' ? 'supports' : r.type === 'attacks' ? 'attacks' : 'undercuts';
    b.edge({ from: r.from, to: r.to, type, file, line: r.line + offset - 1 });
  }
}

/** One call from graph.ts: `.mole/arguments/**​/*.argdown` files + ```argdown blocks in `.mole/arguments/**​/*.md` and `.mole/decisions/*.md`. */
export function loadArgdown(b: GraphBuilder): void {
  const dir = join(b.root, ARGUMENTS_DIR);
  for (const abs of walk(dir, ['.argdown'])) {
    const file = posix(relative(b.root, abs));
    const parsed = parseArgdown(readFileSync(abs, 'utf8'));
    applyParsed(b, file, 1, parsed);
  }
  const mdDirs = [dir, join(b.root, '.mole/decisions')];
  for (const mdDir of mdDirs) {
    for (const abs of walk(mdDir, ['.md'])) {
      const file = posix(relative(b.root, abs));
      for (const block of fencedBlocks(readFileSync(abs, 'utf8'))) {
        applyParsed(b, file, block.startLine, parseArgdown(block.body));
      }
    }
  }
  if (!existsSync(dir) && !existsSync(join(b.root, '.mole/decisions'))) return; // nothing to scan, not a problem
}
