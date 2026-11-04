# Notes and memory

## How to use

```sh
mole note add <file#Symbol> "text"   # e.g. mole note add src/billing/client.ts#charge "retries 3x on 5xx"
mole memory [--json]                 # every note, with its current status
mole since [--json]                  # symbols you've looked at whose body changed since
mole seen <file#Symbol>... [--how visible|hover|note]   # record a "look" (used by the VS Code extension)
```

A note is anchored to a symbol by a content hash of its body at write time, not just a file:line. When you
next run `mole memory`, each note reports one of: unchanged, `moved` (same body, different location —
tracked automatically), `moved*` (moved **and** changed since the note), `renamed` / `renamed + changed`
(symbol name changed; Mole re-anchors by structural similarity and tells you if it's ambiguous), or
`invalid` (the symbol can no longer be found).

`mole since`/`mole seen` are the "what changed since I last looked" layer: recording a look (a file open, a
hover, a note) lets `mole since` tell you later which of those symbols' bodies changed after you looked.

## What it reads / writes

- **Reads:** your source tree (to detect moves/renames/changes) and `.mole/notes/*`, `.mole/local/seen.jsonl`.
- **Writes:** `.mole/notes/*` (one entry per note, via `mole note add`); `.mole/local/seen.jsonl` (via
  `mole seen` or a note write) — `.mole/local/` is machine-local and is gitignored by design (T13): it never
  leaves the machine that wrote it.

## Limits

- Rename detection is structural-similarity best-effort; an ambiguous rename is reported as ambiguous, not
  silently guessed.
- `.mole/local/seen.jsonl` is per-machine: a look recorded on one machine is not visible from another.
- No model call anywhere in this path.
