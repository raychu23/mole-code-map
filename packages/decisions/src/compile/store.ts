// Versioned storage for compile-at-capture drafts (T46): one JSON array per decision id under
// `<records>/.mole/decisions/compiled/<id>.json`, append-only (nothing is ever deleted, same rule as the tracking log).
// Approving a version MERGES its scope/match/rules into the decision record's own front matter (append + dedup,
// never replace: a person's earlier approvals are never silently dropped) and marks that version `approved`.
// Rejecting only ever touches the compiled-drafts file, never the record.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { CompiledDraft } from './types.js';

export const compiledDir = (recordsRoot: string): string => join(recordsRoot, '.mole', 'decisions', 'compiled');
export const compiledPath = (recordsRoot: string, id: string): string => join(compiledDir(recordsRoot), `${id}.json`);

export function listVersions(recordsRoot: string, id: string): CompiledDraft[] {
  const p = compiledPath(recordsRoot, id);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as CompiledDraft[];
}

function writeVersions(recordsRoot: string, id: string, versions: CompiledDraft[]): void {
  mkdirSync(compiledDir(recordsRoot), { recursive: true });
  writeFileSync(compiledPath(recordsRoot, id), `${JSON.stringify(versions, null, 2)}\n`);
}

/** Append a newly-drafted version (always `pending`); returns it with its assigned version number. */
export function saveDraft(recordsRoot: string, draft: Omit<CompiledDraft, 'version'>): CompiledDraft {
  const versions = listVersions(recordsRoot, draft.decision);
  const full: CompiledDraft = { ...draft, version: versions.length + 1 };
  writeVersions(recordsRoot, draft.decision, [...versions, full]);
  return full;
}

/** Latest version, or a specific one. */
export function getVersion(recordsRoot: string, id: string, version?: number): CompiledDraft | undefined {
  const versions = listVersions(recordsRoot, id);
  if (version !== undefined) return versions.find((v) => v.version === version);
  return versions[versions.length - 1];
}

function setStatus(recordsRoot: string, id: string, version: number, patch: Partial<CompiledDraft>): CompiledDraft {
  const versions = listVersions(recordsRoot, id);
  const idx = versions.findIndex((v) => v.version === version);
  if (idx < 0) throw new Error(`mole compile: ${id} has no draft version ${version}`);
  const next = { ...versions[idx]!, ...patch };
  versions[idx] = next;
  writeVersions(recordsRoot, id, versions);
  return next;
}

const dedupPush = (curr: unknown[], items: unknown[]): unknown[] => {
  const seen = new Set(curr.map((c) => JSON.stringify(c)));
  const out = [...curr];
  for (const it of items) {
    const k = JSON.stringify(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
};

export interface ApproveOptions {
  version?: number;
  approver: string;
}

/** Approve a draft version: merge its scope/match/rules into the record's own front matter and mark it approved.
 *  Throws if there is no such (pending or otherwise) version — approving twice is a no-op re-merge, not an error,
 *  so a reviewer can re-run it after fixing an unrelated front-matter edit. */
export function approveDraft(recordsRoot: string, id: string, opts: ApproveOptions): { recordPath: string; draft: CompiledDraft } {
  const draft = getVersion(recordsRoot, id, opts.version);
  if (!draft) throw new Error(`mole compile: ${id} has no draft to approve`);
  const recordPath = join(recordsRoot, draft.recordFile);
  const text = readFileSync(recordPath, 'utf8');
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') throw new Error(`${draft.recordFile}: no front matter to merge into`);
  let end = -1;
  for (let i = 1; i < lines.length; i++)
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  if (end < 0) throw new Error(`${draft.recordFile}: front matter is not closed with ---`);
  const fmText = lines.slice(1, end).join('\n');
  const bodyText = lines.slice(end + 1).join('\n');
  const doc = parseDocument(fmText);

  const mergeSeq = (key: string, items: unknown[]) => {
    if (!items.length) return;
    const existingNode = doc.get(key, true);
    const existing = Array.isArray((existingNode as { toJSON?: () => unknown } | undefined)?.toJSON?.())
      ? ((existingNode as { toJSON: () => unknown[] }).toJSON() as unknown[])
      : Array.isArray(doc.toJSON()?.[key])
        ? (doc.toJSON()[key] as unknown[])
        : [];
    doc.set(key, dedupPush(existing, items));
  };

  mergeSeq('scope', draft.scope);
  mergeSeq('match', draft.match);
  mergeSeq(
    'rules',
    draft.rules.map((r) => ({
      forbid: r.forbid,
      from: r.from,
      ...(r.to ? { to: r.to } : {}),
      ...(r.callee ? { callee: r.callee } : {}),
      ...(r.except ? { except: r.except } : {}),
      ...(r.why ? { why: r.why } : {}),
    })),
  );

  const newFm = doc.toString().replace(/\n+$/, '');
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `---\n${newFm}\n---\n${bodyText.replace(/^\n/, '')}`);
  const approved = setStatus(recordsRoot, id, draft.version, { status: 'approved', approvedBy: opts.approver, approvedAt: new Date().toISOString() });
  return { recordPath, draft: approved };
}

export interface RejectOptions {
  version?: number;
  reason: string;
}

/** Reject a draft version: marks it `rejected` with a reason; never touches the decision record. */
export function rejectDraft(recordsRoot: string, id: string, opts: RejectOptions): CompiledDraft {
  const draft = getVersion(recordsRoot, id, opts.version);
  if (!draft) throw new Error(`mole compile: ${id} has no draft to reject`);
  return setStatus(recordsRoot, id, draft.version, { status: 'rejected', rejectedReason: opts.reason, rejectedAt: new Date().toISOString() });
}

/** Every decision id that has at least one compiled-draft version, newest version last per id. */
export function allDrafts(recordsRoot: string): Record<string, CompiledDraft[]> {
  const dir = compiledDir(recordsRoot);
  if (!existsSync(dir)) return {};
  const out: Record<string, CompiledDraft[]> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    out[id] = listVersions(recordsRoot, id);
  }
  return out;
}
