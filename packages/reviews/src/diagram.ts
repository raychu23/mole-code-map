// T40 review view (PR Lens pattern, prlens.dev): a schema-checked JSON graph of the file tree, rendered
// deterministically -- same input gives the same picture byte for byte -- with the diff's delta colored and
// untouched parts grey. No model anywhere in this file.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Delta = 'changed' | 'unchanged';
export interface TreeNode {
  path: string; // '' for the root, else repo-relative, forward-slash
  kind: 'dir' | 'file';
  delta: Delta;
  children: string[]; // child paths, sorted
}
export interface TreeGraph {
  root: string;
  nodes: TreeNode[]; // DFS order, root first; directory listings sorted so the graph is deterministic
}

const SKIP = new Set(['node_modules', 'dist', '.git']);

/** Build the file-tree graph under `root`. `changedFiles` are repo-relative file paths (forward slash); a
 *  directory is 'changed' iff it contains at least one changed descendant (so the delta propagates upward,
 *  same as a PR diff view folding out to show you where the change lives). */
export function buildTreeGraph(root: string, changedFiles: string[]): TreeGraph {
  const changed = new Set(changedFiles.map((f) => f.replace(/\\/g, '/')));
  const nodes: TreeNode[] = [];
  const changedDirs = new Set<string>();
  for (const f of changed) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) changedDirs.add(parts.slice(0, i).join('/'));
  }

  function walk(relDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(join(root, relDir)).filter((e) => !e.startsWith('.') && !SKIP.has(e)).sort();
    } catch {
      entries = [];
    }
    const children: string[] = [];
    for (const name of entries) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = join(root, rel);
      const st = statSync(abs);
      children.push(rel);
      if (st.isDirectory()) walk(rel);
      else nodes.push({ path: rel, kind: 'file', delta: changed.has(rel) ? 'changed' : 'unchanged', children: [] });
    }
    const delta: Delta = relDir === '' ? (changedDirs.size > 0 || changed.size > 0 ? 'changed' : 'unchanged') : changedDirs.has(relDir) ? 'changed' : 'unchanged';
    nodes.push({ path: relDir, kind: 'dir', delta, children });
  }
  walk('');
  // root first, then the rest in a stable (path) order, so renderSvg's output never depends on fs iteration order
  nodes.sort((a, b) => {
    if (a.path === '' || b.path === '') return a.path === b.path ? 0 : a.path === '' ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return { root, nodes };
}

export interface DeltaColors {
  changed: string;
  unchanged: string;
}

/** Pure, deterministic SVG: no Date.now(), no Math.random(), no filesystem metadata (mtime etc). Rendering the
 *  same graph twice must produce byte-identical output (M34 part 2). */
export function renderSvg(graph: TreeGraph, colors: DeltaColors): string {
  const rowH = 18;
  const indent = 14;
  const width = 560;
  const rows = graph.nodes.map((n, i) => {
    const depth = n.path === '' ? 0 : n.path.split('/').length;
    const label = n.path === '' ? '(root)' : n.path.split('/').pop()!;
    const color = n.delta === 'changed' ? colors.changed : colors.unchanged;
    const y = i * rowH;
    const x = depth * indent;
    return (
      `<g class="node node-${n.kind}" data-path="${esc(n.path)}" data-delta="${n.delta}">` +
      `<rect x="${x}" y="${y}" width="${width - x}" height="${rowH - 2}" fill="${color}"/>` +
      `<text x="${x + 4}" y="${y + rowH - 6}" font-size="11">${esc(label)}</text>` +
      `</g>`
    );
  });
  const height = graph.nodes.length * rowH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rows.join('')}</svg>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
