# Code map (VS Code panel, CLI, MCP)

This is the original `mole-code-map` feature, unchanged in behavior and kept as one part of this project
(D99): a map of the file you're looking at, in a panel beside the code.

## How to use

- **VS Code:** open a TypeScript file; the Mole panel shows what the symbol under your cursor defines, what
  it calls, what calls it, and who imports the file. Click a box to jump to that line.
- **CLI:** `mole map <path | path#Symbol | symbol>` (read-only neighbourhood query) or `mole impact <...>`
  (same query, plus what the symbol's change could reach).
- **MCP:** the `mole_map` tool, same query shape, for any MCP-connected agent.

The first call to `map`/`impact`/the panel starts a short-lived per-repo background daemon (`packages/daemon`)
that indexes the repo with the TypeScript compiler API into SQLite (`node:sqlite`) and serves queries over a
local JSON-RPC socket; it stops itself after 30 idle minutes by default (`--idle-minutes 0` to disable).

## What it reads / writes

- **Reads:** your TypeScript/TSX source files and `tsconfig.json` (or `--tsconfig`/`--src-dir` overrides).
- **Writes:** the index database under `.mole/` (or `--state-dir`) in your repository. No network call, no
  telemetry, no AI model call.

## Limits

- TypeScript/TSX only.
- Neighbourhood lists are capped (originally 25 boxes in the VS Code panel) to keep the view readable on a
  large fan-in/fan-out symbol.
- Tested on macOS so far; other platforms are expected to work (pure TS compiler + SQLite) but are less
  exercised.
