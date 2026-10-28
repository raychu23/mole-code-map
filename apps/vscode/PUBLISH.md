# Publishing Mole

## Release facts
- License: MIT (`LICENSE`). Publisher id `raychu23`. Source: https://github.com/raychu23/mole-code-map
- The public repository is a clean copy of a larger private working repository, made by `scripts/export-public.mjs` (allowlist, private-string scan).
  Dev-only scripts here (`selftest.mjs`, `install-check.mjs`, `../../packages/daemon/bench/m1.mjs`) are internal proof tools: they need `FIXTURE=<a TypeScript repo copy>` and write their reports to a `generated data/` folder next to the repo.

## Maintainer steps (need the owner's own logins): two accounts, then one command
Run `apps/vscode/scripts/publish.sh` after steps 1 and 2. It builds the package and asks for each token in a hidden prompt.

### 1. Open VSX (VSCodium, and the forks that use it; Cursor/Windsurf: check their settings, they change)
1. https://open-vsx.org , Log in with GitHub (account raychu23).
2. Sign the Eclipse Publisher Agreement: user settings → "Log in with Eclipse" (an Eclipse account is free), then agree to the agreement.
3. https://open-vsx.org/user-settings/namespaces , create namespace `raychu23`.
4. https://open-vsx.org/user-settings/tokens , Generate new token (any description). Copy it; paste it only into the hidden prompt.

### 2. VS Code Marketplace
1. https://marketplace.visualstudio.com/manage/createpublisher , sign in with a Microsoft account, create publisher with **ID `raychu23`**, any display name.
2. Personal access token: https://dev.azure.com , user settings (top right) → Personal access tokens → New Token: Organization **All accessible organizations**, Scopes → Custom defined → **Marketplace → Manage**. (If dev.azure.com asks you to create an organization first, do that, free.) Copy the token; paste it only into the hidden prompt.

### 3. After publishing
Open https://open-vsx.org/extension/raychu23/mole-code-map and https://marketplace.visualstudio.com/items?itemName=raychu23.mole-code-map , check the screenshot loads, then update the README line "Planned: Open VSX ..." in `apps/vscode/README.md` and `scripts/public-README.md`.

## Before every later release
`npm run check`; `npm run package -w @mole/vscode`; `node apps/vscode/scripts/install-check.mjs <vsix>` with `FIXTURE=<a TypeScript repo copy>`; bump `version` in `apps/vscode/package.json`, add a CHANGELOG line;
`node scripts/export-public.mjs <dir>` and push the result to the public repo.

## Limits to keep saying
- Tested on macOS only (VS Code 1.141, Node 24). VS Code 1.101 to 1.122 (Node 22, the manifest minimum) not run. Windows/Linux not run.
- Remote development (SSH, containers, WSL): untested.
- Never publish a screenshot that shows more than the editor window (menu bar, other apps, names).
