// OKF v0.2 export (T72): writes Mole's decision graph (@mole/decisions graph.ts) as an Open Knowledge Format
// bundle, so another harness with no Mole tooling can still read provenance/trust/freshness/lifecycle for each
// record ((internal reference removed) log/prior-art.md has the fetched spec + the field-by-field justification for
// every key written below; nothing here is an invented field -- it is OKF SPEC.md §4/§5/§7/§12, verbatim).
import { Git } from '../anchors.js';
import type { DecisionGraph, GraphNode } from '../types.js';

export const OKF_VERSION = '0.2';

export interface OkfFile {
  /** bundle-relative path (posix), e.g. 'index.md' or 'decisions/D-1.md' */
  path: string;
  content: string;
}

export interface OkfBundle {
  files: OkfFile[];
}

const FLAGGED_KINDS = new Set(['decision', 'tenet', 'intent', 'incident']);

// SPEC.md §5.4: draft | stable | deprecated. Mole's richer vocabulary (proposed/accepted/superseded/deprecated/
// rejected/partly-superseded/retired/recorded/unknown) is lossy-mapped onto those three (prior-art.md §5); the
// original is never discarded -- it survives in the `mole_status` extension key (§4.1 "Extensions").
function okfStatus(moleStatus: string): 'draft' | 'stable' | 'deprecated' {
  if (moleStatus === 'accepted') return 'stable';
  if (moleStatus === 'proposed' || moleStatus === 'unknown') return 'draft';
  return 'deprecated'; // superseded | deprecated | rejected | partly-superseded | retired | recorded
}

// SPEC.md §4.1: `type` is the only always-required key, and "Type values are not registered centrally" -- a
// producer-chosen descriptive string. We use Mole's own node kind so a consumer can route/filter by it.
function okfType(kind: string): string {
  return `Mole ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function yamlScalar(v: string): string {
  // quote only when needed; SPEC.md examples use bare scalars for simple strings
  return /^[A-Za-z0-9/_.:-]+$/.test(v) ? v : JSON.stringify(v);
}

interface SourceEntry {
  id: string;
  resource: string;
  title?: string;
}

/** SPEC.md §5.1 `sources[]`: built from `source` (provenance) and `evidence` (prior-art.md §5: Mole's nearest
 *  evidence-backed analog to OKF's Attested Computation attestation family, exposed through the real `sources`
 *  field rather than an invented one). */
function sourcesOf(node: GraphNode): SourceEntry[] {
  const out: SourceEntry[] = [];
  if (node.source) out.push({ id: 'source', resource: node.source, title: 'origin document' });
  node.evidence.forEach((ev, i) => {
    const resource = ev.incident ? ev.incident : (ev.test ?? `${ev.file}:${ev.line}`);
    out.push({ id: `evidence-${i}`, resource, title: ev.incident ? 'incident evidence' : 'test evidence' });
  });
  return out;
}

function renderSources(sources: SourceEntry[]): string {
  if (sources.length === 0) return '';
  const lines = sources.map((s) => {
    const title = s.title ? `\n    title: ${yamlScalar(s.title)}` : '';
    return `  - id: ${yamlScalar(s.id)}\n    resource: ${yamlScalar(s.resource)}${title}`;
  });
  return `sources:\n${lines.join('\n')}\n`;
}

/** SPEC.md §7 actor convention: `human:<id>` for a person. Mole's `approver` field names the person who
 *  approved a decision (packages/decisions/src/compile/cli.ts `--approver NAME`), which is a person, not an
 *  agent or process -- so it is always written with the `human:` prefix (never bare). */
function actorOf(approver: string): string {
  return approver.startsWith('human:') || approver.startsWith('process:') || approver.includes('/') ? approver : `human:${approver}`;
}

/** SPEC.md §5.2 `generated`/`verified` (trust): `generated.by` is the actor (approver when present, else a
 *  generic export actor per §7's `<producer>/<version>` form); `generated.at` and `verified[].at` are the
 *  record file's git commit date (closest real "when was this last meaningfully changed" Mole tracks -- there
 *  is no separate `updated`/`as-of` frontmatter field to read, prior-art.md §5). Absent a git repo, both are
 *  omitted rather than guessed (never fabricated). */
function trustOf(node: GraphNode, root: string, git: Git): { generatedBy: string; generatedAt: string | undefined; verifiedAt: string | undefined } {
  const sha = node.confirmed && git.commit(node.confirmed) ? node.confirmed : (git.ok ? git.lastCommits([node.file]).get(node.file) : undefined);
  const at = sha ? (git.commitDate(sha) ?? undefined) : undefined;
  const generatedBy = node.approver ? actorOf(node.approver) : `mole-export/${OKF_VERSION}`;
  return { generatedBy, generatedAt: at, verifiedAt: node.approver ? at : undefined };
}

function renderConcept(node: GraphNode, root: string, git: Git): string {
  const sources = sourcesOf(node);
  const { generatedBy, generatedAt, verifiedAt } = trustOf(node, root, git);
  const fm: string[] = [];
  fm.push(`type: ${yamlScalar(okfType(node.kind))}`);
  fm.push(`title: ${yamlScalar(node.title)}`);
  fm.push(`resource: ${yamlScalar(`/${node.file}`)}`);
  fm.push(`status: ${okfStatus(node.status)}`);
  fm.push(`mole_status: ${yamlScalar(node.status)}`); // §4.1 Extensions: preserve the lossy mapping's input
  if (sources.length > 0) fm.push(renderSources(sources).trimEnd());
  const genAt = generatedAt ? `, at: ${generatedAt}` : '';
  fm.push(`generated: { by: ${generatedBy}${genAt} }`);
  if (node.approver) {
    const verAt = verifiedAt ? `, at: ${verifiedAt}` : '';
    fm.push(`verified: { by: ${actorOf(node.approver)}${verAt} }`);
  }
  const body = [`# ${node.title}`, '', node.statusText ? `Mole status: ${node.statusText}` : `Mole status: ${node.status}`];
  if (sources.length > 0) {
    body.push('', '# Sources');
    for (const s of sources) body.push(`- [${s.title ?? s.id}](${s.resource})`);
  }
  return `---\n${fm.join('\n')}\n---\n\n${body.join('\n')}\n`;
}

function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Build an OKF v0.2 bundle (§3 bundle structure) from a Mole decision graph: one concept document per
 *  decision/tenet/intent/incident node, plus a bundle-root `index.md` carrying `okf_version` (§12) and a
 *  directory listing (§8). Pure function -- no filesystem writes; `exportCli` in cli.ts does the I/O. */
export function buildOkfBundle(graph: DecisionGraph, root: string): OkfBundle {
  const git = new Git(root);
  const nodes = graph.nodes.filter((n) => FLAGGED_KINDS.has(n.kind));
  const files: OkfFile[] = nodes.map((n) => ({ path: `${slug(n.id)}.md`, content: renderConcept(n, root, git) }));
  const index = [
    '---',
    `okf_version: "${OKF_VERSION}"`,
    '---',
    '',
    '# Mole decision graph export',
    '',
    // T72 review: never the absolute root (a machine-local path); the bundle is meant to travel
    `Exported from the repository's .mole records by \`mole export --format okf\` (T72). Source spec:`,
    'https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md',
    '',
    '# Concepts',
    '',
    ...files.map((f, i) => `* [${nodes[i]!.title}](${f.path}) - ${nodes[i]!.id} (${nodes[i]!.kind})`),
  ].join('\n');
  return { files: [{ path: 'index.md', content: `${index}\n` }, ...files] };
}
