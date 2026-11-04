// `mole pr-check` (T32, Team phase A): for a pull request (base..head) ONE GitHub check-run payload with the decision records
// whose scope anchors cover the changed lines (+ their citator flag), the CODEOWNERS owners, past fixes on the touched lines
// (T12) and up to 3 read-back questions (T14). Silent (neutral, no annotations) when nothing governs the changed lines.
// The workflow (.github/workflows/mole-pr-check.yml) POSTs the payload as a check run; Mole itself never calls GitHub.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatPrCheck, prCheck } from './pr-check.js';

export type * from './types.js';
export { codeownersAt, parseCodeowners } from './codeowners.js';
export { parseGitDiff, type ChangedFile, type Hunk } from './diff.js';
export { contentAnchorsOf, globToRegExp, hasNestedQuantifier, isVersionOnlyHunk, MAX_MATCH_LINE, type ContentAnchor } from './options.js';
export { CHECK_NAME, formatPrCheck, MAX_ANNOTATIONS, prCheck } from './pr-check.js';

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export const PR_CHECK_USAGE =
  'usage: mole pr-check (--base SHA --head SHA | --event FILE) [--root DIR] [--records DIR] [--adr-dir DIR[,DIR]] [--out FILE] [--json] [--no-history] [--notes-root DIR] [--fix-rule RE]';

/** CLI entry used by packages/daemon/src/cli.ts. Exit 0 whenever the check ran (it never fails a PR), 2 on usage errors. */
export async function prCheckCli(_pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  let base = str(flags.base);
  let head = str(flags.head);
  const event = str(flags.event);
  if (event) {
    try {
      const e = JSON.parse(readFileSync(resolve(event), 'utf8')) as { pull_request?: { base?: { sha?: string }; head?: { sha?: string } } };
      base ??= e.pull_request?.base?.sha;
      head ??= e.pull_request?.head?.sha;
    } catch (err) {
      console.error(`mole pr-check: cannot read the event file ${event}: ${String(err)}`);
      return 2;
    }
  }
  if (!base || !head) {
    console.error(PR_CHECK_USAGE);
    return 2;
  }
  const records = str(flags.records);
  const adr = str(flags['adr-dir']);
  const notes = str(flags['notes-root']);
  const r = await prCheck({
    root,
    base,
    head,
    recordsRoot: records ? resolve(records) : undefined,
    adrDirs: adr ? adr.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    history: flags['no-history'] !== true,
    notesRoot: notes ? resolve(notes) : undefined,
    fixRule: str(flags['fix-rule']),
  });
  const out = str(flags.out);
  if (out) writeFileSync(resolve(out), `${JSON.stringify(r.checkRun, null, 2)}\n`);
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatPrCheck(r));
  return 0;
}
