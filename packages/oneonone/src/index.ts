// @mole/oneonone: T31, the 1:1 loop + read-back (M23 code half). Questions a person logs via the hover
// 'Ask' affordance are grouped by FOLDER, never by person (D31/M23 non-goal: no per-person scoring), and
// matched against existing records (decisions, docs, this project's own planning pages) that may already
// answer them. A record match is deterministic keyword/overlap scoring (idf-weighted cosine + a title
// boost) -- no model call, matching the "0 model calls" bar the rest of this codebase holds for every
// M-numbered metric ((internal reference removed) R6). The read-back step stores a folder owner's confirm/reject
// of each match, keyed by folder + question id, never by the person who asked or the person who confirmed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A question logged via the hover 'Ask' button (or an agent-session capture). Never carries who asked it
 *  outside the raw log; folder grouping below only ever keys by `folder`. */
export interface Question {
  id: string;
  /** the question text, verbatim */
  text: string;
  /** the folder (relative to repo root) the question is about -- the ONLY grouping key (never per-person) */
  folder: string;
  loggedAt: string;
  /** optional file:line the hover 'Ask' was raised from */
  source?: { file: string; line: number };
}

/** A record that may already answer a question: a decision doc, a planning page, a task file, anything
 *  under version control that Mole can already read. `excerpt` is real file content (or a prefix of it),
 *  never model-generated. */
export interface OneOnOneRecord {
  id: string;
  file: string;
  folder: string;
  excerpt: string;
}

export interface Match {
  recordId: string;
  file: string;
  score: number;
}

export interface PrepItem {
  question: Question;
  /** undefined when no record clears MATCH_THRESHOLD: a question no record answers stays open for the 1:1
   *  (done-when 4: never auto-answered). */
  match?: Match;
}

export interface FolderGroup {
  folder: string;
  items: PrepItem[];
}

/** Read-back verdict for one question inside one folder. Never a person id: stored per folder+question. */
export type ReadBackVerdict = 'confirmed' | 'rejected';

export interface ReadBackEntry {
  verdict: ReadBackVerdict;
  at: string;
  /** the record the owner was confirming/rejecting, if the question had a match */
  recordId?: string;
}

/** Folder -> question id -> verdict. The only identity in this store is the folder and the question; no
 *  person field exists anywhere in this type (enforced by a test that checks the written JSON's keys). */
export type ReadBackStore = Record<string, Record<string, ReadBackEntry>>;

const STOP = new Set(
  `the a an of to in on for and or but with that this these those is are was were be been being your you i
   im ive its it's as at by from so if then than well just also about into out up down over under again more
   most other some any all no not only own same very can will would should could do does did doing have has
   had having what which who whom when where why how my me we us they them he she his her their our dont
   like still even`
    .split(/\s+/)
    .filter(Boolean),
);

/** Tokens of length >= 4 used for the idf-weighted cosine; common stopwords never carry signal. */
export function tokenize(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) ?? []) as string[];
  return words.filter((w) => w.length >= 4 && !STOP.has(w));
}

function titleTokensOf(file: string): string[] {
  const base = file.split('/').pop() ?? file;
  const stem = base.replace(/\.(html|md|txt)$/i, '');
  return tokenize(stem);
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** idf table over the given record corpus (the only "training" this matcher does; recomputed per call, no
 *  persisted model, so a changed corpus always re-scores fairly). */
function idfTable(records: OneOnOneRecord[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const r of records) {
    const seen = new Set(tokenize(r.excerpt));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = records.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((n + 1) / (d + 1)) + 1);
  return idf;
}

function vector(tokens: string[], idf: Map<string, number>): Map<string, number> {
  const tf = termFreq(tokens);
  const v = new Map<string, number>();
  for (const [t, c] of tf) v.set(t, c * (idf.get(t) ?? 1));
  return v;
}

function norm(v: Map<string, number>): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s) || 1;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [t, x] of a) {
    const y = b.get(t);
    if (y !== undefined) dot += x * y;
  }
  return dot / (norm(a) * norm(b));
}

