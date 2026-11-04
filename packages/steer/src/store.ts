// File-based per-session steering inbox: .mole/local/steer/<session>.json. Private to this machine (like
// packages/memory/src/seen.ts's .mole/local/seen.jsonl) -- the folder gets a `.gitignore` with `*` so it is never
// committed even in a repo that never listed .mole/local.
//
// T75: this is the write side of steering (decision 0014: agent states are read-only over the harness transcripts)
// -- it lives in its own package, @mole/steer, precisely because of the mkdirSync/writeFileSync/unlinkSync/
// renameSync calls below; @mole/agentstate (T18, read-only run graphs) must never perform a write call.
//
// Review 2 (HIGH): Review 1's `withInboxClaim` used a hand-rolled claim-by-rename scheme (rename the canonical
// inbox to a unique per-process name, mutate, rename back). The reviewer found a real data-loss bug in it: on
// ENOENT the old code could not tell "no inbox yet" (first ever write) from "inbox currently claimed by ANOTHER
// process" (also ENOENT, because a successful claim renames the canonical file away) -- both look identical to a
// `renameSync` that fails. It responded to either case by creating a brand-new EMPTY inbox and looping back to
// claim THAT, so two racers could each be mutating their own empty copy and whichever renamed back LAST won,
// silently discarding every item the other had written (reviewer: 98 successful sends -> 6 survived). A process
// kill -9'd mid-claim also orphaned its claimed file forever (nothing ever looked for `*.claim-*` again), so the
// next writer started from empty too.
//
// Fix: stop hand-rolling mutual exclusion on the content file itself. Use proper-lockfile
// (https://github.com/moxystudio/node-proper-lockfile), the mature, widely used Node file-locking library:
//   - it creates a SEPARATE lock directory (`<canonical>.lock`, via `mkdir` -- atomic the same way O_EXCL is,
//     `mkdir` fails EEXIST if the dir exists) NEXT TO the canonical inbox, so the canonical file is never moved
//     away and there is never a "which rename-back wins" question -- the thing racers contend over is the lock
//     directory's existence, not the content file's path, so an ENOENT vs EEXIST ambiguity like Review 1's can't
//     arise: `mkdir` either succeeds (we hold the lock) or fails EEXIST (someone else holds it) or fails for a
//     real reason (ENOENT on a missing parent dir, handled by `ensureDir` before every lock attempt).
//   - stale reclaim: if the lock directory's mtime is older than `stale` ms (refreshed periodically by the
//     holder while it holds the lock -- the "mtime refresh" `update` option), a new claimant treats it as
//     abandoned (e.g. the previous holder was kill -9'd) and removes + re-acquires it, so a dead process can never
//     wedge the inbox forever the way Review 1's orphaned `*.claim-*` files could.
//   - `onCompromised` is a required callback (library default: throw) for when the lock is lost unexpectedly
//     (e.g. someone else reclaimed it as stale while we still thought we held it); we log and let our own write
//     fail/retry rather than crashing the whole process, since this is a hook-adjacent CLI that must never crash.
// The read-modify-write itself still follows the Maildir/git-lockfile rename-to-publish idiom from Review 1 (see
// (internal reference removed) log/prior-art.md's Review 1 additions) for the WRITE half only: while holding the
// lock, read the canonical file, mutate in memory, write a unique temp file, then `renameSync` the temp file ONTO
// the canonical path (atomic on POSIX) -- so a reader that opens the canonical path outside the lock (the cheap
// `readInbox` peek in index.ts's `deliverPending`) never sees a half-written file. The canonical inbox itself is
// NEVER renamed away, closing the exact hole Review 1's scheme had.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { SteerInbox } from './types.js';

const LOCAL_DIR = '.mole/local/steer';
const sanitize = (s: string): string => String(s || 'unknown').replace(/[^\w.-]/g, '_');

export function inboxFile(root: string, session: string): string {
  return join(root, LOCAL_DIR, `${sanitize(session)}.json`);
}

function ensureDir(root: string): void {
  const dir = join(root, LOCAL_DIR);
  mkdirSync(dir, { recursive: true });
  const gi = join(root, '.mole', 'local', '.gitignore');
  if (!existsSync(gi)) {
    try {
      writeFileSync(gi, '# Mole: personal, never committed\n*\n');
    } catch {
      // best effort: the inbox itself still works without it
    }
  }
}

