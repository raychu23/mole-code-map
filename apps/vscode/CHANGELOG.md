# Changelog

## 0.1.0

First packaged version.

- Map panel beside the code that follows the open file: what it defines, who calls it, what it calls, who imports it.
- Every box opens its file and line; callers and importers open the line where the call or import happens.
- Impact view (what a change could affect, up to three calls away).
- Local only: no network, no telemetry, no AI call. Index kept in `.git/mole`.
- Background indexer stops itself after 30 idle minutes and restarts on demand.
- Stays silent in workspaces without TypeScript.
