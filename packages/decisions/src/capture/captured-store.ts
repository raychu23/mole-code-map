// T80: persistent storage for captured arguments, one JSON array per decision id under
// `<root>/.mole/arguments/captured/<id>.json` -- same convention as T46's compile-at-capture store
// (`compile/store.ts`): append-only, nothing is ever deleted. Re-capturing a decision MERGES newly found
// rows in and adds any new ids; it never removes a row that disappeared from the source text, so an
// approved argument's approval is never silently undone by a later re-run.
//
// review HIGH 1: a captured argument's id is POSITIONAL (`::pro:N`/`::con:N`/`::option:N`, derive-adr.ts /
// arguments.ts number bullets in source order). Merging by id alone meant inserting a new bullet ABOVE an
// already-approved one shifted every id after it down by one -- the id that used to mean the approved
// bullet now means the NEW, unreviewed bullet (which silently inherited 'approved'), while the approved
// text moved to a new id that looked never-reviewed. Fixed by binding an approval/rejection to the row's
// CONTENT (`contentHash` below: sha256 of `role::text`) first, falling back to id only when no row's
// content matches (an honest edit-in-place) -- see `mergeByContent`'s own comment for the four cases
// (insert, edit, reorder, delete) this resolves.
//
// review MEDIUM 3: every read-modify-write here (merge-and-save, approve, reject) is now guarded by a
// cross-process file lock (proper-lockfile) and writes go through a temp-file + rename, same pattern as
// priorities.ts's setPriorities (see that file's own comment above `lockStaleMs` for why proper-lockfile
// replaces a hand-rolled mutex). Without it, N concurrent `mole arguments approve` calls on the same
// decision raced: each read the whole array, patched its own row in memory, and wrote the whole array back
// -- a second writer's read (taken before the first writer's write landed) clobbered the first writer's
// change when it saved. The lock serializes the whole read-modify-write per decision id.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { lock as lockFile } from 'proper-lockfile';
import { optionNameOf, sameName } from '../argdown/derive-adr.js';
import type { CapturedArgument } from './arguments.js';

export const capturedDir = (root: string): string => join(root, '.mole', 'arguments', 'captured');
export const capturedPath = (root: string, decisionId: string): string => join(capturedDir(root), `${decisionId}.json`);

export class CapturedArgumentError extends Error {}

export function listCapturedArguments(root: string, decisionId: string): CapturedArgument[] {
  const p = capturedPath(root, decisionId);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as CapturedArgument[];
}

/** review 2 NEW HIGH (D-attack): the NAME an attack/support id resolves to -- the claim's own fixed label,
 *  or (considered-option) the option's OWN name text (never its positional id, which is exactly what
 *  changes when a con is moved from one option's Pros-and-Cons subsection to another's -- the option that
 *  USED TO sit at that positional id may now be a different option entirely). `byId` must be the id->row
 *  lookup of the SAME capture batch `row` came from: an id is only meaningful within the one capture (old
 *  stored set, or freshly-extracted set) that produced it, never mixed across the two. Falls back to the
 *  target's own normalized text for a role that is neither claim nor considered-option (nothing currently
 *  attacks/supports a pro/con, but never silently treat an unresolvable target as equal to its raw id).
 *
 *  review 3: this is now a FALLBACK only -- arguments.ts sets `attacksNames`/`supportsNames` directly at
 *  capture time (the name is already known there, no id lookup needed), and `mergeByContent` carries them
 *  through on every resolved row. This function covers the one case those fields can be missing: a row
 *  persisted before this field existed (pre-migration data on disk). */
function targetNameOf(id: string, decisionId: string, byId: Map<string, { role: string; text: string }>): string {
  if (id === `${decisionId}::claim`) return 'claim';
  const target = byId.get(id);
  if (!target) return id; // unresolvable (should not happen within one batch) -- fall back, never throw
  return sameName(target.role === 'considered-option' ? optionNameOf(target.text) : target.text);
}

