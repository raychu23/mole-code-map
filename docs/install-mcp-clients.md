# Install `mole-mcp` in any MCP client

## Summary
What: one-click install links (Cursor, VS Code) and copy-paste config snippets for every other MCP-capable
agent harness we researched, all pointing at the same `mole-mcp` stdio command (`npx -y -p mole-code
mole-mcp`, or `mole-mcp` directly once `npm install -g mole-code`). What's open: `mole-code` is not
published to npm yet (T85/T86, waiting on the team tokens) -- every link/snippet below is correct syntax,
verified by decoding/parsing locally, but none has actually been clicked/run against a real published
package (NOT RUN: no Cursor/VS Code/Gemini/Codex apps in this build environment, and the package isn't live
on npm yet either).

Per `(internal reference removed) Agentic workflow + integrations.md` §10.1 ("every tool now plugs into every
other... use those connections, don't compete on them"): every entry below plugs Mole into a harness's own
EXISTING MCP config mechanism -- nothing here is a new Mole-specific install path.

## One-click install

Cursor (format: `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_CONFIG`, source:
cursor.com/docs/mcp/install-links, fetched 2026-11-04, see 4 log/prior-art.md):

[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_mole--mcp-000000?logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=mole&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwibW9sZS1jb2RlIiwibW9sZS1tY3AiXX0=)

```
cursor://anysphere.cursor-deeplink/mcp/install?name=mole&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwibW9sZS1jb2RlIiwibW9sZS1tY3AiXX0=
```

VS Code / VS Code Insiders (format: `https://insiders.vscode.dev/redirect/mcp/install?name=$NAME&config=$URLENCODED_CONFIG`,
confirmed via a real published example, support.atlassian.com's Atlassian MCP docs, fetched 2026-11-04):

[![Add to VS Code](https://img.shields.io/badge/VS_Code-Add_mole--mcp-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=mole&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22mole-code%22%2C%22mole-mcp%22%5D%7D)

```
https://insiders.vscode.dev/redirect/mcp/install?name=mole&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22mole-code%22%2C%22mole-mcp%22%5D%7D
```

## Codex CLI (`~/.codex/config.toml` or project `.codex/config.toml`)

Source: developers.openai.com/codex/mcp, fetched 2026-11-04.

```toml
[mcp_servers.mole]
command = "npx"
args = ["-y", "-p", "mole-code", "mole-mcp"]
```

Or via the CLI: `codex mcp add mole -- npx -y -p mole-code mole-mcp`

## Continue (`.continue/mcpServers/mole.yaml` in your workspace)

Source: docs.continue.dev/customize/deep-dives/mcp, fetched 2026-11-04.

```yaml
name: Mole MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: Mole
    command: npx
    args: ["-y", "-p", "mole-code", "mole-mcp"]
```

## opencode (`opencode.json`, project root or `~/.config/opencode/`)

Source: opencode.ai/docs/config, fetched 2026-11-04.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mole": {
      "type": "local",
      "command": ["npx", "-y", "-p", "mole-code", "mole-mcp"],
      "enabled": true
    }
  }
}
```

## Goose (`~/.config/goose/config.yaml`)

Source: mintlify docs for aaif-goose/goose (formerly block/goose), fetched 2026-11-04.

```yaml
extensions:
  mole:
    type: stdio
    name: mole
    enabled: true
    cmd: npx
    args: ["-y", "-p", "mole-code", "mole-mcp"]
```

Or one-shot: `goose session --with-extension "mole:npx -y -p mole-code mole-mcp"`

## Windsurf (`~/.codeium/windsurf/mcp_config.json`)

Source: mcpbundles.com/blog/windsurf-mcp-tools, fetched 2026-11-04 (Windsurf's own built-in MCP Marketplace
does one-click installs only for servers it has indexed; anything else is this manual file).

```json
{
  "mcpServers": {
    "mole": {
      "command": "npx",
      "args": ["-y", "-p", "mole-code", "mole-mcp"]
    }
  }
}
```

## Remote (streamable HTTP), once `mole-mcp-http` is running

Any client that takes a URL instead of a spawned process (Docker MCP Toolkit's "remote" server type,
Smithery's URL-publish flow, VS Code/Cursor's `"type": "http"` server entry) can point at:

```json
{ "type": "http", "url": "http://127.0.0.1:3917/mcp" }
```

Start it with `npx -y -p mole-code mole-mcp-http` (binds to 127.0.0.1 by default; see
`packages/mcp/src/http.ts` for why this has no auth layer -- same local-trust model as the stdio form,
documented in `docs/mcp.md`'s Limits section).
