#!/usr/bin/env node
// mole-proposals: create / evaluate / compare what-if branches of the decision records (T56, D67).
//   mole-proposals create --repo <dir> --name <slug> --path <absolute new dir> [--base <rev>]
//   mole-proposals evaluate --path <proposal worktree> [--phase P | --at YYYY-MM-DD]
//   mole-proposals compare --left <proposal> --right <proposal> [--also <proposal> ...] [--phase P | --at YYYY-MM-DD]
//   mole-proposals lesson --repo <dir> --lesson <id> --path <absolute new dir> [--name <slug>]   (T59: draft tenet revision)
// T68: --phase/--at pick the T60 phase each side is evaluated under (default: the phase in force today); the
// result's `changes` is that phase-resolved reading, `plainDung` is always shown beside it (STOP clause).
// Output: JSON on stdout. Errors: one line on stderr, exit 1.
import { proposeTenetRevision } from './lesson.js';
import { compareProposals, createProposal, evaluateProposal, ProposalError } from './proposals.js';

function flags(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) throw new ProposalError(`unexpected argument: ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ProposalError(`missing value for ${k}`);
    out.set(k.slice(2), [...(out.get(k.slice(2)) ?? []), v]);
    i++;
  }
  return out;
}

function one(f: Map<string, string[]>, k: string): string {
  const v = f.get(k);
  if (!v || v.length !== 1) throw new ProposalError(`--${k} is required (once)`);
  return v[0]!;
}

function sel(f: Map<string, string[]>): { phase?: string; at?: string } {
  const out: { phase?: string; at?: string } = {};
  if (f.has('phase')) out.phase = one(f, 'phase');
  if (f.has('at')) out.at = one(f, 'at');
  return out;
}

function main(argv: string[]): unknown {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  switch (cmd) {
    case 'create':
      return createProposal({ repo: one(f, 'repo'), name: one(f, 'name'), path: one(f, 'path'), ...(f.has('base') ? { base: one(f, 'base') } : {}) });
    case 'evaluate':
      return evaluateProposal(one(f, 'path'), sel(f));
    case 'compare':
      return compareProposals([one(f, 'left'), one(f, 'right'), ...(f.get('also') ?? [])], sel(f));
    case 'lesson':
      return proposeTenetRevision({ repo: one(f, 'repo'), lesson: one(f, 'lesson'), path: one(f, 'path'), ...(f.has('name') ? { name: one(f, 'name') } : {}) });
    default:
      throw new ProposalError('usage: mole-proposals create|evaluate|compare|lesson (see the header of src/cli.ts)');
  }
}

try {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n');
} catch (e) {
  process.stderr.write(`mole-proposals: ${(e as Error).message}\n`);
  process.exitCode = 1;
  if (!(e instanceof ProposalError)) process.stderr.write(`${(e as Error).stack ?? ''}\n`);
}
