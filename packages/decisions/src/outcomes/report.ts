// T81 (D66): outcome tracking log. A decision record may carry a `prediction:` block (expected outcome, the
// measurable signal, and a check_at date) and later an `outcome:` block (what was actually observed, when, by
// whom, and the human's own verdict against the prediction). A `rollout:` block names a staged rollout's two
// scopes (treated/holdout) -- recording only, no assignment logic (D66 itself: "staggered rollout + 1 holdout
// folder"). Like `door` (T78) and `assurance:` (also T78), every field here is human-authored front matter;
// Mole never infers a prediction, an observed value, or a verdict from text. See this task's
// (internal reference removed) log/prior-art.md for the decision-journal / pre-registration / holdout sources
// this borrows from (Duke 2018, Klein/HBR 2007 premortem, Kohavi/Tang/Xu 2020, Spotify DIBB).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidIsoDate } from '../assurance/report.js';
import { draftIncidentRecord } from '../incidents/revive.js';
import { frontMatter, loadGraph } from '../graph.js';
import type { OutcomeEntry, OutcomeMalformed, OutcomeResult, OutcomesReport, Outcome, Prediction, Rollout } from '../types.js';

const RESULTS: ReadonlySet<string> = new Set<OutcomeResult>(['confirmed', 'contradicted', 'inconclusive']);

interface Parsed {
  prediction?: Prediction;
  outcome?: Outcome;
  rollout?: Rollout;
  malformed: OutcomeMalformed[];
}

/** Reads the `prediction:` / `outcome:` / `rollout:` front-matter blocks of one decision record. A block
 * written as anything but a mapping, or missing a required sub-field, is reported in `malformed` instead of
 * silently dropped or guessed at (same convention as `parseAssurance`). */
export function parseOutcomeBlocks(text: string, file: string, decisionId: string): Parsed {
  const fm = frontMatter(text, file);
  const malformed: OutcomeMalformed[] = [];
  if (!fm || 'error' in fm) return { malformed };
  const bad = (block: Parsed['malformed'][number]['block'], field: string, value: string, reason: string, line: number) =>
    malformed.push({ decisionId, block, field, value, reason, file, line });

  const predField = fm.fields.get('prediction');
  let prediction: Prediction | undefined;
  if (predField) {
    const m = predField.map;
    if (!m) bad('prediction', 'prediction', '(not a mapping)', 'prediction must be a mapping (expected:, signal:, check_at:)', predField.line);
    else {
      let checkAt: string | undefined;
      if (m.check_at !== undefined) {
        if (isValidIsoDate(m.check_at)) checkAt = m.check_at;
        else bad('prediction', 'check_at', m.check_at, 'not a real ISO calendar date (YYYY-MM-DD)', predField.line);
      }
      prediction = { expected: m.expected ?? '', signal: m.signal ?? '', ...(checkAt ? { checkAt } : {}), file, line: predField.line };
    }
  }

  const outField = fm.fields.get('outcome');
  let outcome: Outcome | undefined;
  if (outField) {
    const m = outField.map;
    if (!m) bad('outcome', 'outcome', '(not a mapping)', 'outcome must be a mapping (observed:, date:, who:, result:)', outField.line);
    else {
      let date: string | undefined;
      if (m.date !== undefined) {
        if (isValidIsoDate(m.date)) date = m.date;
        else bad('outcome', 'date', m.date, 'not a real ISO calendar date (YYYY-MM-DD)', outField.line);
      }
      let result: OutcomeResult | undefined;
      if (m.result !== undefined) {
        if (RESULTS.has(m.result)) result = m.result as OutcomeResult;
        else bad('outcome', 'result', m.result, `not a recognized outcome result (${[...RESULTS].join('|')})`, outField.line);
      }
      outcome = { observed: m.observed ?? '', ...(date ? { date } : {}), ...(m.who ? { who: m.who } : {}), ...(result ? { result } : {}), file, line: outField.line };
    }
  }

  const rolloutField = fm.fields.get('rollout');
  let rollout: Rollout | undefined;
  if (rolloutField) {
    const m = rolloutField.map;
    if (!m) bad('rollout', 'rollout', '(not a mapping)', 'rollout must be a mapping (treated:, holdout:)', rolloutField.line);
    else if (!m.treated || !m.holdout) bad('rollout', !m.treated ? 'treated' : 'holdout', '(missing)', 'a staged-rollout record needs both treated: and holdout: scopes', rolloutField.line);
    else rollout = { treated: m.treated, holdout: m.holdout, file, line: rolloutField.line };
  }

  return { prediction, outcome, rollout, malformed };
}