/** A crash between linkSync and unlinkSync leaves `<inbox>.boot-<pid>-<ts>` holding only the empty skeleton (never
 * real items). Remove ones older than a minute so they never pile up (T84 review LOW 2). Best effort. */
function sweepStaleBoots(canonical: string): void {
  const dir = dirname(canonical);
  const prefix = `${basename(canonical)}.boot-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const p = join(dir, n);
    try {
      if (Date.now() - statSync(p).mtimeMs > 60_000) unlinkSync(p);
    } catch {
      // raced with its owner or already gone
    }
  }
}

export function readInbox(root: string, session: string): SteerInbox {
  const f = inboxFile(root, session);
  try {
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as SteerInbox;
  } catch {
    // a corrupt file starts fresh rather than wedging every future `mole steer` call
  }
  return { session, signals: [], updates: [] };
}

export function writeInbox(root: string, inbox: SteerInbox): void {
  ensureDir(root);
  writeFileSync(inboxFile(root, inbox.session), JSON.stringify(inbox));
}

/** A blocking sleep with no external dependency (Node has no sync setTimeout): a 1-cell SharedArrayBuffer +
 * Atomics.wait is the standard synchronous-sleep idiom for Node's main thread. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Review 2 migration: before the proper-lockfile rewrite, a claim-rename scheme left `<canonical>.claim-PID-UUID`
 * files behind when a claimer was kill -9'd mid-claim (nothing ever looked for them again, so anything queued in
 * one was lost forever). Folds every such leftover file's signals/updates into `inbox` and deletes it. Runs
 * INSIDE the lock on every `withInboxClaim` call (cheap no-op once no orphans remain -- a single `readdirSync` of
 * a small directory) so nothing queued before this upgrade is silently dropped.
 */
function foldOrphanedClaims(root: string, session: string, inbox: SteerInbox): void {
  const canonical = inboxFile(root, session);
  const dir = join(root, LOCAL_DIR);
  const prefix = `${basename(canonical)}.claim-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const p = join(dir, name);
    try {
      const orphan = JSON.parse(readFileSync(p, 'utf8')) as SteerInbox;
      inbox.signals.push(...(orphan.signals ?? []));
      inbox.updates.push(...(orphan.updates ?? []));
    } catch {
      // corrupt orphan: drop it rather than wedge every future call trying to parse it again
    }
    try {
      unlinkSync(p);
    } catch {
      // best effort: a failed unlink just means we try again next call, never a crash
    }
  }
}

/**
 * Atomic claim-modify-release on the per-session inbox file, via proper-lockfile (see this file's header for why
 * Review 2 replaced the Review 1 hand-rolled claim-by-rename scheme with it). `mutate` receives the current
 * inbox (already folded with any pre-upgrade orphaned claim files), mutates it in place, and returns whatever the
 * caller wants back; the mutated inbox is written to a temp file and renamed over the canonical path -- still
 * holding the lock -- before this returns, including on a thrown error (release always runs in `finally`).
 * Concurrent `sendSignal`/`requestUpdate`/`deliverPending` calls on the SAME session therefore serialize instead
 * of racing: only one process can ever be inside `mutate` for a given session at a time.
 *
 * `opts.retries` bounds the total time spent trying to acquire a CONTENDED (not stale) lock -- the hook budget:
 * default ~30 attempts x 80ms = ~2.4s, comfortably under the hooks' own 15s timeout. On timeout this throws;
 * `deliverPending` (index.ts) catches that specific case and returns an empty delivery instead of propagating,
 * so a hook that cannot get the lock in time delivers nothing THIS CALL and exits 0 -- the item(s) stay queued in
 * the untouched canonical file and are delivered on a later call, never lost. `opts.staleMs` (library's `stale`)
 * is how long an idle lock directory must sit before a new claimant treats its holder as dead and reclaims it
 * (handles a kill -9'd holder); proper-lockfile enforces a 2000ms floor on this.
 */
