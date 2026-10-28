# Mole: a map of the file you are looking at

Open a TypeScript file and Mole shows a small map of it in a panel beside the code: what is inside the file,
which other code uses it, which code it uses, and which files import it. Click any box and the editor jumps to
that exact line. The map follows you as you move between files.

![Mole panel next to the code](media/panel.png)

*Mole on the [Excalidraw](https://github.com/excalidraw/excalidraw) source (MIT), file `binding.ts`.*

Think of it as the "you are here" sign in a shopping mall, but for code. It is meant for people who are new to a
codebase, and for reviewers who want to see how a change connects to the rest.

## What you see

| Box group | Meaning |
|---|---|
| defines | the functions, classes and variables in this file |
| called by | code that calls something in this file, at the line where the call happens (`×3` = three call sites) |
| calls | code this file calls, at the line where it is defined |
| imported by / imports | files that import this file, and files this file imports |
| Impact (button) | highlights everything that would be affected, up to three calls away, if you changed this file |

The map shows at most 25 boxes; the rest is summarised as "+N more".

## Install

Install the `.vsix` file with `code --install-extension mole-code-map-<version>.vsix` (or Extensions view → ⋯ → Install from VSIX).
It is also on Open VSX (VSCodium, and the forks that use it) and the VS Code Marketplace. Needs VS Code 1.101 or newer. The panel opens by itself in workspaces that contain TypeScript; in any other
workspace Mole stays silent (run **Mole: Open map beside the code** to start it anyway).

## Privacy

Everything runs on your machine. Mole makes no network requests, collects no telemetry and calls no AI model.
It reads your source files with the TypeScript compiler and keeps its index in `.git/mole` inside the repository
(or `.mole` when the folder is not a git repository). Delete that folder at any time. The background process listens on a
local socket file in your temp folder (`mole-<id>.sock`), reachable only by your user; no network port is opened.

## How it works

A small background process reads the project with the TypeScript compiler (the same engine VS Code uses), keeps the
map facts in a local SQLite file and updates them when you save. The process stops by itself after 30 idle
minutes (setting `mole.idleMinutes`; `0` = never) and the extension starts it again when needed.

## Commands and settings

- **Mole: Open map beside the code**, **Mole: Toggle impact view**, **Mole: Re-index repository**
- `mole.autoOpen` open the panel on startup (default on)
- `mole.srcDir`, `mole.tsconfig` choose what is indexed (default: the `src` folder, or the whole workspace when there is no `src` folder)
- `mole.stateDir` where the index lives, `mole.idleMinutes` idle shutdown

## Known limits

- TypeScript and TSX only. JavaScript-only projects and other languages are not mapped.
- JSX elements (`<Foo />`) and dynamic `import()` are not counted as connections.
- Lists are capped at 25 boxes, the rest is shown as "+N more".
- Needs the editor's built-in Node 22.13 or newer (VS Code 1.101+). Some VS Code forks on older Electron show a message instead of a map.
- One background process per repository folder.
- Tested on macOS only so far; Windows and Linux are not tested yet.

## Source and license

MIT. Source and issues: https://github.com/raychu23/mole-code-map

## Status

Early version (0.1). Feedback and bug reports are welcome.
