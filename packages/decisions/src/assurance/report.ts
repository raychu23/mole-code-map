// T78 (D65): per-link assurance on `door: one-way` decisions only. See `GraphNode.door` (graph.ts) --
// door is a human-authored front-matter string; this module NEVER infers it (prior-art.md: Mole has no
// door classifier, and 0/146 real vendored ADRs carry a door field at all). A record with no
// `door: one-way` is simply outside assurance's scope.
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { frontMatter, loadGraph } from '../graph.js';
import {
  ALCOA_PLUS_ATTRS,
  type AlcoaAttr,
  type AssuranceFolder,
  type AssuranceLink,
  type AssuranceMalformed,
  type AssuranceReport,
  type DoubtType,
  type Provenance,
} from '../types.js';

const posix = (p: string) => p.split(sep).join('/');

const DOUBT_TYPES: ReadonlySet<string> = new Set<DoubtType>(['rebutting', 'undermining', 'undercutting']);
const PROVENANCES: ReadonlySet<string> = new Set<Provenance>(['person', 'compiler', 'model']);

/** True only for a real ISO calendar date `YYYY-MM-DD` -- rejects both non-date strings ('not-a-date')
 * and dates that are the right shape but don't exist (2026-02-30: Date's own rollover would otherwise
 * silently turn that into 2026-03-02). */
