// Check-run computation per push (M25 "check-run compute < 60s"): which decisions the push
// touches, any obvious violation (a changed-scope file with no governing decision at all is
// reported as informational, never blocking — Mole's own rule is "flags, not gates").
import { execFileSync } from 'node:child_process';
import type { CheckAnnotation } from '@mole/decisions';
import { prCheck } from '@mole/decisions';
import type { Pool } from './db.js';
import { getGoverningDecisions } from './graph.js';
import { writeOutboxInTx } from './outbox.js';

// git's well-known empty-tree object (present in every repository): used as prCheck's base
// when ref has no parent (the repo's root commit), so a push of the very first commit still
// gets a real diff (everything in it is "added") instead of prCheck failing on `ref^`.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface CheckRunResult {
  ref: string;
  // GitHub Checks API conclusion enum (success|failure|neutral|cancelled|timed_out|
  // action_required|stale|skipped — see Octokit's checks.create). Mole's own "flags, not
  // gates" rule (this file's own header comment, and packages/decisions/src/check/pr-check.ts's
  // buildCheckRun, which returns 'neutral' whether or not anything governs) means this is
  // ALWAYS 'neutral': a real content-anchor match is surfaced through annotations/summary, not
  // through a hard pass/fail verdict. T45 (2 insights.md): kept as a literal union of one value,
  // not widened to 'success' or 'action_required', because nothing in this codebase computes
  // those other than by a human editing a record's status — see this task's stop-rule note.
  conclusion: 'neutral';
  summary: string;
  governedFiles: number;
  ungovernedFiles: number;
  /** T45: prCheck's own per-decision-hit annotations (GitHub check-run annotation shape: path,
   *  start_line/end_line, annotation_level, title, message), carried through unmodified so the
   *  live push path surfaces exactly what `mole pr-check` already computes instead of discarding
   *  it before the check run is written. Empty when nothing governs this diff. (2 insights.md:
   *  minimal UX choice — title + per-decision annotation lines, not prCheck's full rich summary
   *  with owners/past-fixes/questions/record-changes sections, which stays CLI/PR-comment-only.) */
  annotations: CheckAnnotation[];
}

function changedFiles(repoDir: string, ref: string): string[] {
  try {
    return execFileSync('git', ['show', '--name-only', '--pretty=format:', ref], { cwd: repoDir, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** ref's parent commit, or git's empty-tree sha when ref has no parent (a repo's root commit). */
function baseOf(repoDir: string, ref: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^`], { cwd: repoDir, encoding: 'utf8' }).trim();
  } catch {
    return EMPTY_TREE_SHA;
  }
}

/** All-zero sha40: GitHub's push event sends this for `before` when the push created a new
 * branch (push event docs: "the SHA of the most recent commit... before refs/heads/<branch>
 * was created, unless this is a new branch... in which case before is a 40-character string of
 * zeros."). Never a usable base. */
const ALL_ZERO_SHA = /^0+$/;

/** True when `commit` is an ancestor of `ref` in repoDir (git merge-base --is-ancestor): the
 * same check reviewdog/Danger make before trusting a CI-supplied base sha, because a force push
 * can rewrite history so the old `before` no longer exists on `ref`'s line of history at all. */
function isAncestor(repoDir: string, commit: string, ref: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, ref], { cwd: repoDir, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** T45 P1: prCheck's base for a push range. GitHub's push event payload carries `before` (the
 * ref's tip immediately before this push) — the correct base for a multi-commit push, matching
 * how GitHub's own compare view and tools like reviewdog/Danger pick a PR/push base: use the
 * caller-supplied base commit, not just HEAD^, so every commit in the push is covered by the
 * diff instead of only the last one. `baseOf`'s ref^/empty-tree fallback is used only when
 * `before` cannot be trusted as a base: absent, all-zero (brand-new branch, nothing to diff
 * against), or not an ancestor of `ref` (a force push rewrote history out from under it). */
function resolveBase(repoDir: string, ref: string, before: string | undefined): string {
  if (before && !ALL_ZERO_SHA.test(before) && isAncestor(repoDir, before, ref)) return before;
  return baseOf(repoDir, ref);
}

export async function computeCheckRun(
  pool: Pool,
  orgId: string,
  repoDir: string,
  ref: string,
  before: string | undefined,
  telemetry: { withSpan: <T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>) => Promise<T> } | undefined
): Promise<CheckRunResult> {
  const run = async () => {
  const files = changedFiles(repoDir, ref).filter((f) => f.startsWith('src/'));
    let governed = 0;
    let ungoverned = 0;
    for (const f of files) {
      const rows = await getGoverningDecisions(pool, orgId, f, { forOrg: orgId });
      if (rows.length > 0) governed++;
      else ungoverned++;
    }

    // T45: the live push path used to stop here and hardcode conclusion: 'success' — never
    // calling prCheck's governed/content-anchor computation, so a real match (T32) never
    // surfaced on the check run a team actually sees ((internal reference removed)
    // m2-conflict/4 log/mole-capability-and-gap.md). Wire it in: same repo, same diff, prCheck's
    // own check-run title + annotations become this result's; a prCheck failure (e.g. an
    // unparseable ref) falls back to the file-count line and no annotations rather than losing
    // the push notification (M25 "0 lost notifications").
    let title = `${governed} file(s) governed by a decision, ${ungoverned} not`;
    let annotations: CheckAnnotation[] = [];
    try {
      const pr = await prCheck({ root: repoDir, base: resolveBase(repoDir, ref, before), head: ref, history: false });
      title = pr.checkRun.output.title;
      annotations = pr.checkRun.output.annotations;
    } catch (e) {
      // T45 P2: this used to swallow every prCheck error silently (a parse failure, an
      // unresolvable ref, a records-root bug) with no trace at all — the check run would
      // quietly degrade to the file-count-only title and nobody could tell why. Log it the
      // same way the rest of this server's job side already does on a non-fatal failure
      // (index.ts's startup failure, queue.ts's pg-boss 'error' handler, bench/m25.ts's
      // rebuild-index failure) -- console.error is this server's own "logger", there is no
      // separate logging dependency -- then keep the fallback: a push notification must never
      // be lost (M25 "0 lost notifications") over a prCheck bug. (OTel's recordException on
      // the active span was tried first and rejected: this provider never registers an
      // AsyncHooksContextManager, so the active span is already gone by the time an `await`
      // inside the try block resumes -- trace.getActiveSpan() is reliably undefined here.)
      console.error('[checkrun] prCheck failed, falling back to file-count-only title', {
        orgId,
        ref,
        error: e instanceof Error ? e.message : String(e),
      });
      // keep the file-count-only title and empty annotations computed above
    }

    const result: CheckRunResult = {
      ref,
      conclusion: 'neutral',
      summary: title,
      governedFiles: governed,
      ungovernedFiles: ungoverned,
      annotations,
    };
    const client = await pool.connect();
    try {
      await client.query('begin');
      await writeOutboxInTx(client, orgId, 'check_run', result, ref);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return result;
  };
  if (telemetry) return telemetry.withSpan('check_run.compute', { 'mole.org_id': orgId, 'mole.ref': ref }, run);
  return run();
}
