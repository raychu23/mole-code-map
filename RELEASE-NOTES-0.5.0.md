# Mole 0.5.0

## VS Code extension

- New "Reasoning" section in the sidebar: the audience/value order currently in force, what changes
  if you flip it, open incidents that could revive a past decision, and open proposal branches
  compared against what's already approved. It reads the same data an agent sees through MCP.
- A "compare with a different order" box in that section: a what-if, never writes anything.
- Nothing else in the panel changed. The extension's build now shares its daemon-bundling step with
  the new npm package below -- a packaging change, not a behavior change (checked: identical output
  bytes before/after).

## New: one npm package, `mole-code`

`mole-code` bundles the `mole` CLI, the `mole-mcp` MCP server, and the Claude Code plugin files in a
single installable package, so Claude Code's npm plugin source and any MCP client (Codex, Cursor,
Gemini CLI, etc.) can point at one name instead of a repo checkout.

## New: MCP registry listing

A `server.json` at the repo root describes `mole-code`'s MCP server for the official MCP registry
(modelcontextprotocol.io), under `io.github.raychu23/mole-code`.

## New: container release workflow

Tagging a release (`v*`) now builds the team server's Docker image and pushes it to
`ghcr.io/raychu23/mole-server`, using only GitHub's own repo-scoped token.

## Honest limits

- Only tested on macOS (arm64), VS Code 1.141, Node 22. Not run on Windows, Linux, or older VS Code
  versions down to the manifest minimum (1.101). Remote development (SSH/containers/WSL): untested.
- T63's held-out benchmark did not yet show a measurable productivity gain from the reasoning engine
  on real tasks -- the sidebar surfaces it, but "surfacing more" is not proven to make the agent (or a
  person) decide faster or better yet. Treat the reasoning section as a transparency feature for now,
  not a proven win.
- Steering (letting a person nudge a running agent mid-task) and several reasoning inputs added since
  0.4.0 (outcome tracking, assurance, code-ownership coupling, hotspots, case recall, argument capture)
  are CLI/MCP-only in this release -- there is no sidebar UI for them yet.
- Nothing in this release was published by the build process. the team runs `scripts/publish-all.sh`
  himself and types each token into its own hidden prompt.
