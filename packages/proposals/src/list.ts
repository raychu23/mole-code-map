// T62: which proposal worktrees belong to a repo, and their evaluation/comparison as one JSON -- the ONE implementation
// behind the MCP tool mole_proposals_compare (T61), `mole proposals` (daemon CLI) and the VS Code panel's Reasoning
// section. Moved from packages/mcp (T61 repoProposals) unchanged in behaviour.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { compareProposals, evaluateProposal, ProposalError, readMeta, type Comparison, type PhaseSelector, type ProposalMeta } from './proposals.js';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Proposal worktrees of this repo, sorted by name. A worktree counts only if its metadata names this repo AND it has
 *  the branch createProposal gives it, `mole/proposal/<name>`, checked out (T61 review 1: a hand-written meta file in an
 *  unrelated linked worktree was trusted). One branch per worktree, so names are unique.
 *  Known limit (T61 review 2): mole-proposal.json is trusted data, not a signature; someone with write access to a
 *  worktree can still forge a complete one on a mole/proposal/<name> branch -- the same trust boundary as hand-editing .mole/. */
export function listProposals(root: string): Array<{ path: string; meta: ProposalMeta }> {
  const top = real(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const listing = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const out: Array<{ path: string; meta: ProposalMeta }> = [];
  for (const block of listing.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch (.+)$/m.exec(block)?.[1];
    if (!path || !branch || real(path) === top) continue;
    try {
      const meta = readMeta(path);
      const own = `mole/proposal/${meta.name}`;
      if (real(meta.repo) === top && meta.branch === own && branch === `refs/heads/${own}`) out.push({ path, meta });
    } catch {
      // not a Mole proposal worktree (another linked worktree): skip
    }
  }
  return out.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

/** none -> { proposals: [] } · one -> its evaluation · two or more -> compareProposals (same baseline required).
 *  `names` picks some; an unknown name is refused. T68: `sel` ({ phase, at }) is forwarded uniformly to every
 *  picked proposal's evaluation (one audience for the whole comparison, same as T60's comparePhases(a, b)). */
export function summarizeProposals(root: string, names?: string[], sel: PhaseSelector = {}): Comparison | { proposals: [] } {
  const all = listProposals(root);
  let picked = all;
  if (names) {
    const byName = new Map(all.map((p) => [p.meta.name, p]));
    const unknown = names.filter((n) => !byName.has(n));
    if (unknown.length) throw new ProposalError(`unknown proposal ${unknown.join(', ')} (this repo has: ${all.map((p) => p.meta.name).join(', ') || 'none'})`);
    picked = [...new Set(names)].map((n) => byName.get(n)!);
  }
  if (picked.length === 0) return { proposals: [] };
  if (picked.length === 1) return { baselineRevision: picked[0]!.meta.baselineRevision, proposals: [evaluateProposal(picked[0]!.path, sel)] };
  return compareProposals(picked.map((p) => p.path), sel);
}
