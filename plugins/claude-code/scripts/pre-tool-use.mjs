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
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { clip, crispViolationsForContent, decisionsBlock, emit, findMole, governingDecisions, hasAnyRules, loadAddedDecisions, readInput, repoRoot, ruleFixHint, sameFormRoot, saveAddedDecisions, steerDeliverText, violationKey } from './lib.mjs';

// T92/D102: deny an Edit/Write/MultiEdit whose NEW content adds a crisp (zero-model, deterministic) decision-rule
// violation -- Anthropic's own worked PreToolUse example is exactly this shape (hookSpecificOutput.permissionDecision
// "deny" + permissionDecisionReason; fetched 2026-11-04, code.claude.com/docs/en/hooks#pretooluse-decision-control;
// see 4 log/prior-art.md). By-meaning/judged matches never deny here -- only a rule a decision record itself wrote
// (packages/decisions/src/rules, T27) counts; those stay advisory text (decisionsBlock below), never a block.
// Fast path (M31a's p95 budget): hasAnyRules() is a text scan, no subprocess, so a repo with no rules: at all never
// pays for the two `mole rules` calls below. SOURCE mirrors packages/decisions/src/rules/check.ts's own file filter:
// rules only ever match TS/JS, so a non-source file is skipped before even that scan.
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** The file's content Claude Code's own Edit/Write/MultiEdit would produce, computed the same way Claude Code
 * itself would (first-match replace by default, every match with replace_all). undefined when the tool kind isn't
 * one we simulate, or when an old_string isn't found in the current content (that edit will fail on its own;
 * never guess, never block on a guess). */
function prospectiveContent(toolName, toolInput, current) {
  if (toolName === 'Write') return typeof toolInput.content === 'string' ? toolInput.content : undefined;
  const applyOne = (text, oldS, newS, replaceAll) => {
    if (typeof oldS !== 'string' || typeof newS !== 'string' || typeof text !== 'string' || !text.includes(oldS)) return undefined;
    return replaceAll ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  };
  if (toolName === 'Edit') return applyOne(current, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
  if (toolName === 'MultiEdit') {
    let text = current;
    for (const e of Array.isArray(toolInput.edits) ? toolInput.edits : []) {
      text = applyOne(text, e.old_string, e.new_string, e.replace_all);
      if (text === undefined) return undefined;
    }
    return text;
  }
  return undefined;
}

/** Deny reason text, or undefined (allow silently). T92 review-1 fix (HIGH 1): this NEVER writes to the real
 * path `abs` -- the real file is only ever read. Both the "before" (current content) and "after" (prospective
 * content) crisp-rule checks run on a throwaway overlay (lib.mjs's crispViolationsForContent / buildOverlay),
 * so a crash, SIGKILL or timeout mid-check can never leave the user's file holding a prospective, never-applied
 * edit (see lib.mjs's "T92 review-1 fix: never write the real file" section for the full prior-art citation). */
function crispDenyReason(root, mole, abs, rel, toolName, toolInput) {
  if (!hasAnyRules(root) || !SOURCE.test(rel)) return undefined;
  let original;
  try {
    original = readFileSync(abs, 'utf8');
  } catch {
    original = undefined;
  }
  const prospective = prospectiveContent(toolName, toolInput, original);
  if (prospective === undefined || prospective === original) return undefined; // can't simulate, or a no-op
  const before = crispViolationsForContent(mole, root, rel, original);
  const after = crispViolationsForContent(mole, root, rel, prospective);
  const beforeKeys = new Set(before.map(violationKey));
  const added = after.filter((v) => !beforeKeys.has(violationKey(v)));
  if (!added.length) return undefined;
  const lines = added.map((v) => `- ${rel}:${v.line} ${v.kind} ${v.target} breaks ${v.decision.id} "${v.decision.title}" \u2014 fix: ${ruleFixHint(v)} (rule ${v.rule} at ${v.decision.file}:${v.decision.line})`);
  return `Mole: this edit adds ${added.length} accepted-decision rule violation${added.length === 1 ? '' : 's'} (mole rules, zero-model, deterministic -- not a guess):\n${lines.join('\n')}\n\nFix the code instead, or get the decision changed.`;
}

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
  // T92/D102: deny takes priority -- a crisp-rule violation this edit itself adds stops the tool call outright,
  // before any advisory decisions-context is computed for it (Edit/Write/MultiEdit only; hooks/hooks.json's
  // matcher).
  if (['Edit', 'Write', 'MultiEdit'].includes(input.tool_name)) {
    const deny = crispDenyReason(root, mole, abs, rel, input.tool_name, input.tool_input ?? {});
    if (deny) {
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: clip(deny, 4000) } });
      return;
    }
  }
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
