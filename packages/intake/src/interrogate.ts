// T23: for a code change governed by one or more decisions, ask the author up to 3 pointed questions built from
// evidence Mole already gathered (diff hunks, past fixes + guarding tests from @mole/history/@mole/questions, the
// governing decision from @mole/decisions). Silent when nothing governs the change (done-when 5). Deterministic
// by default (R6): a model, if opts.reword + opts.model are both given, may only reword a question's text, never
// add a question or a fact (same contract as @mole/questions' reword option, which this reuses unmodified).
import { questions as questionsOf, type QuestionsOptions } from '@mole/questions';
import type { Change } from '@mole/history';
import { gatherEvidence, governingDecisions } from './evidence.js';
import type { EvidenceItem, InterrogateQuestion, InterrogateResult } from './types.js';
import { MAX_QUESTIONS } from './types.js';

export { governingDecisions };

export async function interrogate(root: string, change: Change, opts: QuestionsOptions & { adrDirs?: string[] } = {}): Promise<InterrogateResult> {
  const evidence = await gatherEvidence(root, change, { adrDirs: opts.adrDirs });
  if (!evidence.governed) {
    // done-when 5: nothing governs the change -> silent, not "0 questions with a notice"
    return { governed: false, governingDecisions: [], questions: [], evidence: [], modelCalls: 0 };
  }

  const qr = await questionsOf(root, change, opts);
  const governedFiles = new Set(evidence.governingDecisions.flatMap((g) => g.matchedScope.map((s) => s.split('#')[0]!)));
  const onGovernedCode = qr.questions.filter((q) => {
    const file = q.source.file;
    return [...governedFiles].some((f) => file === f || file.startsWith(f.endsWith('/') ? f : `${f}/`));
  });
  const picked = (onGovernedCode.length > 0 ? onGovernedCode : qr.questions).slice(0, MAX_QUESTIONS);

  const toEvidence = (q: (typeof picked)[number]): EvidenceItem[] => {
    const items: EvidenceItem[] = [{ kind: 'file_line', file: q.source.file, line: q.source.line, label: q.text }];
    if (q.source.sha) items.push({ kind: 'commit', commit: q.source.sha, label: `cited by: ${q.text}` });
    return items;
  };

  const questions: InterrogateQuestion[] = picked.map((q, i) => ({
    rank: i + 1,
    check: q.kind,
    text: q.text,
    evidence: toEvidence(q),
  }));

  return {
    governed: true,
    governingDecisions: evidence.governingDecisions.map((g) => g.node.id),
    questions,
    evidence: evidence.evidence,
    modelCalls: qr.modelCalls,
  };
}

export type { Change };
