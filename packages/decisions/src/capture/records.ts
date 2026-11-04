import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { frontMatter } from '../graph.js';

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const STATUSES = new Set(['proposed', 'accepted', 'superseded', 'deprecated', 'rejected']);

export type NewDecisionInput = {
  id: string;
  title: string;
  status?: string;
  body?: string;
};

export type CaptureResult = { file: string; suggestions: [] };
export type TransactionEntry = { target: string; text: string };
type StoredTransaction = { version: 1; entries: Array<{ target: string; backup: string }> };

export class CaptureError extends Error {}

function decisionDir(root: string): string {
  return resolve(root, '.mole', 'decisions');
}

function recordPath(root: string, id: string): string {
  if (!ID_PATTERN.test(id) || id === '.' || id === '..') throw new CaptureError(`invalid decision id: ${id}`);
  const dir = decisionDir(root);
  const file = resolve(dir, `${id}.md`);
  if (dirname(file) !== dir || relative(dir, file).split(sep).includes('..')) throw new CaptureError(`unsafe decision id: ${id}`);
  return file;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderNew(input: Required<Pick<NewDecisionInput, 'id' | 'title' | 'status'>> & Pick<NewDecisionInput, 'body'>): string {
  return `---\nid: '${input.id}'\ntitle: ${yamlString(input.title)}\nstatus: ${input.status}\n---\n\n## Decision\n\n${input.body ?? ''}`;
}

function writeNewExclusive(file: string, text: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncPath(file: string): void {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readDecision(root: string, id: string): { file: string; text: string; status: string } {
  const file = recordPath(root, id);
  if (!existsSync(file)) throw new CaptureError(`record not found: .mole/decisions/${id}.md`);
  const text = readFileSync(file, 'utf8');
  const fm = frontMatter(text, `.mole/decisions/${id}.md`);
  if (!fm || 'error' in fm) throw new CaptureError(`malformed record: .mole/decisions/${id}.md`);
  const actual = fm.fields.get('id')?.value ?? fm.fields.get('id')?.items?.[0]?.value;
  if (actual !== id) throw new CaptureError(`record id does not match its filename: .mole/decisions/${id}.md`);
  const status = fm.fields.get('status')?.value ?? fm.fields.get('status')?.items?.[0]?.value;
  if (!status || !STATUSES.has(status)) throw new CaptureError(`invalid status in .mole/decisions/${id}.md`);
  return { file, text, status };
}

/** Every `.mole/decisions/*.md` record as {id, title, body} for duplicate suggestions. Read-only. A record whose
 *  front matter is missing or has no id/title is an error naming the file, never a silent skip. */
export function readDecisionRecords(root: string): Array<{ id: string; title: string; body: string }> {
  const dir = decisionDir(root);
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; title: string; body: string }> = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const rel = `.mole/decisions/${name}`;
    const text = readFileSync(join(dir, name), 'utf8');
    const fm = frontMatter(text, rel);
    const field = (k: string) => (fm && !('error' in fm) ? fm.fields.get(k)?.value ?? fm.fields.get(k)?.items?.[0]?.value : undefined);
    const id = field('id');
    const title = field('title');
    if (!fm || 'error' in fm || !id || !title) throw new CaptureError(`malformed record (needs front matter with id and title): ${rel}`);
    const lines = text.split(/\r?\n/);
    const close = lines.indexOf('---', 1);
    // the body as written, minus the template's own '## Decision' heading (renderNew), so an identical import matches exactly
    const body = close > 0 ? lines.slice(close + 1).filter((l) => !/^#{1,3}\s*decision\s*$/i.test(l.trim())).join('\n').trim() : '';
    out.push({ id, title, body });
  }
  return out;
}

function replaceField(text: string, key: string, rendered: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new CaptureError('record has no front matter');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 0) throw new CaptureError('record front matter is not closed');
  const at = lines.findIndex((line, index) => index > 0 && index < end && line.startsWith(`${key}:`));
  if (at < 0) lines.splice(end, 0, rendered);
  else {
    let after = at + 1;
    while (after < end && /^\s/.test(lines[after] ?? '')) after++;
    lines.splice(at, after - at, rendered);
  }
  return lines.join('\n');
}

function addRelation(text: string, key: string, id: string): string {
  const fm = frontMatter(text, 'record');
  if (!fm || 'error' in fm) throw new CaptureError('malformed record');
  const old = (fm.fields.get(key)?.items ?? []).map((x) => x.value).filter(Boolean);
  return replaceField(text, key, `${key}: [${[...new Set([...old, id])].join(', ')}]`);
}

function transactionRoot(root: string): string {
  return join(decisionDir(root), '.capture-txn');
}

/** Stages replacements plus backups before explicit same-filesystem renames. A failed commit
 * deliberately remains recoverable through `recoverTransactions`, never silently partial. */
export function applyRecordTransaction(root: string, entries: TransactionEntry[], opts: { failAfter?: number } = {}): void {
  if (entries.length === 0) return;
  const dir = decisionDir(root);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (dirname(entry.target) !== dir || !existsSync(entry.target)) throw new CaptureError('transaction target is not an existing decision record');
    if (seen.has(entry.target)) throw new CaptureError('transaction has duplicate target');
    seen.add(entry.target);
  }
  mkdirSync(transactionRoot(root), { recursive: true });
  const txn = mkdtempSync(join(transactionRoot(root), 'txn-'));
  const staged = join(txn, 'staged');
  const backups = join(txn, 'backups');
  mkdirSync(staged);
  mkdirSync(backups);
  const manifest: StoredTransaction = { version: 1, entries: [] };
  for (const [index, entry] of entries.entries()) {
    const target = basename(entry.target);
    const backup = `${index}.before`;
    copyFileSync(entry.target, join(backups, backup));
    syncPath(join(backups, backup));
    writeNewExclusive(join(staged, `${index}.after`), entry.text);
    manifest.entries.push({ target, backup });
  }
  writeNewExclusive(join(txn, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  for (const [index, entry] of entries.entries()) {
    if (opts.failAfter === index) throw new CaptureError('transaction failed; run mole decision recover');
    renameSync(join(staged, `${index}.after`), entry.target);
  }
  rmSync(txn, { recursive: true, force: true });
}

/** Restores incomplete capture transactions exactly to their before-state. */
export function recoverTransactions(root: string): number {
  const dir = decisionDir(root);
  const txRoot = transactionRoot(root);
  if (!existsSync(txRoot)) return 0;
  let recovered = 0;
  for (const name of readdirSync(txRoot).sort()) {
    const txn = join(txRoot, name);
    const manifestPath = join(txn, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: StoredTransaction;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoredTransaction;
    } catch {
      throw new CaptureError(`cannot recover malformed transaction: ${name}`);
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new CaptureError(`cannot recover malformed transaction: ${name}`);
    for (const entry of manifest.entries) {
      if (basename(entry.target) !== entry.target || basename(entry.backup) !== entry.backup) throw new CaptureError(`cannot recover unsafe transaction: ${name}`);
      const target = resolve(dir, entry.target);
      if (dirname(target) !== dir) throw new CaptureError(`cannot recover unsafe transaction: ${name}`);
      copyFileSync(join(txn, 'backups', entry.backup), target);
      syncPath(target);
    }
    rmSync(txn, { recursive: true, force: true });
    recovered++;
  }
  return recovered;
}

export function newDecision(root: string, input: NewDecisionInput): CaptureResult {
  if (!input.title.trim()) throw new CaptureError('title is required');
  if (/\r|\n/.test(input.title)) throw new CaptureError('title must be one line');
  const status = input.status ?? 'proposed';
  if (!STATUSES.has(status)) throw new CaptureError(`invalid status: ${status}`);
  const file = recordPath(root, input.id);
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) throw new CaptureError(`record already exists: .mole/decisions/${input.id}.md`);
  try {
    writeNewExclusive(file, renderNew({ ...input, status }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CaptureError(`record already exists: .mole/decisions/${input.id}.md`);
    throw error;
  }
  return { file: `.mole/decisions/${input.id}.md`, suggestions: [] };
}

export function supersedeDecision(root: string, oldId: string, newId: string): void {
  if (oldId === newId) throw new CaptureError('old and new decision ids must differ');
  const oldRecord = readDecision(root, oldId);
  const newRecord = readDecision(root, newId);
  if (oldRecord.status !== 'accepted' || newRecord.status !== 'accepted') throw new CaptureError('supersede requires accepted old and new records');
  applyRecordTransaction(root, [
    { target: oldRecord.file, text: addRelation(replaceField(oldRecord.text, 'status', 'status: superseded'), 'superseded_by', newId) },
    { target: newRecord.file, text: addRelation(newRecord.text, 'supersedes', oldId) },
  ]);
}

const RECIPROCAL_RELATIONS: Record<string, string> = {
  amends: 'amended_by',
  overrides: 'overridden_by',
};

/** Links two existing records using only the reciprocal field pairs the graph loader understands. */
export function linkDecisions(root: string, fromId: string, toId: string, relation: string): void {
  if (fromId === toId) throw new CaptureError('from and to decision ids must differ');
  const reverse = RECIPROCAL_RELATIONS[relation];
  if (!reverse) throw new CaptureError(`unsupported reciprocal relation: ${relation}`);
  const from = readDecision(root, fromId);
  const to = readDecision(root, toId);
  applyRecordTransaction(root, [
    { target: from.file, text: addRelation(from.text, relation, toId) },
    { target: to.file, text: addRelation(to.text, reverse, fromId) },
  ]);
}
