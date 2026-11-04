// (internal task reference removed) review fix (HIGH 2): every MCP tool argument shaped like a path (root, diff,
// notesRoot, records, from, questionsFile, testReport, adrDir entries) must stay inside the server root in
// BOTH the stdio transport (cli.ts) and the streamable-HTTP transport (http.ts) -- they share the same
// createServer()/registerXTool() code, so one helper fixes the whole class instead of one call site.
//
// Policy: resolve the input (absolute inputs are used as-is, a relative input is joined to `root`), then
// require the resolved path to be root itself or somewhere under it -- `root: '/'`, `diff: '/etc/passwd'`
// or `../../etc/passwd` all land outside root and are rejected; `diff: '<root>/change.diff'` (an absolute
// path a caller legitimately already has, e.g. from `git diff` tooling) or `root: '<the server's own
// root>'` both resolve back inside root and are allowed -- the bug this fixes was never "absolute path
// arguments exist", it was "nothing checked where they pointed". If the resolved path exists on disk, BOTH
// the root and the candidate are realpath()'d before the containment check, so a symlink that points
// outside the root cannot be used to escape it either.
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Confines one path-shaped tool argument to `root`. Returns the resolved absolute path (the same string
 * `path.resolve` would produce -- NOT realpath'd, so it matches what the CLI's plain `resolve()` already
 * returns for the same input and downstream fs calls see the path they'd expect). The realpath is used
 * ONLY for the containment check: this is enough to reject a symlink that points outside root (whatever
 * reads the returned path will dereference that same symlink and get the same, already-verified-safe,
 * location -- so there is no need to also change the path string callers see). `input === undefined`
 * returns root itself. */
export function confineToRoot(root: string, input: string | undefined, argName: string): string {
  const serverRoot = resolve(root);
  if (input === undefined || input === '' || input === '.') return serverRoot;
  const candidate = isAbsolute(input) ? resolve(input) : resolve(serverRoot, input);
  const realRoot = existsSync(serverRoot) ? realpathSync(serverRoot) : serverRoot;
  const realCandidate = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (!isInside(realRoot, realCandidate)) {
    throw new PathEscapeError(`${argName} '${input}' resolves outside the server root (${serverRoot})`);
  }
  return candidate;
}

/** Same confinement, applied to every entry of an array arg (e.g. `adrDir`). Returns the confined
 * absolute paths in the same order; throws on the first entry that escapes. */
export function confineAllToRoot(root: string, inputs: string[] | undefined, argName: string): string[] | undefined {
  if (inputs === undefined) return undefined;
  return inputs.map((input, i) => confineToRoot(root, input, `${argName}[${i}]`));
}

