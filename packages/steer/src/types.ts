// T74: live agent steering, modeled on Temporal's signal/update/query semantics (see
// (internal reference removed) log/prior-art.md) delivered over the existing Claude Code hooks transport (T15/T37/T64).
//   signal  = a note the agent sees once on its next tool call/prompt (Temporal: fire-and-forget async write)
//   update  = a change checked by a validator before it is accepted, rejection reason returned when it is not
//             (Temporal: synchronous write with an Update Validator; here synchronous = the CLI call itself validates)
//   query   = read-only: what the agent is doing right now (intent, files, decisions in play), from @mole/agentstate (T18)
// State lives in a per-session, file-based inbox under .mole/local/steer/ (never committed, same convention as
// packages/memory/src/seen.ts's .mole/local/seen.jsonl) -- not under the Claude-Code-specific plugin data dir, so
// `mole steer` works for any session id regardless of which harness (or no harness at all) is steering it.
//
// T75: this inbox is the write side of steering (decision 0014: agent states are read-only over the harness
// transcripts) -- it lives in its own package, @mole/steer, so @mole/agentstate itself never performs a write call.
// `query` (read-only, built on agentstate's own run graph) stays in @mole/agentstate; see index.ts's re-export.

/** A one-shot note: delivered to the agent at most once (PreToolUse or UserPromptSubmit, whichever fires first). */
export interface SteerSignal {
  id: string;
  session: string;
  time: string; // ISO, when it was sent
  text: string;
  from?: string; // who/what sent it (free text: a person's name, another agent's run id, ...)
  delivered: boolean;
  deliveredAt?: string; // ISO
}

/** What a caller asks to change; `kind` + `target` are what the validator checks, `text` is what the agent reads. */
export interface SteerUpdateRequest {
  kind: string;
  target?: string; // file path (stop-editing) or decision id (decision-superseded); meaning depends on kind
  text: string;
  from?: string;
}

/** The validator's verdict, with the request it validated, kept whether accepted or not (rejected ones are never
 * delivered to the agent -- the rejection reason goes back to the caller that asked for the update, same turn). */
export interface SteerUpdateResult extends SteerUpdateRequest {
  id: string;
  session: string;
  time: string;
  accepted: boolean;
  reason?: string; // set when accepted === false
  delivered: boolean;
  deliveredAt?: string;
}

/** The whole per-session inbox file (.mole/local/steer/<session>.json). */
export interface SteerInbox {
  session: string;
  signals: SteerSignal[];
  updates: SteerUpdateResult[];
}

/** Items delivered by one `deliver` call (PreToolUse/UserPromptSubmit): newly-delivered, never repeated. */
export interface SteerDelivery {
  session: string;
  signals: SteerSignal[];
  updates: SteerUpdateResult[]; // accepted only: a rejected update was never queued for delivery
}