// T81: exported so outcomes/report.ts (prediction check_at / outcome date) reuses this instead of a second
// ISO-date validator (T78 learned the hard way: reject non-ISO AND calendar-invalid dates like 2026-02-30).
export function isValidIsoDate(raw: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function parseAlcoa(raw: string | undefined): AlcoaAttr[] {
  if (!raw) return [];
  const have = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return ALCOA_PLUS_ATTRS.filter((a) => have.has(a));
}

/** Reads the `assurance:` front-matter list of one `.mole/decisions/*.md` record. Returns one
 * AssuranceLink per list item with a `to` field (it says which link this entry assures), plus every
 * rejected field value as an AssuranceMalformed -- an entry with no `to` is listed as malformed rather
 * than silently dropped, and an invalid doubt/provenance/reverify_by is dropped from the link (so it
 * can never count as assured) but still recorded with the value that was rejected and why. */
export function parseAssurance(text: string, file: string, decisionId: string): { links: AssuranceLink[]; malformed: AssuranceMalformed[] } {
  const fm = frontMatter(text, file);
  if (!fm || 'error' in fm) return { links: [], malformed: [] };
  const field = fm.fields.get('assurance');
  const links: AssuranceLink[] = [];
  const malformed: AssuranceMalformed[] = [];
  // `assurance:` written as a mapping (one entry without the leading `-`) is an attempted entry, not "none":
  // report it instead of treating the record as having no assurance block (T78 review 2).
  if (field && !field.items && field.map) {
    malformed.push({ decisionId, to: field.map.to ?? '(missing)', field: 'assurance', value: '(mapping)', reason: 'assurance must be a list of entries (`- to: ...`), not a mapping', file, line: field.line });
  }
  for (const item of field?.items ?? []) {
    const m = item.map;
    if (!m?.to) {
      malformed.push({ decisionId, to: '(missing)', field: 'to', value: '', reason: 'assurance entry has no `to` target', file, line: item.line });
      continue;
    }
    const to = m.to;
    let doubt: DoubtType | undefined;
    if (m.doubt !== undefined) {
      if (DOUBT_TYPES.has(m.doubt)) doubt = m.doubt as DoubtType;
      else malformed.push({ decisionId, to, field: 'doubt', value: m.doubt, reason: `not a recognized doubt type (${[...DOUBT_TYPES].join('|')})`, file, line: item.line });
    }
    let provenance: Provenance | undefined;
    if (m.provenance !== undefined) {
      if (PROVENANCES.has(m.provenance)) provenance = m.provenance as Provenance;
      else malformed.push({ decisionId, to, field: 'provenance', value: m.provenance, reason: `not a recognized provenance (${[...PROVENANCES].join('|')})`, file, line: item.line });
    }
    let reverifyBy: string | undefined;
    if (m.reverify_by !== undefined) {
      if (isValidIsoDate(m.reverify_by)) reverifyBy = m.reverify_by;
      else malformed.push({ decisionId, to, field: 'reverify_by', value: m.reverify_by, reason: 'not a real ISO calendar date (YYYY-MM-DD)', file, line: item.line });
    }
    links.push({ to, doubt, provenance, author: m.author, approver: m.approver, alcoa: parseAlcoa(m.alcoa), reverifyBy, file, line: item.line });
  }
  return { links, malformed };
}

function isAssured(link: AssuranceLink, today: string): boolean {
  if (!link.doubt || !link.provenance) return false;
  if (!link.author || !link.approver || link.author === link.approver) return false;
  if (link.alcoa.length !== ALCOA_PLUS_ATTRS.length) return false;
  if (!link.reverifyBy || link.reverifyBy < today) return false;
  return true;
}

export interface AssuranceOptions {
  /** restrict to decision records whose file lives under this repo-relative folder */
  folder?: string;
  /** ISO date to treat as "today" for overdue checks; defaults to the real clock */
  today?: string;
}

type Slot = { decisionId: string; link: AssuranceLink };

/** The folder(s) a decision governs: one per `scope:` anchor ('folder/' as-is, 'path' or
 * 'path#Symbol' reduced to its directory), or the record file's own folder when there is no scope --
 * a one-way door decision always lands in at least one folder, never silently uncounted. */
function governedFolders(scopeTargets: string[], recordFile: string): string[] {
  if (scopeTargets.length === 0) return [posix(dirname(recordFile))];
  const folders = scopeTargets.map((t) => {
    const clean = t.replace(/#.*$/, '');
    return posix(clean.endsWith('/') ? clean.slice(0, -1) : dirname(clean));
  });
  return [...new Set(folders)];
}

/** `mole assurance [--folder X] [--json]`: assured share of door: one-way decisions, grouped by the
 * folder(s) they govern (their `scope:` anchors), plus every overdue re-verification. Read-only, no
 * model call -- see this file's header for why door is never inferred. */
export function assuranceReport(root: string, opts: AssuranceOptions = {}): AssuranceReport {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const wantFolder = opts.folder ? posix(opts.folder).replace(/\/$/, '') : undefined;
  const graph = loadGraph(root);
  const byFolder = new Map<string, { oneWayDoors: number; slots: Slot[] }>();
  const allMalformed: AssuranceMalformed[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'decision' || n.door !== 'one-way') continue;
    const folders = governedFolders(n.scope.map((a) => a.target), n.file).filter((f) => !wantFolder || f === wantFolder);
    if (folders.length === 0) continue;
    let text: string;
    try {
      text = readFileSync(resolve(root, n.file), 'utf8');
    } catch {
      continue; // an unreadable file would already be a graph problem; this report doesn't duplicate that
    }
    const { links, malformed: linkMalformed } = parseAssurance(text, n.file, n.id);
    // malformed field values are a per-report list, recorded once per decision -- not duplicated for
    // every folder a decision happens to govern (see types.ts AssuranceMalformed doc comment).
    allMalformed.push(...linkMalformed);
    const slots: Slot[] = links.length
      ? links.map((link) => ({ decisionId: n.id, link }))
      // an unassured one-way door with no `assurance:` entries at all is one unassured slot, not zero
      : [{ decisionId: n.id, link: { to: '(none)', alcoa: [], file: n.file, line: n.line } }];
    for (const folder of folders) {
      const bucket = byFolder.get(folder) ?? { oneWayDoors: 0, slots: [] };
      bucket.oneWayDoors++;
      bucket.slots.push(...slots);
      byFolder.set(folder, bucket);
    }
  }
  const folders: AssuranceFolder[] = [];
  let totalOneWayDoors = 0;
  let totalLinks = 0;
  let totalAssured = 0;
  for (const [folder, bucket] of [...byFolder.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let assured = 0;
    const overdue: AssuranceFolder['overdue'] = [];
    for (const { decisionId, link } of bucket.slots) {
      if (isAssured(link, today)) assured++;
      if (link.reverifyBy && link.reverifyBy < today) overdue.push({ decisionId, to: link.to, reverifyBy: link.reverifyBy, file: link.file, line: link.line });
    }
    folders.push({ folder, oneWayDoors: bucket.oneWayDoors, links: bucket.slots.length, assured, assuredShare: bucket.slots.length ? assured / bucket.slots.length : 0, overdue });
    totalOneWayDoors += bucket.oneWayDoors;
    totalLinks += bucket.slots.length;
    totalAssured += assured;
  }
  return { root, generatedAt: new Date().toISOString(), folders, totalOneWayDoors, totalLinks, totalAssured, assuredShare: totalLinks ? totalAssured / totalLinks : 0, malformed: allMalformed };
}

function formatAssurance(r: AssuranceReport): string {
  const out: string[] = [];
  if (r.folders.length === 0) out.push('mole assurance: no door: one-way decision records found');
  for (const f of r.folders) {
    out.push(`${f.folder}  one-way=${f.oneWayDoors}  links=${f.links}  assured=${f.assured}/${f.links} (${(f.assuredShare * 100).toFixed(0)}%)`);
    for (const o of f.overdue) out.push(`  overdue  ${o.decisionId} -> ${o.to}  reverify_by ${o.reverifyBy}  ${o.file}:${o.line}`);
  }
  out.push(`total: ${r.totalAssured}/${r.totalLinks} assured (${(r.assuredShare * 100).toFixed(0)}%) across ${r.totalOneWayDoors} one-way door record(s)`);
  if (r.malformed.length) {
    out.push(`malformed (${r.malformed.length}):`);
    for (const m of r.malformed) out.push(`  ${m.decisionId} -> ${m.to}  ${m.field}=${m.value || '(empty)'}  ${m.reason}  ${m.file}:${m.line}`);
  }
  return out.join('\n');
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** CLI entry used by packages/daemon/src/cli.ts. */
export function assuranceCli(_pos: string[], flags: Record<string, string | true>, root: string): number {
  const r = assuranceReport(root, { folder: str(flags.folder) });
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatAssurance(r));
  return 0;
}
