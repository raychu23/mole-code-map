# MCP server (`mole-mcp`)

## How to use

`mole-mcp` is a stdio MCP server bundled in the `mole-code` npm package. Point any MCP client's command at
it with no arguments; it picks the repo from `MOLE_ROOT` (env var) or the current working directory. See the
root README's "Install → MCP, any client" section for Codex/Cursor/Gemini CLI/Claude Desktop config
snippets.

Exposed tools mirror the CLI's read paths (map/impact, decisions, check, recall, outcomes, and more — see
`packages/mcp` for the exact tool list and schemas shipped in a given version). All are read-only queries
over the same on-disk state the CLI and VS Code extension use; none of them write to your repo or call out
to a model.

## What it reads / writes

- **Reads:** the same files as the equivalent CLI command (source tree, `.mole/decisions`, `.mole/notes`,
  the index database).
- **Writes:** nothing from the MCP tools themselves. The first `mole_map`/`mole_impact` call may start the
  same short-lived background daemon the CLI's `map`/`impact` commands do, which writes the index under
  `.mole/`.

## Limits

- No authentication layer: anything that can start the `mole-mcp` process can query your repo's decisions
  and map — treat it like any other local dev tool, not a networked service (it only ever listens on stdio).
- Same per-feature limits as the CLI commands it mirrors (TypeScript-only indexing, rule-graph-only
  enforcement, etc.) — see the other docs pages.
