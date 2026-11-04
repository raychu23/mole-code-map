// Assumption checks on a person-written decision record (M30a): no alternatives considered, scope not anchored
// to code, contradicts tenet X, cites code that has changed since. Deterministic text/git rules only (R6) —
// Mole never drafts a record's own text, it only points at a fixed question + the evidence behind it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeFlags, loadGraph } from '@mole/decisions';
import type { DecisionGraph, FlagResult, GraphNode } from '@mole/decisions';
import type { AssumptionCheck, EvidenceItem, Finding } from './types.js';

export interface RecordCheckOptions {
  adrDirs?: string[];
}

/** Fixed, written-once question text per check (R6: a model may only reword this behind a flag; default = as written). */
export const QUESTION_TEMPLATES: Record<AssumptionCheck, (title: string, extra: string) => string> = {
  no_alternatives: (title) => `"${title}" reads like it chose one approach over another — what else was considered, and why was it not picked?`,
  scope_not_anchored: (title, extra) => `"${title}" scopes to ${extra}, which is not in the repo at this commit — is the scope stale, or was it never anchored to real code?`,
  contradicts_tenet: (title, extra) => `"${title}" appears to contradict ${extra} — is this record a deliberate, logged exception, or does the tenet need retiring?`,
  stale_citation: (title, extra) => `"${title}" cites ${extra}, which has changed since — does the record still hold, or does it need a new citation?`,
};

const TRIGGER_CONTRAST = /\b(instead of|rather than|chosen over|picked over|in favor of|in favour of|over the alternative)\b/i;
const HAS_ALTERNATIVES_SECTION = /^#{1,4}\s*(considered options?|alternatives?)\b/im;
const MENTIONS_ALTERNATIVE_CONSIDERED = /\balternatives?\s+considered\b/i;

/** per-tenet contradiction triggers: a phrase in the record body that directly negates the tenet's own claim.
 *  Small, explicit lookup table (4 tenets) — not a generic NLP match — to keep false flags at 0 on the real corpus. */
const TENET_CONTRADICTION_TRIGGERS: Record<string, RegExp> = {
  'tenet-1': /\b(the model (decides|determines|guesses|invents)|an?\s+(llm|ai|model)\s+(decides|determines|invents|guesses))\b/i,
  'tenet-2': /\b(must never stop|never stops?\b[^.]{0,40}\bidle|runs? forever|never shuts? down)\b/i,
  'tenet-3': /\b(pauses?|freezes?|blocks?)\s+the\s+(ui|map|editor|panel)\s+while\s+(typing|indexing)\b/i,
  'tenet-4': /\b(writes?\s+(back\s+)?(in)?to\s+the\s+transcripts?|commits?\s+the\s+(seen log|transcripts?|history)|shares?\s+the\s+(seen log|transcripts?)\s+(with|to)\s+(the\s+server|a\s+server|the\s+cloud))\b/i,
};

function evidenceLine(file: string, line: number, label: string): EvidenceItem {
  return { kind: 'file_line', file, line, label };
}

/** Load the decision graph + its citator flags (@mole/decisions, T29, read-only). */
export function loadDecisionGraph(root: string, opts: RecordCheckOptions = {}): { graph: DecisionGraph; flags: FlagResult[] } {
  const graph = loadGraph(root, { adrDirs: opts.adrDirs });
  return { graph, flags: computeFlags(graph) };
}

/** git sha of the current HEAD, used to validate "stale_citation" evidence links against a real commit (M30b). */
function headSha(root: string): string | undefined {
  try {
    return readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim().startsWith('ref:')
      ? undefined
      : readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Tenet id -> raw body text, read once from .mole/tenets.md (graph nodes don't carry full body text). */
function tenetBodies(root: string, graph: DecisionGraph): Map<string, string> {
  const out = new Map<string, string>();
  const tenetFiles = new Set(graph.nodes.filter((n) => n.kind === 'tenet').map((n) => n.file));
  for (const f of tenetFiles) {
    let text: string;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    for (const n of graph.nodes.filter((x) => x.kind === 'tenet' && x.file === f)) {
      // the tenet's own section: from its heading line to the next '## ' heading (or EOF)
      const lines = text.split(/\r?\n/);
      const start = n.line - 1;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i] ?? '')) {
          end = i;
          break;
        }
      }
      out.set(n.id, lines.slice(start, end).join('\n'));
    }
  }
  return out;
}

