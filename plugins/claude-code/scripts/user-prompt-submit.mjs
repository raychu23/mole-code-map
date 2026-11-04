#!/usr/bin/env node
// UserPromptSubmit hook (T64): before the model reads the task, add the team decisions the prompt is ABOUT -- decisions
// with no file scope (or scope: repo-wide), ranked by meaning (BM25 over each record's title + rationale, zero model
// calls, lib.mjs bm25Rank mirrors T53's route/bm25.ts). Each decision at most once per session (shared with PreToolUse).
// Never blocks (no "decision": "block"); nothing relevant, no repo, or bad input = no output, exit 0.
// Output: https://code.claude.com/docs/en/hooks#userpromptsubmit  hookSpecificOutput.additionalContext
import { clip, decisionsBlock, emit, governingDecisions, loadAddedDecisions, readInput, repoRoot, saveAddedDecisions, steerDeliverText, findMole } from './lib.mjs';

function main() {
  const input = readInput();
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const root = repoRoot(input.cwd || process.cwd());
  if (!root) return;
  const mole = findMole(root);
  const steer = steerDeliverText(mole, root, input.session_id); // T74: a signal/accepted update seen on the next prompt
  const parts = [];
  if (prompt.trim()) {
    const list = governingDecisions(undefined, root, new Set(), { text: prompt });
    const already = loadAddedDecisions(input.session_id);
    const fresh = list.filter((d) => !already.has(d.id));
    if (fresh.length) {
      for (const d of fresh) already.add(d.id);
      saveAddedDecisions(input.session_id, already);
      parts.push(decisionsBlock(fresh, 'Mole: team decisions that may bear on this task (word matches, ranked; follow the ones that apply)'));
    }
  }
  if (steer) parts.push(steer);
  if (!parts.length) return;
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: clip(parts.join('\n\n')) } });
}

try {
  main();
} catch (e) {
  process.stderr.write(`mole user-prompt-submit hook: ${e.message}\n`);
}
process.exitCode = 0;
