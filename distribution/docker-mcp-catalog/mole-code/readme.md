# Mole MCP server (Docker MCP catalog entry)

TODO before submitting this PR to github.com/docker/mcp-registry: the real 40-character commit SHA of the
tagged release this entry pins to (CONTRIBUTING.md requires a real pin for `type: server`, not a placeholder;
see `server.yaml` in this folder, source.commit is still all-zeros here). Fill it in once a tagged release of
https://github.com/raychu23/mole-code-map exists with a Dockerfile Docker's `task build` can actually run
(the GHCR release workflow already builds `deploy/Dockerfile`, which is the TEAM server, not this MCP
server -- a lightweight Dockerfile wrapping just `mole-mcp` over stdio would need to be added first, or this
entry resubmitted as `type: remote` once `mole-mcp-http` has a public URL instead).

Docs: https://github.com/raychu23/mole-code-map/blob/main/docs/mcp.md

Mole keeps the team's decisions, tenets and exceptions beside the code they govern, in plain `.mole/`
markdown files, and surfaces them in the editor, the agent harness (Claude Code plugin hooks) and here as an
MCP server. Every tool is read-only: no writes to your repo, no model calls from the MCP tools themselves.
