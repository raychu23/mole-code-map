// T43: the full Decision + Context/Rationale + Consequences text of a record, for agent-facing surfaces
// (MCP mole_decisions, the Claude Code plugin's governing-decisions hook block, and the plain-ADR import
// path in graph.ts loadAdrDir) -- not only summaryOf()'s 240-char list/hover preview (tree/core.ts:398-429,
// which stays exactly as-is for that compact use, done-when 2).
//
// Section names borrow MADR (https://adr.github.io/madr/) and adr-tools/Nygard
// (https://github.com/npryce/adr-tools) vocabulary rather than inventing new headings, matching what
// graph.ts's loadAdrDir already recognizes for status parsing:
//   Decision bucket       '## Decision', '## Decision Outcome'
//   Context/Rationale     '## Context', '## Context and Problem Statement', '## Rationale',
//                          '## Decision Drivers', '## Considered Options'
//   Consequences bucket   '## Consequences'
// A record with none of these headings (a short Nygard note, a backstage stub) falls back to its whole
// body as the Decision bucket, same spirit as summaryOf()'s own fallback.

/** Documented size budget for one record's full rationale text, in characters. Generous enough to carry a
 * real ADR's prose (the M-B v2 bench's hand-made records ran 256-8609 chars) while still bounding any
 * agent-facing surface. Per-record: a tool or hook combining several records bounds the whole output
 * separately (see plugins/claude-code/scripts/lib.mjs SCOPE_BUDGET for the hook's own cap). */
export const RATIONALE_BUDGET = 4000;

export interface DecisionSections {
  decision?: string;
  context?: string;
  consequences?: string;
}

type Bucket = keyof DecisionSections;

const BUCKET_OF: Array<{ bucket: Bucket; test: (h: string) => boolean }> = [
  // '^decision\b' must not catch 'decision drivers' (a context heading, below): T54 review 2 P1
  { bucket: 'decision', test: (h) => /^decision\b(?!\s+drivers\b)/.test(h) || /^decision outcome\b/.test(h) },
  { bucket: 'consequences', test: (h) => /^consequences\b/.test(h) },
  {
    bucket: 'context',
    test: (h) => /^context\b/.test(h) || /^rationale\b/.test(h) || /^decision drivers\b/.test(h) || /^considered options\b/.test(h) || /^links\b/.test(h),
  },
];

function stripFrontMatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return text;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end < 0 ? text : lines.slice(end + 1).join('\n');
}

/** MADR / Nygard / adr-tools heading extraction (same vocabulary graph.ts's loadAdrDir already knows for
 * status). Headings are '##' or '###'; a section runs to the next '##'-level heading or end of body.
 *
 * Two fallback shapes, both preserving every non-empty section (P0 fix, reviewer-1 FAIL on T43's first
 * submission: Backstage adr001's 'Discussion'/'Risks' siblings of a matched '## Decision' heading were
 * silently dropped -- `continue`d past with no `bucket` match and never recorded anywhere):
 *   - NO heading in the record matches any recognized bucket at all (a spec-style ADR with
 *     Background/Format/Envelope headings, or no headings at all): whole (trimmed) body as `decision`,
 *     same as before -- nothing is lost, every heading and its content is still in that trimmed text.
 *   - SOME headings match a bucket but others don't (adr001's Discussion/Risks siblings of Decision;
 *     adr009's Background, once the one-off `^entity references\b` hack below was removed): every
 *     unmatched heading with non-empty content joins the (internal reference removed) bucket, in document order,
 *     labeled by its own heading text (e.g. 'Discussion: There is a need...') so the reader can tell it
 *     wasn't a recognized MADR/Nygard name. Matched headings never carry a label -- only the fallback ones. */
export function sectionsOf(text: string): DecisionSections {
  const body = stripFrontMatter(text);
  const lines = body.split(/\r?\n/);
  const idx: Array<{ line: number; heading: string; raw: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{2,3}\s+(.+?)\s*$/.exec(lines[i] ?? '');
    if (m) idx.push({ line: i, heading: m[1]!.toLowerCase(), raw: m[1]! });
  }
  if (idx.length === 0) {
    const whole = body.trim();
    return whole ? { decision: whole } : {};
  }
  const anyMatched = idx.some(({ heading }) => BUCKET_OF.some((b) => b.test(heading)));
  if (!anyMatched) {
    // no heading in the record is a recognized MADR/Nygard bucket name -- same fallback as the
    // no-heading case, whole body as Decision (nothing dropped: the headings stay in that raw text).
    const whole = body.trim();
    return whole ? { decision: whole } : {};
  }
  const out: DecisionSections = {};
  for (let n = 0; n < idx.length; n++) {
    const { line, heading, raw } = idx[n]!;
    const end = idx[n + 1]?.line ?? lines.length;
    const content = lines.slice(line + 1, end).join('\n').trim();
    if (!content) continue;
    const bucket = BUCKET_OF.find((b) => b.test(heading))?.bucket;
    if (bucket) {
      out[bucket] = out[bucket] ? `${out[bucket]}\n\n${content}` : content;
    } else {
      // unmatched sibling of a matched heading -- keep it, labeled, in the (internal reference removed) bucket
      // rather than silently dropping it (the P0 bug).
      const labeled = `${raw}: ${content}`;
      out.context = out.context ? `${out.context}\n\n${labeled}` : labeled;
    }
  }
  return out;
}

/** Clip at a word boundary, never mid-word, with a visible cut marker. */
function clipWords(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, Math.max(0, n - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trim()}\u2026`;
}

/** Render sections, named, within `budget` characters total. Priority: Decision first (never truncated
 * while any other section still has budget to give up), then Context/Rationale, then Consequences --
 * so a tight budget drops or clips the least-important sections before it ever cuts into the Decision text
 * itself (done-when 3: "never mid-Decision"). Returns '' when there is nothing to say. */
export function formatSections(s: DecisionSections, budget: number = RATIONALE_BUDGET): string {
  const order = (
    [
      ['Decision', s.decision],
      ['Context/Rationale', s.context],
      ['Consequences', s.consequences],
    ] as Array<[string, string | undefined]>
  ).filter(([, v]) => v) as Array<[string, string]>;
  if (order.length === 0) return '';
  // Decision is processed first and gets whatever budget it needs before Context/Consequences see any of
  // it, so a tight budget clips or drops the later sections before it ever touches the Decision text.
  const parts: string[] = [];
  let remaining = budget;
  for (const [label, text] of order) {
    if (remaining <= 0) {
      parts.push(`(${label} omitted: budget exhausted)`);
      continue;
    }
    const line = `${label}: ${text}`;
    if (line.length <= remaining) {
      parts.push(line);
      remaining -= line.length + 2; // + the '\n\n' joiner
    } else {
      const keep = Math.max(0, remaining - `${label}: `.length);
      parts.push(`${label}: ${clipWords(text, keep)}`);
      remaining = 0;
    }
  }
  return parts.join('\n\n');
}
