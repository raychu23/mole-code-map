// T77: factored out of hotspots' `churnAndIncidents` (T70) so the git-log-with-rename-tracking
// walk has exactly one implementation -- @mole/coupling's co-change counting reuses this instead of
// a second `git log` parser (the project's shared instructions file "one source of truth"; T77 prior-art.md source 4).
import { git } from '@mole/history/dist/src/git.js';

export interface CommitFiles {
  sha: string;
  subject: string;
  /** files this commit touched, renames resolved to their current (HEAD-chain) name, deduped */
  files: string[];
}

/** follow a chain of rename aliases (old name -> ... -> current name) to its end */
function resolveAlias(alias: Map<string, string>, name: string): string {
  let cur = name;
  const seen = new Set<string>();
  while (alias.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = alias.get(cur)!;
  }
  return cur;
}

/** one `git log --name-status -M` walk (newest-first, git's default order): every commit with its
 * subject and the set of files it touched, renames merged under the current name via a rename-alias
 * chain built progressively as the newest-first log is read (review-1 MED 3 of T70, generalized here
 * from per-file counters to per-commit file sets so co-change pairing (T77) can reuse the same parse
 * hotspots' churn does). */
export async function walkCommits(root: string, since?: string): Promise<CommitFiles[]> {
  const args = ['log', '--name-status', '-M', '--format=%x01%H%x02%s'];
  if (since) args.push(`--since=${since}`);
  const raw = await git(root, args);
  const alias = new Map<string, string>();
  const out: CommitFiles[] = [];
  let cur: CommitFiles | null = null;
  let fileSet: Set<string> | null = null;

  const add = (file: string): void => {
    fileSet!.add(file);
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      if (cur) {
        cur.files = [...fileSet!];
        out.push(cur);
      }
      const [sha, subject = ''] = line.slice(1).split('\x02');
      cur = { sha: sha!, subject, files: [] };
      fileSet = new Set<string>();
      continue;
    }
    if (!line.trim() || !cur) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      // rename/copy: "R100\told\tnew" / "C100\tsrc\tdst" -- attribute this commit's touch once, to
      // the destination path, and (for renames) alias the old path to it for earlier commits
      const oldPath = parts[1];
      const newPath = parts[2];
      if (!newPath) continue;
      const canonicalNew = resolveAlias(alias, newPath);
      if (status.startsWith('R') && oldPath) alias.set(oldPath, canonicalNew);
      add(canonicalNew);
    } else {
      const file = parts[1];
      if (file) add(resolveAlias(alias, file));
    }
  }
  if (cur) {
    cur.files = [...fileSet!];
    out.push(cur);
  }
  return out;
}
