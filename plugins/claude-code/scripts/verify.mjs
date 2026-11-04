// T65: Mole's measured verifier in the Stop hook. Runs `mole cascade-check --worktree --json` (cascade + T53 semantic
// routing with the measured settings, packages/decisions/src/cascade/cli.ts) on the session's change and turns its
// verdicts into hook text. Only a verdict the JUDGE gave (tier 'llm', flag 'violates') or a crisp zero-model rule hit
// counts as a violation; a decision routed without a model (MOLE_STOP_VERIFY_LLM=0, or no judge available) is shown
// as "not judged" and never asks the agent to continue. Dependency-free like the other hook scripts.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { moleJson } from './lib.mjs';

const NO_JUDGE = /no LLM tier configured|no decision text available/;
const one = (s, n = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** cascade JSON -> { text (systemMessage part), continueText (only when a real violation was found) } */
export function verifierParts(r) {
  const verdicts = Array.isArray(r?.verdicts) ? r.verdicts : [];
  const judged = verdicts.filter((v) => v.flag === 'violates' && !(v.tier === 'zero-llm' && NO_JUDGE.test(v.reason ?? '')));
  const unjudged = verdicts.filter((v) => v.flag === 'violates' && v.tier === 'zero-llm' && NO_JUDGE.test(v.reason ?? ''));
  const out = [];
  if (judged.length) {
    out.push(`Mole verifier: decision violations in your change (${judged.length}, mole cascade-check):`);
    for (const v of judged) out.push(`- ${v.decision} ${one(v.title, 120)}: ${one(v.reason)}`);
  }
  if (unjudged.length) {
    out.push(`Mole verifier: ${unjudged.length} decision${unjudged.length === 1 ? '' : 's'} may govern your change (routed by meaning, not judged: no model for this check):`);
    for (const v of unjudged) out.push(`- ${v.decision} ${one(v.title, 120)}`);
  }
  const text = out.join('\n');
  const continueText = judged.length
    ? `Mole's verifier found decision violations in your change. Fix them (or say why the decision does not apply), then stop:\n${judged.map((v) => `- ${v.decision} ${one(v.title, 120)}: ${one(v.reason)}`).join('\n')}`
    : '';
  return { text, continueText };
}

const hasRecords = (root) => {
  try {
    return existsSync(join(root, '.mole', 'decisions')) && readdirSync(join(root, '.mole', 'decisions')).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
};

/** run the verifier for the Stop hook; undefined when off, no records, or the check failed (never throws) */
export function runVerifier(mole, root, base) {
  if (process.env.MOLE_STOP_VERIFY === '0' || !hasRecords(root)) return undefined;
  const args = ['cascade-check', '--worktree', '--json', ...(base ? ['--base', base] : []), ...(process.env.MOLE_STOP_VERIFY_LLM === '0' ? ['--no-llm'] : [])];
  const budget = Number(process.env.MOLE_STOP_VERIFY_TIMEOUT_MS) > 0 ? Number(process.env.MOLE_STOP_VERIFY_TIMEOUT_MS) : 100_000;
  return moleJson(mole, root, args, budget);
}