/** review HIGH 1 + review 2 NEW HIGH (D-attack): a row's content identity -- role + its OWN normalized
 *  text + the SORTED NAMES (never positional ids) of everything it attacks/supports. Before this fix the
 *  hash was `role::text` alone: a con quoting IDENTICAL text under a DIFFERENT option's Pros-and-Cons
 *  subsection hashed identically to its old self, so `mergeByContent` read it as "nothing changed" and
 *  silently carried the old approval (and the OLD option's defeat) onto the NEW option -- the same con
 *  text that used to defeat Option A would, after being moved under Option B, defeat Option B too, with
 *  nobody re-reviewing it. Hashing the sorted target NAMES (not the positional `::option:N` ids, which
 *  shift independently of what they point to) means a row whose text is untouched but whose target moved
 *  gets a DIFFERENT hash -- `mergeByContent` then treats it exactly like an edit-in-place: back to `draft`
 *  with `previouslyApproved` noted, never silently still-approved. `byId` is the id->row lookup of the
 *  SAME batch (existing or fresh) this row's own `attacks`/`supports` ids were assigned in; only used as a
 *  fallback when the row has no `attacksNames`/`supportsNames` of its own (review 3, see `targetNameOf`). */
function contentHashOf(row: { decisionId: string; role: string; text: string; attacks: string[]; supports: string[]; attacksNames?: string[]; supportsNames?: string[] }, byId: Map<string, { role: string; text: string }>): string {
  const attacksNames = row.attacksNames ?? row.attacks.map((id) => targetNameOf(id, row.decisionId, byId));
  const supportsNames = row.supportsNames ?? row.supports.map((id) => targetNameOf(id, row.decisionId, byId));
  const targetNames = Array.from(new Set([...attacksNames, ...supportsNames])).sort();
  return createHash('sha256').update(`${row.role}::${sameName(row.text)}::${targetNames.join('|')}`).digest('hex');
}

/** Write-then-rename (same directory, same filesystem, review MEDIUM 3): a reader never observes a
 *  half-written file, and a process crashing mid-write leaves only an orphaned `.tmp` file, never a
 *  corrupt captured-arguments file. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function writeCapturedArguments(root: string, decisionId: string, rows: CapturedArgument[]): void {
  mkdirSync(capturedDir(root), { recursive: true });
  writeFileAtomic(capturedPath(root, decisionId), `${JSON.stringify(rows, null, 2)}\n`);
}

// review MEDIUM 3: same lock knobs as priorities.ts's setPriorities -- see that file's own comment above
// its `lockStaleMs` for the full rationale (mkdir-based mutex, mtime refresh while held, onCompromised
// instead of silent reclaim). MOLE_CAPTURED_ARGUMENTS_TEST_STALE_MS is a test-only seam, unset in production.
function lockStaleMs(): number {
  return Number(process.env.MOLE_CAPTURED_ARGUMENTS_TEST_STALE_MS) || 10_000;
}
function lockRetries(staleMs: number): { retries: number; factor: number; minTimeout: number; maxTimeout: number } {
  const minTimeout = Math.max(20, Math.round(staleMs / 50));
  const maxTimeout = Math.max(300, Math.round(staleMs / 2));
  return { retries: 25, factor: 1.4, minTimeout, maxTimeout };
}

/** review MEDIUM 3: a crash-orphaned `<file>.lock` must never show up as an untracked file in a REPO THIS
 *  RUNS AGAINST. Same convention priorities.ts already writes for `.mole/priorities.md.lock` -- shared
 *  `.mole/.gitignore`, written once, never duplicated. */