/** The record-match score (R0: deterministic idf-weighted cosine over distinctive words >= 4 chars, plus a
 *  x6 weight on the record's own filename tokens -- a title match, e.g. "resume" in the question text and
 *  in "4 Resume + interview.md", is the strongest single signal this corpus has, same shape as @mole/decisions
 *  and @mole/questions: facts first, deterministic rules, no model). */
export const MATCH_THRESHOLD = 0.1;

export interface Matcher {
  records: OneOnOneRecord[];
  idf: Map<string, number>;
  vectors: Map<string, Map<string, number>>;
}

export function buildMatcher(records: OneOnOneRecord[]): Matcher {
  const idf = idfTable(records);
  const vectors = new Map<string, Map<string, number>>();
  for (const r of records) {
    const toks = [...tokenize(r.excerpt), ...Array(6).fill(titleTokensOf(r.file)).flat()];
    vectors.set(r.id, vector(toks, idf));
  }
  return { records, idf, vectors };
}

/** Best-matching record for a question, or undefined when nothing clears MATCH_THRESHOLD (so the question
 *  stays open for the 1:1 rather than being auto-answered -- done-when 4). */
export function matchQuestion(m: Matcher, question: Question, threshold: number = MATCH_THRESHOLD): Match | undefined {
  const qv = vector(tokenize(question.text), m.idf);
  let best: { id: string; file: string; score: number } | undefined;
  for (const r of m.records) {
    const score = cosine(qv, m.vectors.get(r.id)!);
    if (!best || score > best.score) best = { id: r.id, file: r.file, score };
  }
  if (!best || best.score < threshold) return undefined;
  return { recordId: best.id, file: best.file, score: best.score };
}

/** Group questions by folder (never by person) and attach each its best match, if any. Sorted by folder
 *  name so the output is stable for a snapshot/hover UI. */
export function prep(matcher: Matcher, questions: Question[], threshold: number = MATCH_THRESHOLD): FolderGroup[] {
  const byFolder = new Map<string, PrepItem[]>();
  for (const q of questions) {
    const items = byFolder.get(q.folder) ?? [];
    items.push({ question: q, match: matchQuestion(matcher, q, threshold) });
    byFolder.set(q.folder, items);
  }
  return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, items]) => ({ folder, items }));
}

// ---------- read-back store (per folder, never per person; nothing leaves the machine) ----------

function readStore(path: string): ReadBackStore {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReadBackStore;
  } catch {
    return {};
  }
}

function writeStore(path: string, store: ReadBackStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 1)}\n`, 'utf8');
}

/** Default location: .mole/local/ (the repo's own "nothing leaves this machine, not committed" convention,
 *  same root other packages already use for local-only state). */
export function defaultReadBackPath(repoRoot: string): string {
  return join(repoRoot, '.mole', 'local', 'oneonone', 'readback.json');
}

/** Confirm or reject a question's match as part of the folder's read-back. Stored per folder + question id;
 *  no person identifier is ever written (verified by a test that inspects the written JSON's keys/shape). */
export function recordReadBack(path: string, folder: string, questionId: string, verdict: ReadBackVerdict, recordId: string | undefined, at: string = new Date().toISOString()): ReadBackStore {
  const store = readStore(path);
  store[folder] = store[folder] ?? {};
  store[folder]![questionId] = { verdict, at, recordId };
  writeStore(path, store);
  return store;
}

export function loadReadBack(path: string): ReadBackStore {
  return readStore(path);
}

/** M23 proxy numbers (not the real 2-week pilot, D7, which stays OPEN and is never simulated here): fraction
 *  of a folder's questions that already have a read-back entry, for a "1:1 prep" summary line. */
export function folderReadBackCoverage(store: ReadBackStore, folder: string, questionIds: string[]): number {
  const entries = store[folder] ?? {};
  if (!questionIds.length) return 0;
  const answered = questionIds.filter((id) => entries[id] !== undefined).length;
  return answered / questionIds.length;
}