export function withInboxClaim<T>(root: string, session: string, mutate: (inbox: SteerInbox) => T, opts: { retries?: number; retryDelayMs?: number; staleMs?: number } = {}): T {
  ensureDir(root);
  const canonical = inboxFile(root, session);
  // bootstrap: lockfile needs a real path to lock (we pass realpath:false below so it need not resolve a
  // symlink, but mkdir-based locking still wants the parent dir ensured, done above). Create an empty inbox with
  // O_EXCL ('wx') on first-ever use so a concurrent first-writer race can't clobber a just-created file -- the
  // loser's 'wx' throws EEXIST and is ignored, same idiom git's index.lock bootstrap uses.
  // T84: 'wx' alone is create-THEN-write, so a concurrent sender could lock and read the still-empty file. Write
  // the full initial inbox to a private temp file and hard-link it into place: link(2) is atomic and fails with
  // EEXIST if another process won, so the canonical path only ever appears with complete content.
  sweepStaleBoots(canonical);
  if (!existsSync(canonical)) {
    const boot = `${canonical}.boot-${process.pid}-${Date.now()}`;
    const empty = JSON.stringify({ session, signals: [], updates: [] } satisfies SteerInbox);
    try {
      writeFileSync(boot, empty, { flag: 'wx' });
      linkSync(boot, canonical);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // another process published the inbox first: fine
      } else if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EXDEV' || code === 'EOPNOTSUPP') {
        // filesystem without hard links (FAT/exFAT, some network mounts): fall back to O_EXCL create; the empty-file
        // tolerance under the lock below covers its create-then-write window (T84 review LOW 1)
        try {
          writeFileSync(canonical, empty, { flag: 'wx' });
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
        }
      } else throw e;
    } finally {
      try {
        unlinkSync(boot);
      } catch {
        // already gone: nothing to clean
      }
    }
  }

  const retries = opts.retries ?? 30;
  const retryDelayMs = opts.retryDelayMs ?? 80; // ~2.4s worst case total, under the ~3s hook budget
  const staleMs = opts.staleMs ?? 5000;
  let release: (() => void) | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      release = lockfile.lockSync(canonical, {
        realpath: false, // the inbox need not be a real/resolved path; avoids an extra fs.realpath round trip
        stale: staleMs,
        update: Math.max(1000, Math.min(staleMs / 2, 2500)), // mtime refresh cadence while held (library floor: 1000ms)
        onCompromised: (err: Error) => {
          // the lock was reclaimed out from under us (e.g. we held it past `stale` while genuinely busy, or the
          // holder record was lost) -- never throw out of a background callback; the in-flight write below will
          // simply be racing the new holder's eventual write, same as any other contended retry, not a crash.
          process.stderr.write(`mole steer: lock compromised for session ${session}: ${err.message}\n`);
        },
      });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) {
        throw new Error(`mole steer: inbox lock timeout for session ${session} (tried ${retries + 1}x over ~${(retries + 1) * retryDelayMs}ms): ${(e as Error).message}`);
      }
      sleepSync(retryDelayMs);
    }
  }
  if (!release) throw lastErr instanceof Error ? lastErr : new Error(`mole steer: could not acquire inbox lock for session ${session}`);

  try {
    // an empty file (left by a pre-T84 bootstrap or a crash before its first write) holds no items: read it as empty
    const raw = existsSync(canonical) ? readFileSync(canonical, 'utf8') : '';
    let inbox: SteerInbox = { session, signals: [], updates: [] };
    if (raw.trim()) {
      try {
        inbox = JSON.parse(raw) as SteerInbox;
      } catch (e) {
        // corrupt but non-empty (disk fault, hand edit, restore): never crash every future send, never silently
        // destroy it either -- move it aside for a person and start a fresh inbox (T84 review LOW 3)
        const aside = `${canonical}.corrupt-${Date.now()}`;
        renameSync(canonical, aside);
        process.stderr.write(`mole steer: inbox for session ${session} was not valid JSON (${(e as Error).message}); kept as ${aside}\n`);
      }
    }
    foldOrphanedClaims(root, session, inbox);
    const result = mutate(inbox);
    const tmp = `${canonical}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(inbox));
    renameSync(tmp, canonical); // atomic publish: the canonical path is NEVER moved away, only ever overwritten in one step
    return result;
  } finally {
    try {
      release();
    } catch {
      // already released/compromised: nothing more to release, never let cleanup itself throw
    }
  }
}