function ensureLockIgnored(root: string): void {
  const dir = join(root, '.mole');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
  const ignorePath = join(dir, '.gitignore');
  let text = '';
  try {
    text = readFileSync(ignorePath, 'utf8');
  } catch {
    /* no .mole/.gitignore yet */
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === '*.lock')) return;
  const prefix = text && !text.endsWith('\n') ? `${text}\n` : text;
  writeFileSync(ignorePath, `${prefix}${prefix ? '' : '# Mole: process lock files, never committed\n'}*.lock\n`);
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const stale = lockStaleMs();
  const { retries, factor, minTimeout, maxTimeout } = lockRetries(stale);
  try {
    return await lockFile(path, {
      stale,
      update: Math.round(stale / 4), // proper-lockfile clamps this into [1000, stale/2] itself
      retries: { retries, factor, minTimeout, maxTimeout },
      realpath: false, // the locked file may not exist yet (a decision's first capture creates it)
      onCompromised: (err) => {
        throw new CapturedArgumentError(`lock on ${path} was compromised (its mtime could no longer be refreshed): ${err.message}`);
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new CapturedArgumentError(`timed out waiting for the lock on ${path} (another capture/approve/reject is running or crashed holding it)`);
    }
    throw err;
  }
}

/** review MEDIUM 3: serialize one decision id's whole read-modify-write under its own lock. `mkdirSync`
 *  before locking (same as `ensureLockIgnored`'s own mkdir) so proper-lockfile's internal mkdir-based mutex
 *  always has a directory to be created in, even on a brand-new repo's very first capture. */
async function withLock<T>(root: string, decisionId: string, fn: () => T): Promise<T> {
  ensureLockIgnored(root);
  mkdirSync(capturedDir(root), { recursive: true });
  const path = capturedPath(root, decisionId);
  const release = await acquireLock(path);
  try {
    return fn();
  } finally {
    await release();
  }
}

/** review HIGH 1: merge freshly-captured rows (always `status: 'draft'` coming in) against the stored set,
 *  BY CONTENT first, never by positional id alone:
 *   1. same content (role+text), anywhere in the stored set, unused so far -- the common "nothing changed"
 *      case (fast-pathed via the same id when it also matches) AND the "a bullet was inserted/removed above
 *      this one, so its id shifted but its text didn't" case (review's own reorder/insert reproducers):
 *      carries status/approvedBy/approvedAt/rejectedReason/rejectedAt/previouslyApproved* forward intact.
 *   2. no content match anywhere, but THIS id existed before with DIFFERENT text (an honest edit-in-place):
 *      an approved row reverts to `draft` with `previouslyApproved` (+by/at) noted -- the OLD approval no
 *      longer vouches for NEW text nobody has reviewed; a rejected or still-draft row just takes the fresh
 *      text as a plain draft (no stale reason attached to text that no longer exists).
 *   3. no match at all: a genuinely new row, draft as it came in.
 *  Any stored row no row in `fresh` claims (case 4: the bullet was deleted from the source) is kept,
 *  unchanged, at the end -- never silently dropped (append-only). */
function mergeByContent(decisionId: string, existing: CapturedArgument[], fresh: CapturedArgument[]): CapturedArgument[] {
  // review 2 NEW HIGH (D-attack): hash lookups for a row's attacks/supports TARGETS must stay within the
  // one batch (existing or fresh) that assigned that row's ids -- never a map mixing the two.
  const existingById = new Map(existing.map((r) => [r.id, r]));
  const freshById = new Map(fresh.map((r) => [r.id, r]));
  const existingByHash = new Map<string, CapturedArgument[]>();
  for (const r of existing) {
    const h = contentHashOf(r, existingById);
    const bucket = existingByHash.get(h);
    if (bucket) bucket.push(r);
    else existingByHash.set(h, [r]);
  }
  const used = new Set<string>();
  const hashes = fresh.map((row) => contentHashOf(row, freshById));
  const resolved: Array<CapturedArgument | undefined> = fresh.map(() => undefined);

  // PASS 1: resolve every fresh row's CONTENT match first, across the whole batch, before any row falls
  // back to an id match. Order matters here (review HIGH 1's own insertion reproducer): a genuinely-new row
  // processed earlier must never be allowed to steal, via its id, the stored row that a LATER row's content
  // still needs -- doing content matches for the whole batch first, then id matches only for what's left,
  // is what keeps that from happening (a single combined pass processed fresh rows in document order and
  // let an earlier no-content-match row's id fallback consume the wrong stored row first).
  fresh.forEach((row, i) => {
    const h = hashes[i]!;
    const sameContent = (existingByHash.get(h) ?? []).filter((c) => !used.has(c.id));
    // prefer the row at the SAME id among content matches (the common no-op re-capture), else the first
    // unused one (the row whose content moved to a different id -- insert/reorder).
    const prior = sameContent.find((c) => c.id === row.id) ?? sameContent[0];
    if (!prior) return;
    used.add(prior.id);
    resolved[i] = {
      ...row,
      contentHash: h,
      status: prior.status,
      approvedBy: prior.approvedBy,
      approvedAt: prior.approvedAt,
      approvedHash: prior.approvedHash,
      rejectedReason: prior.rejectedReason,
      rejectedAt: prior.rejectedAt,
      previouslyApproved: prior.previouslyApproved,
      previouslyApprovedBy: prior.previouslyApprovedBy,
      previouslyApprovedAt: prior.previouslyApprovedAt,
    };
  });

  // PASS 2: anything left without a content match either shares an id with a stored row whose content
  // differs (an honest edit-in-place) or is genuinely new.
  fresh.forEach((row, i) => {
    if (resolved[i]) return;
    const h = hashes[i]!;
    const byId = existingById.get(row.id);
    if (byId && !used.has(byId.id)) {
      used.add(byId.id);
      if (byId.status === 'approved') {
        resolved[i] = { ...row, contentHash: h, status: 'draft', previouslyApproved: true, previouslyApprovedBy: byId.approvedBy, previouslyApprovedAt: byId.approvedAt };
        return;
      }
      resolved[i] = { ...row, contentHash: h, status: 'draft' };
      return;
    }
    resolved[i] = { ...row, contentHash: h };
  });

  const merged = resolved as CapturedArgument[];
  // review 2 COMPOUNDING: every id in `merged` so far comes from `fresh` (pass 1 and pass 2 both spread
  // `row`, i.e. a fresh row, so its final id is always SOME fresh[i].id -- unique within `fresh` by
  // construction of the extractor's own per-role counters). A leftover, never-claimed EXISTING row (case
  // 4: deleted from source, kept append-only below) carries its OWN old id forward -- and that old id can
  // coincide with an unrelated id this run's `fresh` batch happens to reuse (ids are positional, so a
  // smaller/reshaped document reissues low numbers). Without this check two rows could share one id in the
  // same decision file (`setRow`'s `findIndex` would then silently patch whichever came first). Disambiguate
  // instead of colliding -- the row's content and history are still there, just findable under a distinct id.
  const claimedIds = new Set(merged.map((r) => r.id));
  for (const r of existing) {
    if (used.has(r.id)) continue;
    let id = r.id;
    if (claimedIds.has(id)) {
      let n = 2;
      while (claimedIds.has(`${r.id}::stale${n}`)) n++;
      id = `${r.id}::stale${n}`;
    }
    claimedIds.add(id);
    // deleted-from-source row: kept, never dropped -- also back-fills contentHash for any row persisted
    // before this field existed, so every row on disk has one after its first merge through this code.
    // review 3 HIGH 2: explicitly flagged `stale` -- a row no fresh capture claims is HISTORY ONLY from
    // this point on: captured-loader.ts never turns it into a graph node/edge (even if it was `approved`
    // before going stale) and setRow (approve/reject, below) refuses to act on it. This is the fix for the
    // root cause behind every review round on this task: a stale row's `attacks`/`supports` ids are
    // positional and may now point at a DIFFERENT, unrelated argument that reused that id -- the explicit
    // flag, not the id's shape, is what callers must check.
    merged.push({ ...r, id, contentHash: r.contentHash ?? contentHashOf(r, existingById), stale: true });
  }
  // review 2 COMPOUNDING: assert the invariant this function exists to guarantee, rather than trust the
  // disambiguation above silently did its job -- a regression here must be loud, never a quiet data bug.
  const finalIds = merged.map((r) => r.id);
  if (new Set(finalIds).size !== finalIds.length) {
    throw new CapturedArgumentError(`mergeByContent: internal invariant violated -- ${decisionId} would have duplicate captured-argument ids after merge`);
  }
  return merged;
}

/** Merge freshly-captured rows into the stored set and persist (review HIGH 1 + MEDIUM 3: content-bound
 *  merge, under this decision's own lock, written atomically). Returns the full merged set. */
export async function saveCapturedArguments(root: string, decisionId: string, fresh: CapturedArgument[]): Promise<CapturedArgument[]> {
  return withLock(root, decisionId, () => {
    // re-read AFTER the lock is held, never before -- a read taken before acquiring the lock could already
    // be stale by the time this process gets its turn to write (review MEDIUM 3, same as priorities.ts).
    const existing = listCapturedArguments(root, decisionId);
    const merged = mergeByContent(decisionId, existing, fresh);
    writeCapturedArguments(root, decisionId, merged);
    return merged;
  });
}

/** review 2 COMPOUNDING: refuse an AMBIGUOUS id loudly rather than silently patching whichever row
 *  `findIndex` happens to see first -- this should never fire given `mergeByContent`'s own invariant
 *  above, but approve/reject must never trust that invariant blindly from the outside; a stored file
 *  edited by hand, or written by a future bug, gets a named error here instead of a wrong row mutated. */
async function setRow(
  root: string,
  decisionId: string,
  argumentId: string,
  patch: Partial<CapturedArgument> | ((row: CapturedArgument) => Partial<CapturedArgument>),
  verb: string,
): Promise<CapturedArgument> {
  return withLock(root, decisionId, () => {
    const rows = listCapturedArguments(root, decisionId); // re-read AFTER the lock is held
    const matchCount = rows.filter((r) => r.id === argumentId).length;
    if (matchCount > 1) {
      throw new CapturedArgumentError(
        `mole arguments ${verb}: ${decisionId} has an AMBIGUOUS captured argument id ${argumentId} (${matchCount} rows share it) -- refusing to guess which one; the stored file needs manual repair`,
      );
    }
    const idx = rows.findIndex((r) => r.id === argumentId);
    if (idx < 0) throw new CapturedArgumentError(`mole arguments ${verb}: ${decisionId} has no captured argument ${argumentId}`);
    // review 3 HIGH 2: a STALE row (no longer present in the latest capture -- deleted/renamed-beyond-
    // recognition from the source) is history only. Approving it can silently defeat/support an UNRELATED
    // argument now holding a reused positional id; refuse outright rather than acting on it.
    if (rows[idx]!.stale) {
      throw new CapturedArgumentError(
        `mole arguments ${verb}: ${decisionId}'s ${argumentId} is a STALE captured argument (not present in the latest \`mole arguments capture\`) -- refusing to ${verb} history; re-run \`mole arguments capture --id ${decisionId}\` and ${verb} the CURRENT row instead`,
      );
    }
    const resolvedPatch = typeof patch === 'function' ? patch(rows[idx]!) : patch;
    const next = { ...rows[idx]!, ...resolvedPatch };
    rows[idx] = next;
    writeCapturedArguments(root, decisionId, rows);
    return next;
  });
}

/** A person approves one captured argument: ONLY this call moves a row from `draft` to `approved`, and
 *  only an approved row is ever turned into a graph node by captured-loader.ts -- see prior-art.md's
 *  design choice #1 for why this is the sole path to effect. Approving twice re-stamps approvedBy/At
 *  (same re-run-after-an-unrelated-edit convenience T46's compileCli documents), never an error. Clears
 *  any `previouslyApproved` note from an earlier edit-in-place revert -- a fresh approval of the CURRENT
 *  text supersedes it. */
export async function approveCapturedArgument(root: string, decisionId: string, argumentId: string, approver: string): Promise<CapturedArgument> {
  return setRow(
    root,
    decisionId,
    argumentId,
    // review 2 NEW HIGH (D-attack): stamp the hash of what was ACTUALLY approved (role+text+target names,
    // computed by contentHashOf) so a later audit can assert `approvedHash === contentHash` for every
    // approved row -- if `mergeByContent` ever carries a status of 'approved' forward onto a row whose
    // hash changed, that assertion (and the property test below) catches it immediately.
    (row) => ({
      status: 'approved',
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
      approvedHash: row.contentHash,
      rejectedReason: undefined,
      rejectedAt: undefined,
      previouslyApproved: undefined,
      previouslyApprovedBy: undefined,
      previouslyApprovedAt: undefined,
    }),
    'approve',
  );
}

/** A person rejects one captured argument: marks it `rejected` with a reason. Never deletes the row
 *  (append-only) and never affects the graph either way -- rejected is simply never approved. Clears
 *  `approvedHash` too: a rejected row is, by definition, no longer vouched for by any past approval. */
export async function rejectCapturedArgument(root: string, decisionId: string, argumentId: string, reason: string): Promise<CapturedArgument> {
  return setRow(root, decisionId, argumentId, { status: 'rejected', rejectedReason: reason, rejectedAt: new Date().toISOString(), approvedHash: undefined }, 'reject');
}

/** Every decision id with at least one captured-argument file, for `mole arguments list` with no --id. */
export function allCapturedArguments(root: string): Record<string, CapturedArgument[]> {
  const dir = capturedDir(root);
  if (!existsSync(dir)) return {};
  const out: Record<string, CapturedArgument[]> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    out[f.slice(0, -'.json'.length)] = listCapturedArguments(root, f.slice(0, -'.json'.length));
  }
  return out;
}
