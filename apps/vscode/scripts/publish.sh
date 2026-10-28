#!/bin/sh
# Builds the .vsix and publishes it to Open VSX and the VS Code Marketplace.
# Tokens are typed into hidden prompts: never stored in a file, never on the command line history, never in chat.
# Needs (see PUBLISH.md): an Open VSX token + namespace "raychu23", a Marketplace publisher "raychu23" + PAT. Press Enter to skip either.
set -e
cd "$(dirname "$0")/../../.."
npm run package -w @mole/vscode
VSIX=$(ls apps/vscode/mole-code-map-*.vsix | head -1)
echo "package: $VSIX"

printf 'Open VSX token (hidden, Enter to skip): '; stty -echo; read OVSX_PAT; stty echo; echo
if [ -n "$OVSX_PAT" ]; then
  npx ovsx create-namespace raychu23 -p "$OVSX_PAT" || echo "(namespace probably exists already)"
  npx ovsx publish "$VSIX" -p "$OVSX_PAT"
fi

printf 'VS Code Marketplace token (hidden, Enter to skip): '; stty -echo; read VSCE_PAT; stty echo; echo
if [ -n "$VSCE_PAT" ]; then
  npx vsce publish --packagePath "$VSIX" -p "$VSCE_PAT"
fi
unset OVSX_PAT VSCE_PAT
echo "done. check: https://open-vsx.org/extension/raychu23/mole-code-map  https://marketplace.visualstudio.com/items?itemName=raychu23.mole-code-map"
