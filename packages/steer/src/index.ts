// T74 steering dials (signal / update / query over the existing hooks transport), modeled on Temporal's workflow
// message-passing semantics (prior art: (internal reference removed) log/prior-art.md). T75: this is the write-side
// package (decision 0014: agent states are read-only over the harness transcripts) -- @mole/agentstate itself
// performs no write calls; `query` is read-only and stays there (T18 run graph), re-exported here so callers of
// @mole/steer get signal/update/query/deliver from one place without needing to know the split.
//   mole steer signal --session S "text"            -> queued, delivered once on the agent's next tool call/prompt
//   mole steer update --session S --kind K --target T "text"  -> validated; accepted ones are queued, rejected ones
//                                                                  are told why right away and never delivered
//   mole steer query  --session S                   -> read-only snapshot from @mole/agentstate (T18), never queues
// `deliver` is the hook-side consumer (plugins/claude-code/scripts/pre-tool-use.mjs, user-prompt-submit.mjs): it
// pops every pending signal + accepted-but-undelivered update, marks them delivered, and returns only those -- so a
// second call (the other hook firing the same turn, or a later turn) never repeats them.
import { randomUUID } from 'node:crypto';
import { readInbox, withInboxClaim } from './store.js';
import { validateUpdate } from './validate.js';
export * from './types.js';
export { validateUpdate, KNOWN_UPDATE_KINDS, decisionExists, decisionsDirExists } from './validate.js';
export { inboxFile, readInbox } from './store.js';
export { queryAgentState, type AgentStateSnapshot } from './_oss-agentstate-stub.js';
import type { SteerDelivery, SteerSignal, SteerUpdateRequest, SteerUpdateResult } from './types.js';

/** `mole steer signal --session S "text"`: queued for the agent's next tool call or prompt, seen at most once.
 * Review 1 (HIGH 3): append happens inside `withInboxClaim` (atomic claim/release, store.ts), not a bare
 * read-modify-write, so a concurrent `deliver`/`signal`/`update` on the same session can never interleave with it. */
export function sendSignal(root: string, session: string, text: string, opts: { from?: string } = {}): SteerSignal {
  return withInboxClaim(root, session, (inbox) => {
    const s: SteerSignal = { id: randomUUID(), session, time: new Date().toISOString(), text, delivered: false, ...(opts.from ? { from: opts.from } : {}) };
    inbox.signals.push(s);
    return s;
  });
}

/** `mole steer update --session S --kind K --target T "text"`: checked by validateUpdate before it is queued.
 * Rejected updates are returned (accepted: false, reason set) but never written to a place the agent would see --
 * the caller gets the reason back on this same call, same as a Temporal Update Validator rejecting synchronously.
 * Validation reads `.mole/decisions` only (read-only, no inbox involved) so it happens OUTSIDE the claim; only the
 * accepted branch's append to the inbox needs the atomic claim (HIGH 3, same reasoning as sendSignal above). */
export function requestUpdate(root: string, session: string, req: SteerUpdateRequest): SteerUpdateResult {
  const v = validateUpdate(root, req);
  const result: SteerUpdateResult = { ...req, id: randomUUID(), session, time: new Date().toISOString(), accepted: v.accepted, delivered: false, ...(v.reason ? { reason: v.reason } : {}) };
  if (v.accepted) {
    withInboxClaim(root, session, (inbox) => {
      inbox.updates.push(result);
    });
  }
  return result;
}

/** PreToolUse/UserPromptSubmit: pending signals + accepted-undelivered updates, marked delivered, returned once.
 * Review 1 (HIGH 3): the whole read-filter-mark-write sequence runs inside `withInboxClaim` so two racers (e.g.
 * PreToolUse and UserPromptSubmit firing the same turn, or N concurrent hook processes under test) can never both
 * read the same undelivered item and each report delivering it -- only the racer holding the claim sees the
 * not-yet-delivered items; by the time the next racer gets the claim, this one has already marked them delivered.
 * Cheap short-circuit kept before the claim: a fresh/empty session never needs to take the lock at all.
 * Review 2: if the lock cannot be acquired within its retry budget (someone else holds it the whole time,
 * contended but not stale), `withInboxClaim` throws a lock-timeout error -- caught here and turned into an empty
 * delivery rather than propagated, so a hook calling this delivers nothing THIS CALL and exits 0 (never blocks,
 * never crashes); the queued item(s) are untouched in the canonical inbox and get delivered on a later call. */
export function deliverPending(root: string, session: string): SteerDelivery {
  const peek = readInbox(root, session);
  if (!peek.signals.some((s) => !s.delivered) && !peek.updates.some((u) => u.accepted && !u.delivered)) {
    return { session, signals: [], updates: [] };
  }
  try {
    return withInboxClaim(root, session, (inbox) => {
      const signals = inbox.signals.filter((s) => !s.delivered);
      const updates = inbox.updates.filter((u) => u.accepted && !u.delivered);
      if (signals.length === 0 && updates.length === 0) return { session, signals: [], updates: [] };
      const now = new Date().toISOString();
      const out = { session, signals: signals.map((s) => ({ ...s, delivered: true, deliveredAt: now })), updates: updates.map((u) => ({ ...u, delivered: true, deliveredAt: now })) };
      const deliveredSignalIds = new Set(signals.map((s) => s.id));
      const deliveredUpdateIds = new Set(updates.map((u) => u.id));
      inbox.signals = inbox.signals.map((s) => (deliveredSignalIds.has(s.id) ? { ...s, delivered: true, deliveredAt: now } : s));
      inbox.updates = inbox.updates.map((u) => (deliveredUpdateIds.has(u.id) ? { ...u, delivered: true, deliveredAt: now } : u));
      return out;
    });
  } catch (e) {
    process.stderr.write(`mole steer: deliver skipped this call for session ${session}: ${(e as Error).message}\n`);
    return { session, signals: [], updates: [] }; // items stay queued in the untouched inbox, never lost
  }
}