/** The 4 assumption checks for one decision record (M30a). */
export function checkRecord(root: string, graph: DecisionGraph, flags: FlagResult[], node: GraphNode): Finding[] {
  if (node.kind !== 'decision') return [];
  const findings: Finding[] = [];
  let body: string;
  try {
    body = readFileSync(join(root, node.file), 'utf8');
  } catch {
    return [];
  }

  // 1. no_alternatives: body contrasts an approach ("instead of", "chosen over", ...) but names no considered
  //    option and carries no alternative_to edge — MADR's "Considered Options" is missing where the text implies one.
  const hasAltEdge = graph.edges.some((e) => e.from === node.id && e.type === 'alternative_to');
  const namesAlternatives = HAS_ALTERNATIVES_SECTION.test(body) || MENTIONS_ALTERNATIVE_CONSIDERED.test(body);
  if (TRIGGER_CONTRAST.test(body) && !hasAltEdge && !namesAlternatives) {
    const m = TRIGGER_CONTRAST.exec(body)!;
    const line = body.slice(0, m.index).split(/\r?\n/).length;
    findings.push({
      check: 'no_alternatives',
      recordId: node.id,
      file: node.file,
      line,
      question: QUESTION_TEMPLATES.no_alternatives(node.title, ''),
      evidence: [evidenceLine(node.file, line, `"${m[0]}" with no considered-options section`)],
    });
  }

  // 2 & 4. scope_not_anchored / stale_citation: reuse @mole/decisions' own citator reasons (orphaned/anchor_gone =
  //    scope not anchored to code; scope_changed = cites code that has changed since). Same evidence the graph used.
  const result = flags.find((f) => f.id === node.id);
  if (result) {
    for (const r of result.reasons) {
      if (r.code === 'orphaned' || r.code === 'anchor_gone') {
        findings.push({
          check: 'scope_not_anchored',
          recordId: node.id,
          file: r.file,
          line: r.line,
          question: QUESTION_TEMPLATES.scope_not_anchored(node.title, r.text.replace(/^scope /, '').split(' no longer')[0] ?? r.text),
          evidence: [evidenceLine(r.file, r.line, r.text)],
        });
      }
      if (r.code === 'scope_changed' && r.text.includes('(confirmed)')) {
        // only an EXPLICIT citation (a `confirmed:` sha the author wrote) counts as "cites code that has changed
        // since" (M30a) — the citator's own fallback to "whatever last touched this file" is a governance signal
        // for @mole/decisions, not a claim this record's author made, and would false-flag on every incidental
        // edit elsewhere in the repo since the record's own last commit.
        findings.push({
          check: 'stale_citation',
          recordId: node.id,
          file: r.file,
          line: r.line,
          question: QUESTION_TEMPLATES.stale_citation(node.title, r.text.replace(/^scope /, '').split(' changed')[0] ?? r.text),
          evidence: [evidenceLine(r.file, r.line, r.text)],
        });
      }
    }
  }

  // 3. contradicts_tenet: the record traces_to a tenet whose own claim its body directly negates (explicit table).
  const tenetIds = graph.edges.filter((e) => e.from === node.id && e.type === 'traces_to').map((e) => e.to);
  const bodies = tenetBodies(root, graph);
  for (const tid of tenetIds) {
    const trigger = TENET_CONTRADICTION_TRIGGERS[tid];
    if (!trigger) continue;
    if (trigger.test(body)) {
      const m = trigger.exec(body)!;
      const line = body.slice(0, m.index).split(/\r?\n/).length;
      const tenetNode = graph.nodes.find((n) => n.id === tid);
      findings.push({
        check: 'contradicts_tenet',
        recordId: node.id,
        file: node.file,
        line,
        question: QUESTION_TEMPLATES.contradicts_tenet(node.title, tid),
        evidence: [
          evidenceLine(node.file, line, `"${m[0]}"`),
          ...(tenetNode ? [evidenceLine(tenetNode.file, tenetNode.line, `${tid}: ${tenetNode.title}`)] : []),
        ],
      });
    }
  }

  return findings;
}

/** All decision records under root (M30a's "key from Mole's own .mole/decisions"). */
export function checkAllRecords(root: string, opts: RecordCheckOptions = {}): Finding[] {
  const { graph, flags } = loadDecisionGraph(root, opts);
  const out: Finding[] = [];
  for (const n of graph.nodes) if (n.kind === 'decision') out.push(...checkRecord(root, graph, flags, n));
  return out;
}
