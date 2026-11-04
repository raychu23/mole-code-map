# mole-code

One npm package (D97) carrying:

- `mole` — the daemon CLI: `mole map`, `mole impact`, `mole check`, `mole rules`, `mole decisions`,
  `mole note add`, `mole memory`, and more. Run `mole --help` for the full list.
- `mole-mcp` — the same functionality as an MCP stdio server, for Claude Code / Cursor / any MCP client.
  Point your MCP client's command at `mole-mcp` (no args; `MOLE_ROOT` env var picks the repo, default cwd).
- The Claude Code plugin itself: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `scripts/*.mjs`,
  `.mcp.json`. This package's own installed directory IS the plugin directory Claude Code reads when
  `.claude-plugin/marketplace.json` lists it with an `npm` source (`{"source": "npm", "package":
  "mole-code"}`) — see `code.claude.com/docs/en/plugins/marketplace-reference`.

Not published yet (T85/T86); built here so a person outside this monorepo can `npm install` it, and so
Claude Code can fetch it as a plugin, without a full repo checkout.

## Install

```sh
npm install -g mole-code      # or: npx mole-code --help
```

Requires Node >= 22.13 (uses the built-in `node:sqlite`, which is stable but still warns
"SQLite is an experimental feature" on the console — that warning is expected).

Both commands work from any TypeScript repository; most subcommands (`rules`, `decisions`, `check`,
`note`, `memory`) need no daemon and no build step. `map`/`impact`/`daemon` spawn a short-lived
background daemon per repo (see `dist/worker.cjs` next to `dist/cli.js`: do not remove it).

## How it is built

`tools/build.mjs` is this package's own build (never shipped — see `files` in `package.json` and
`.gitignore`). It:

1. Bundles `packages/daemon/src/cli.ts` (+ its worker thread) and `scripts/mcp-entry.ts` (the MCP server
   as CommonJS — not `packages/mcp/src/cli.ts` directly, see that file's header) straight from TypeScript
   source with esbuild, via the repo-root shared step `scripts/bundle-daemon.mjs` — the same step
   `apps/vscode/esbuild.mjs` and `plugins/claude-code/scripts/build.mjs` use.
2. Vendors `dependency-cruiser` (pure JS, but ESM + top-level `await`, which cannot go into a CJS bundle)
   and `better-sqlite3` (native addon, which esbuild cannot bundle at all; pulled in transitively by
   `@mole/agentstate`'s LangGraph SQLite checkpointer) into `dist/node_modules/`, copied from this repo's
   own install, instead of listing either as a `dependency` of this package. Why: Claude Code's npm
   plugin source "fetches the package with your npm client. The package's install scripts ... never run,
   and its dependencies aren't installed during the fetch" (code.claude.com/docs/en/plugins/
   marketplace-reference, fetched 2026-11-03) — a real `dependencies` entry is not guaranteed to be
   usable at the point Claude Code needs it, so the bundle in the tarball (D97's chosen option) has to
   mean *everything* it needs, not just the JS. `better-sqlite3` vendors only this build machine's
   prebuilt `.node` binary (no universal binary exists); a different OS/arch degrades gracefully — every
   call site already tolerates a non-zero CLI exit.
3. Copies the plugin files (`plugin.json`, `hooks.json`, `.mcp.json`, the hook scripts) from
   `plugins/claude-code`, this repo's single source of truth for them — never hand-duplicated here.
4. Copies `LICENSE` from the repo root (`npm pack --dry-run` lists it under `files`).

```sh
npm run build   # -> dist/cli.js, dist/worker.cjs, dist/mcp.cjs, .claude-plugin/, hooks/, scripts/, .mcp.json, LICENSE
npm test        # npm pack + install the tarball into an isolated temp dir + exercise the CLI and MCP bins
```

## Testing in isolation

`tools/test-install.mjs` runs `npm pack`, installs the resulting tarball into a fresh temp directory
that has **no access to this repo's `node_modules`**, then from there: `mole --help`, `mole rules` and
`mole check --worktree` against a tiny scratch git repo with one `.mole/decisions` rule, plus a real
MCP `initialize` + `tools/list` JSON-RPC exchange with `mole-mcp` over stdio. It never publishes
anything. The fuller marketplace-shaped checks (treating the installed package directory as a Claude
Code plugin root and running all four hooks, plus a marketplace-clone check) live in
`plugins/claude-code/test/mole-code-pack.test.ts` and `.../marketplace-npm-source.test.ts`.
