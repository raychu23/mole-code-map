# Mole for Claude Code

Agent-memory plugins (claude-mem, ai-memory, Copilot Memory) carry what the agent did forward to the
next agent. This plugin runs the other direction: it carries the **PEOPLE's decisions** (`.mole/tenets.md`,
`.mole/decisions/*.md`) to the agent, and reports the agent's effect on them back to the person — the
center of Mole (D31: tenets → decisions → exceptions → code/tests/incidents/people, shown where the
developer already works).

## Hooks

- **SessionStart** — the decisions and tenets governing the files in play (uncommitted edits + the last
  3 commits), each as a rule to follow with its current flag (red/yellow/green/grey) and its owner
  (`approver:`), plus your existing notes on those files and any parallel-run collisions. Falls back to
  `(weak spots from T35: not available yet)` until T35 (agent coverage) lands; shows weak spots inline
  once it does.
- **PreToolUse** (`Edit`/`Write`/`MultiEdit`) — when the file you are about to edit is governed by a
  decision, adds that decision's rule once per session (never twice: it only ever adds context next to
  the tool result). T92/D102: if the NEW content you are about to write would itself add a crisp
  (zero-model, deterministic — `mole rules`, T27 import/call rules written in a decision record) rule
  violation, the tool call is **denied** (`permissionDecision: "deny"`, with the decision id, the rule and
  a fix hint in the reason) instead of applied. A pre-existing violation elsewhere in the file, or any
  by-meaning/judged match, never denies — only a violation THIS edit adds does. **Per-edit, never writes the
  real file (T92 review-1 fix):** the "before" (current content) and "after" (prospective content) checks
  both run on a disposable overlay directory, never on your actual file — the same no-crash-can-corrupt-it
  pattern as `eslint --stdin --stdin-filename` (eslint never opens the file it lints when content is piped
  in). A crash, SIGKILL or timeout mid-check leaves your file byte-identical, always.
- **Stop** — the decisions your session's diff touched (with their new flag), any decision-rule
  violations the diff introduced (T27 `mole rules`, citing the decision id), then the existing past
  fixes, questions, claims and parallel-run collisions. T92/D102: a crisp rule violation in the diff
  **blocks Claude from stopping by default** (`decision: "block"`, reason names the decision id, the
  rule and a fix hint) — the exact contract Anthropic's own hooks docs ship for Stop. By-meaning/judged
  matches (the separate cascade verifier, `MOLE_STOP_VERIFY`) stay advisory text only, never a block.
  **Only a violation THIS SESSION introduced blocks (T92 review-1 fix):** a violation already in the file
  before SessionStart — whether already committed to HEAD, or already sitting uncommitted in your working
  tree — never blocks, even if the session's own edit touches that same file elsewhere. SessionStart
  snapshots every already-dirty file as a git blob (`git hash-object -w`, which only writes to
  `.git/objects` — it never touches the working tree or the index); Stop compares each file's violations
  now against that recorded baseline (or the file's content at the session's starting commit, for a clean
  file) on the same kind of disposable overlay PreToolUse uses, and blocks only on a violation key (decision
  id + rule + file + target — never the line number, since an unrelated edit can shift it) present now but
  absent from the baseline. Honors `stop_hook_active` (never blocks twice in the same continuation) plus its
  own small per-session cap (`MOLE_STOP_BLOCK_CAP`, default 3) on top of Claude Code's own built-in
  8-consecutive-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) — so a condition that never resolves
  can't loop forever.
  **Opt out:** `MOLE_STOP_BLOCK=0` turns the Stop block off and keeps the old inform-only behavior (the
  violation still shows as text); `PreToolUse`'s deny has no separate opt-out today — fix the code, or
  change the decision's `rules:`.
  **PreToolUse vs Stop, in one line:** PreToolUse checks one edit (current file content vs the content that
  edit would produce) at the instant it happens; Stop checks the whole session (file content at
  SessionStart vs file content now) at the instant Claude tries to finish — so Stop also catches a violation
  PreToolUse's `Edit|Write|MultiEdit` matcher never saw (a shell command, a merge, a tool outside that set).

Same content is available from the MCP server (`mole_check` / `mole_decisions`, both with a `files`
argument) so Codex, Cursor and any other MCP-capable harness gets the same decisions-first context, not
only Claude Code.

A hook never fails your session: on any error it exits 0 and prints nothing.

## Install outside the Mole repo

This plugin only needs the files in this directory — no Mole repo checkout, no `npm install`. Before
distributing it (via the repo-root `.claude-plugin/marketplace.json`, or by copying the directory
yourself), build it once from inside the Mole repo:

```
npx tsc -b                                   # builds the workspace packages this plugin's CLI/MCP bundle from
node plugins/claude-code/scripts/build.mjs   # bundles them into plugins/claude-code/dist/ (esbuild)
```

That produces `dist/cli.js` (the `mole` CLI), `dist/worker.cjs` (the daemon's index worker), and
`dist/mcp.cjs` (the MCP server) — all CommonJS, all self-contained. `.mcp.json` and every hook script
already resolve these through `${CLAUDE_PLUGIN_ROOT}`, so a copy of this directory (with its built `dist/`)
works from anywhere.

### Native module (better-sqlite3)

`dist/node_modules/better-sqlite3/` ships this build machine's prebuilt native binary, used by
`mole collisions` / `mole runs` / `mole tried` / `mole agents` (via `@mole/agentstate`'s LangGraph SQLite
checkpointer) and by `mole runs --export langgraph`. On a different OS/CPU architecture than the one that
ran `build.mjs`, that binary won't load — those specific commands then fail inside the bundled CLI, and
every hook script already tolerates that the same way it tolerates any other CLI failure: it catches the
non-zero exit, writes one line to stderr (visible only in Claude Code's debug log), and otherwise says
nothing for that section rather than failing your session. Re-run `build.mjs` on the target platform to
pick up its own native binary.

### dependency-cruiser (`mole rules`)

Vendored into `dist/node_modules/dependency-cruiser/` from this repo's own install at build time (T86/D97;
earlier builds left it external and required a real `npm install` next to the bundled CLI — see
`(internal reference removed) insights.md` for why vendoring replaced that). It is pure ESM with a
top-level `await`, which still cannot go into this plugin's CommonJS bundles (same constraint
`apps/vscode/esbuild.mjs` documents for the VS Code extension's daemon bundle), so it is copied as files
rather than bundled — `mole rules` and the decision-rule-violation lines in the Stop hook's output work with
no extra install step.
