#!/usr/bin/env node
// PreToolUse hook (T37, matcher "Edit|Write" in hooks.json): when the edit touches lines a decision governs, add that
// decision once as additionalContext next to the tool result. Never blocks (no permissionDecision: "deny"/"ask" is ever
// returned) and adds each decision id at most once per session (tracked in the plugin's session state dir).
// Output: https://code.claude.com/docs/en/hooks#pretooluse . Nothing new to say = no output, exit 0.
//
// T74 review 1 (HIGH 1): the matcher was briefly widened to "*" so a pending `mole steer` note reached the agent on
// ANY tool call, not only Edit|Write. That made this hook run for Read/Bash/etc too, and -- because this file
// branches only on tool_input.file_path (every tool that touches a path sets it, including Read), never on
// tool_name -- the FULL decisions block (governingDecisions + decisionsBlock) fired on those calls as well, not
// just the T74 steering text. Matcher is restored to exactly "Edit|Write" (hooks/hooks.json); the decisions control
// flow below is byte-for-byte the pre-T74 logic (see this task's own internal log's "Review 1" capture,
// which diffs this file's additionalContext against the pre-T74 base commit for the same inputs and finds zero
// difference). Steering is now delivered only here (PreToolUse, already Edit|Write-only again) and in
// UserPromptSubmit -- never on every tool call -- so a signal reaches the agent before its very next edit or next
// prompt, exactly the contract's wording, without re-introducing the Read-time decisions regression.
import { relative, resolve } from 'node:path';
import { clip, decisionsBlock, emit, findMole, governingDecisions, loadAddedDecisions, readInput, repoRoot, sameFormRoot, saveAddedDecisions, steerDeliverText } from './lib.mjs';

function main() {
  const input = readInput();
  const root = repoRoot(input.cwd || process.cwd());
  if (!root) return;
  const path = input.tool_input?.file_path ?? input.tool_input?.path;
  if (!path) return;
  const mole = findMole(root);
  if (!mole) return;
  const abs = resolve(input.cwd || root, path);
  // the path Claude Code sends follows the session's own cwd form (e.g. /tmp/... on macOS, where root as returned by
  // git is realpath'd to /private/tmp/...); compare both in the same form or every match looks like it is outside
  // the repo (same issue lib.mjs's sameFormRoot already fixes for T21's collisions matching).
  const formRoot = sameFormRoot(root, input.cwd);
  const rel = relative(formRoot, abs);
  if (rel.startsWith('..')) return; // outside the repo: nothing for Mole's decisions to govern
  // T64: unscoped / repo-wide decisions ranked by meaning against the edited path + the new text (clipped)
  const newText = String(input.tool_input?.new_string ?? input.tool_input?.content ?? '').slice(0, 4000);
  const list = governingDecisions(mole, root, new Set([rel]), { text: `${rel}\n${newText}` });
  const already = loadAddedDecisions(input.session_id);
  const fresh = list.filter((d) => !already.has(d.id));
  const parts = [];
  if (fresh.length) {
    for (const d of fresh) already.add(d.id);
    saveAddedDecisions(input.session_id, already);
    parts.push(decisionsBlock(fresh, fresh.every((d) => d.matchedTargets?.includes('by meaning')) ? `Mole: decisions that may bear on ${rel} (word matches; check each applies)` : `Mole: ${rel} is governed by`));
  }
  // T74 (review 1 fix): this hook only ever runs on Edit|Write now (matcher restored above), so delivering steering
  // here already satisfies "before the agent's very next edit" without widening the matcher back to "*".
  const steer = steerDeliverText(mole, root, input.session_id);
  if (steer) parts.push(steer);
  if (!parts.length) return; // nothing fresh to say this call (done-when 3) and nothing steered: no repeat
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: clip(parts.join('\n\n')) } });
  // intentionally no permissionDecision field: Claude Code allows the tool call as normal (never a block)
}

try {
  main();
} catch (e) {
  process.stderr.write(`mole pre-tool-use hook: ${e.message}\n`);
}
process.exitCode = 0; // never fail the session, never block the tool call
