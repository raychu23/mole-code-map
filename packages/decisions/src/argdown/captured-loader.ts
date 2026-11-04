// T80: turns APPROVED captured arguments (capture/captured-store.ts) into the same `kind: 'argument'`
// graph nodes + supports/attacks/undercuts edges T48's loadArgdown already produces, so framework.ts's
// `argumentFramework()` and packages/reasoning's `evaluate()` pick them up with NO changes of their own --
// extending the existing capture path (T48/T43/T67) rather than a parallel store/evaluator
// (prior-art.md's design choice #1).
//
// A `draft` (or `rejected`) row is skipped entirely: it never becomes a graph node, so it is structurally
// invisible to `argumentFramework()`/`evaluate()` -- this is the whole mechanism behind "a draft argument
// never changes a verdict until approved" (tested in test/argument-capture.test.ts).
//
// review 3 structural fix (root cause of every review round on this task): a captured argument's
// `attacks`/`supports` arrays are POSITIONAL ids (`::option:N`), assigned fresh by every `mole arguments
// capture` run -- a later re-capture can silently REISSUE an id that used to mean one argument to a
// completely different one (an option deleted, or a document reshaped). Trusting those stored ids
// directly here would let an approved row's edge resolve to whatever CURRENTLY holds that id, not what it
// meant when the row was written. Fixed structurally: this loader NEVER reads `row.attacks`/`row.supports`
// directly. It resolves every edge by the target's NORMALIZED NAME (`row.attacksNames`/`supportsNames`,
// set at capture time -- see capture/arguments.ts) against a name->id map built ONLY from THIS SAME LOAD's
// current (non-stale, approved) nodes -- i.e. against "the current capture batch", never a stale snapshot.
// A name with no current match (renamed/deleted) or more than one current match (two options whose names
// collide, capture/arguments.ts's HIGH-1 fix) never produces an edge -- dropped silently, never fabricated.
//
// A `stale` row (captured-store.ts's `mergeByContent`: no fresh capture claims it any more) is HISTORY
// ONLY -- never a graph node, never a source OR a target of an edge, even if it was `approved` before
// going stale. This is what makes the `::staleN` reproducer safe: deleting an option and letting its old
// id get reissued to an unrelated argument can no longer make that unrelated argument inherit the deleted
// option's old edges, because the deleted option's row is excluded from both the node pass and the name
// map below.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { CapturedArgument } from '../capture/arguments.js';
import { capturedDir } from '../capture/captured-store.js';
import { optionNameOf, sameName } from './derive-adr.js';
import type { GraphBuilder } from './loader.js';

/** One call from graph.ts, right after loadArgdown (same convention as that loader's own doc comment). */
export function loadCapturedArguments(b: GraphBuilder): void {
  const dir = capturedDir(b.root);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();

  // PASS 1: nodes. Only CURRENT (non-stale), APPROVED rows become graph nodes -- a stale row is history
  // only, never a node, regardless of what its own `status` says (it may have been approved before a
  // later re-capture made it stale). Simultaneously builds the per-decision NAME -> id map this loader
  // uses to resolve edges in pass 2, restricted to exactly the ids just added as nodes here: an edge can
  // only ever target something that is ACTUALLY in THIS load's graph, never a positional id taken on
  // faith. A name claimed by more than one current node (capture-level ambiguous option names) is removed
  // from the map entirely -- an edge whose target name is ambiguous must never guess which node it meant.
  const nameToId = new Map<string, string>();
  const ambiguousNameKeys = new Set<string>();
  for (const name of files) {
    const file = `.mole/arguments/captured/${name}`;
    const rows = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as CapturedArgument[];
    for (const row of rows) {
      if (row.status !== 'approved') continue; // draft/rejected: never a graph node (prior-art.md #1)
      if (row.stale) continue; // review 3 HIGH 2: history only, never a node, even if once approved
      if (b.has(row.id)) {
        b.problems.push({ file, line: row.span.startLine, message: `duplicate argument id '${row.id}': already defined elsewhere (this captured argument skipped)` });
        continue;
      }
      b.node({
        id: row.id,
        kind: 'argument',
        title: row.text,
        status: 'recorded',
        statusText: row.role,
        format: 'argdown',
        file: row.span.file,
        line: row.span.startLine,
        scope: [],
        evidence: [],
        fields: {},
      });
      if (row.role === 'claim' || row.role === 'considered-option') {
        const name = row.role === 'claim' ? 'claim' : sameName(optionNameOf(row.text));
        const key = `${row.decisionId}::${name}`;
        if (ambiguousNameKeys.has(key)) continue; // already known ambiguous -- never resurrect it
        const prior = nameToId.get(key);
        if (prior !== undefined && prior !== row.id) {
          // review 3 HIGH 1: two CURRENT nodes share this normalized name -- never pick either one as an
          // edge target; capture/arguments.ts already refused to attach a Pros-and-Cons bullet to this
          // name for the same reason, this is the loader's own belt-and-suspenders against the same bug
          // reaching the graph via a hand-authored id or stored data from before that fix existed.
          ambiguousNameKeys.add(key);
          nameToId.delete(key);
          continue;
        }
        nameToId.set(key, row.id);
      }
    }
  }

  // PASS 2: edges. Resolve every CURRENT, approved row's `attacksNames`/`supportsNames` against the name
  // map built above -- `row.attacks`/`row.supports` themselves are never read here (review 3's whole
  // point: a positional id, once written, is never re-validated against what it currently means).
  for (const name of files) {
    const file = `.mole/arguments/captured/${name}`;
    const rows = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as CapturedArgument[];
    for (const row of rows) {
      if (row.status !== 'approved' || row.stale) continue;
      for (const targetName of row.attacksNames ?? []) {
        const to = nameToId.get(`${row.decisionId}::${sameName(targetName)}`);
        if (to === undefined) continue; // renamed/deleted/ambiguous target -- never fabricate an edge
        b.edge({ from: row.id, to, type: 'attacks', file, line: row.span.startLine });
      }
      for (const targetName of row.supportsNames ?? []) {
        const to = nameToId.get(`${row.decisionId}::${sameName(targetName)}`);
        if (to === undefined) continue;
        b.edge({ from: row.id, to, type: 'supports', file, line: row.span.startLine });
      }
    }
  }
}