export interface OutcomesOptions {
  /** ISO date to treat as "today"; defaults to the real clock */
  today?: string;
  /** keep only entries with no outcome yet and a passed (or today's) check_at */
  due?: boolean;
}

const dayDiff = (a: string, b: string): number => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** `mole outcomes [--due] [--json]`: every decision record with an opt-in `prediction:` block, its recorded
 * `outcome:` (if any) and `rollout:` (if any), plus which checks are due/overdue. A contradicted outcome
 * (the human's own `result: contradicted`, never inferred) is flagged with a draft SUGGESTED incident -- see
 * draftIncidentRecord's own header: never written, never accepted, a person's act from here. Read-only, no
 * model call. */
export function outcomesReport(root: string, opts: OutcomesOptions = {}): OutcomesReport {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const graph = loadGraph(root);
  const entries: OutcomeEntry[] = [];
  const malformed: OutcomeMalformed[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'decision') continue;
    let text: string;
    try {
      text = readFileSync(resolve(root, n.file), 'utf8');
    } catch {
      continue; // an unreadable file is already a graph problem, not duplicated here
    }
    const parsed = parseOutcomeBlocks(text, n.file, n.id);
    malformed.push(...parsed.malformed);
    if (!parsed.prediction) continue; // prediction: is the opt-in, same as door: for assurance
    const hasOutcome = !!parsed.outcome;
    const checkAt = parsed.prediction.checkAt;
    const due = !hasOutcome && !!checkAt && checkAt <= today;
    const overdue = !hasOutcome && !!checkAt && checkAt < today;
    const contradicts = parsed.outcome?.result === 'contradicted';
    const entry: OutcomeEntry = {
      decisionId: n.id,
      title: n.title,
      file: n.file,
      line: n.line,
      prediction: parsed.prediction,
      ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
      ...(parsed.rollout ? { rollout: parsed.rollout } : {}),
      due,
      overdue,
      ...(overdue && checkAt ? { daysOverdue: dayDiff(today, checkAt) } : {}),
      contradicts,
      ...(contradicts
        ? {
            suggestedIncident: {
              title: `Outcome contradicts prediction for ${n.id}`,
              decisions: [n.id],
              draft: draftIncidentRecord(
                `suggested-${n.id}`,
                `Outcome contradicts prediction for ${n.id}`,
                `Expected: ${parsed.prediction.expected}\nSignal: ${parsed.prediction.signal}\nObserved: ${parsed.outcome?.observed ?? ''}\n` +
                  `Recorded by ${parsed.outcome?.who ?? '(unknown)'} on ${parsed.outcome?.date ?? '(unknown)'}.\n` +
                  'SUGGESTED by `mole outcomes` -- review and save under .mole/incidents/ to use `mole incident suggest/accept/dismiss` (T58).',
                [n.id],
              ),
            },
          }
        : {}),
    };
    if (opts.due && !(entry.due || entry.overdue)) continue;
    entries.push(entry);
  }
  return { root, generatedAt: new Date().toISOString(), entries, malformed };
}

function formatOutcomes(r: OutcomesReport): string {
  const out: string[] = [];
  if (r.entries.length === 0) out.push('mole outcomes: no decision records with a prediction: block');
  for (const e of r.entries) {
    const status = e.outcome ? (e.contradicts ? 'CONTRADICTED' : e.outcome.result ?? 'recorded') : e.overdue ? `OVERDUE (${e.daysOverdue}d)` : e.due ? 'DUE' : 'pending';
    out.push(`${status.padEnd(14)} ${e.decisionId}  ${e.prediction.expected}  ${e.file}:${e.line}`);
    if (e.outcome) out.push(`  outcome  ${e.outcome.observed}  ${e.outcome.date ?? '(no date)'} by ${e.outcome.who ?? '(unknown)'}`);
    if (e.rollout) out.push(`  rollout  treated=${e.rollout.treated} holdout=${e.rollout.holdout}`);
    if (e.suggestedIncident) out.push(`  SUGGESTED incident (not written): ${e.suggestedIncident.title}`);
  }
  if (r.malformed.length) {
    out.push(`malformed (${r.malformed.length}):`);
    for (const m of r.malformed) out.push(`  ${m.decisionId} ${m.block}.${m.field}=${m.value || '(empty)'}  ${m.reason}  ${m.file}:${m.line}`);
  }
  return out.join('\n');
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** CLI entry used by packages/daemon/src/cli.ts. */
export function outcomesCli(_pos: string[], flags: Record<string, string | true>, root: string): number {
  const r = outcomesReport(root, { due: !!flags.due, today: str(flags.today) });
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatOutcomes(r));
  return 0;
}
