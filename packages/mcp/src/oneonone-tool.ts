// T31: MCP surface for the 1:1 loop + read-back (M23 code half). One tool, two actions, both built on
// @mole/oneonone's deterministic matcher (R6: no model). 'prep' groups logged questions by FOLDER (never
// person) with the record (from .mole/decisions, same place @mole/decisions already reads) that already
// answers each one; 'readback' records a folder owner's confirm/reject of a match, stored locally under
// .mole/local/oneonone (nothing leaves the machine unless shared, per the task's done-when #3).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MoleMcpOptions } from './server.js';
import { sc } from './annotations.js';
import { confineToRoot } from './safe-path.js'; // T91 review fix HIGH 2

interface LoggedQuestion {
  id: string;
  text: string;
  folder: string;
  loggedAt: string;
}

/** Real records from .mole/decisions/*.md (same source @mole/decisions reads); never invented. */
function decisionRecords(root: string): Array<{ id: string; file: string; folder: string; excerpt: string }> {
  const dir = join(root, '.mole', 'decisions');
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; file: string; folder: string; excerpt: string }> = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const file = `.mole/decisions/${name}`;
    try {
      const excerpt = readFileSync(join(dir, name), 'utf8').slice(0, 900);
      out.push({ id: name.replace(/\.md$/, ''), file, folder: '.mole/decisions', excerpt });
    } catch {
      /* unreadable record: skip, never invent */
    }
  }
  return out;
}

function loadQuestions(path: string): LoggedQuestion[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LoggedQuestion[];
  } catch {
    return [];
  }
}

export function registerOneOnOneTool(server: McpServer, opts: MoleMcpOptions): void {
  server.registerTool(
    'mole_oneonone',
    {
      title: 'Mole 1:1 prep + read-back',
      description:
        "T31: questions logged via the hover 'Ask' button, grouped by FOLDER (never by person, D31/M23 non-goal) with any " +
        '.mole/decisions record that already answers them (deterministic idf-weighted match, 0 model calls). action=prep lists ' +
        "a folder's open questions for the next 1:1; action=readback stores a folder owner's confirm/reject of a match, per " +
        'folder + question id, never per person. Nothing leaves this machine unless shared. The 2-week people pilot (D7) is ' +
        'out of scope here.',
      inputSchema: {
        action: z.enum(['prep', 'readback']),
        root: z.string().optional().describe('repository root (default: the server root, MOLE_ROOT or cwd)'),
        questionsFile: z.string().optional().describe('JSON file of logged questions (default: .mole/local/oneonone/questions.json)'),
        folder: z.string().optional().describe('restrict prep to one folder; required for readback'),
        questionId: z.string().optional().describe('readback: the question id being confirmed/rejected'),
        verdict: z.enum(['confirmed', 'rejected']).optional().describe('readback: the owner\'s verdict'),
        recordId: z.string().optional().describe('readback: the record id the verdict is about, if the question had a match'),
      },
      // T50: action=prep is a pure read; action=readback writes a local confirm/reject verdict
      // (.mole/local/oneonone/readback.json) -- never read-only overall, so this tool is NOT in the audit's
      // read-only list. idempotentHint: true because storing the same verdict twice has the same end state.
      annotations: { title: 'Mole 1:1 prep + read-back', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: z.object({ groups: z.array(z.unknown()).optional(), readback: z.unknown().optional(), stored: z.unknown().optional() }).passthrough(),
    },
    async (args) => {
      try {
        const root = confineToRoot(opts.root, args.root, 'root');
        const { buildMatcher, prep, recordReadBack, loadReadBack, defaultReadBackPath } = await import('@mole/oneonone');
        if (args.action === 'readback') {
          if (!args.folder || !args.questionId || !args.verdict) {
            return { content: [{ type: 'text' as const, text: 'mole_oneonone readback: folder, questionId and verdict are required' }], isError: true };
          }
          const path = defaultReadBackPath(root);
          const store = recordReadBack(path, args.folder, args.questionId, args.verdict, args.recordId);
          const out = { stored: store[args.folder]?.[args.questionId] };
          return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }], structuredContent: sc(out) };
        }
        const questionsPath = args.questionsFile
          ? confineToRoot(root, args.questionsFile, 'questionsFile')
          : join(root, '.mole', 'local', 'oneonone', 'questions.json');
        const questions = loadQuestions(questionsPath);
        const records = decisionRecords(root);
        const matcher = buildMatcher(records);
        let groups = prep(matcher, questions);
        if (args.folder) groups = groups.filter((g) => g.folder === args.folder);
        const readback = loadReadBack(defaultReadBackPath(root));
        const out = { groups, readback };
        return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }], structuredContent: sc(out) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `mole_oneonone: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
