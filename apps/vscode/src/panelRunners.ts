// T34 one-panel: the real (CLI-backed) Runners implementation for src/panelData.ts's buildPanelModel.
// Deliberately shells out to the already-bundled daemon CLI (dist/daemon.cjs / packages/daemon/src/cli.ts)
// for every @mole/decisions, @mole/flows, @mole/agentstate and @mole/history/@mole/questions read, instead
// of importing those packages directly into the extension host bundle: @mole/decisions's rules checker does
// a runtime `import('dependency-cruiser')`, which esbuild.mjs only excludes from the *daemon* bundle, not
// the extension host one (see (internal reference removed) log/key-changes.md #2). `mole map`/`mole impact` reuse
// the existing MoleClient (the daemon is already running for the map panel); everything else is a quick
// child_process call to the same CLI note/memory/since already use.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MoleClient } from '@mole/daemon';
import { buildTreeGraph, draftsFromNotes, renderSvg } from '@mole/reviews';
import { selectTests } from '@mole/verify';
// T31: @mole/oneonone has no runtime-import deps like dependency-cruiser (unlike @mole/decisions/rules,
// see the esbuild note above), so it's safe to import straight into the extension host, same as @mole/verify.
import { buildMatcher, prep, loadReadBack, defaultReadBackPath, type OneOnOneRecord, type Question } from '@mole/oneonone';
import type { Runners } from './panelData.js';

export interface CliHandle {
  cliPath: string;
  root: string;
  nodePath: string;
}

function run(h: CliHandle, args: string[], timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      h.nodePath,
      [h.cliPath, ...args, '--root', h.root, '--json'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: timeoutMs, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        // several subcommands (run-tests, check with no test reaching a change) use a non-zero exit code to
        // report a real, still-JSON result (fail != crash): only reject when stdout truly has nothing to parse.
        const text = stdout?.trim();
        if (!text) {
          const stderrMsg = stderr?.trim().split('\n').filter(Boolean).pop();
          reject(new Error(stderrMsg || (err ? err.message.split('\n')[0] : `mole ${args[0]} produced no output`)));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(stderr?.trim().split('\n')[0] || `mole ${args[0]}: could not parse its own --json output`));
        }
      },
    );
  });
}

/** `mole check --worktree --json`, cached per call site: --run-tests/--json is one more flag on the same
 *  command, so `check()`, `questions()` and `testsAtLine()` share one process instead of three. */
function checkOnce(h: CliHandle, extraArgs: string[] = []): Promise<Record<string, unknown>> {
  return run(h, ['check', '--worktree', ...extraArgs]) as Promise<Record<string, unknown>>;
}

export function makeRunners(h: CliHandle, client: () => MoleClient | undefined): Runners {
  let checkCache: Promise<Record<string, unknown>> | undefined;
  const cachedCheck = (): Promise<Record<string, unknown>> => (checkCache ??= checkOnce(h).catch((e) => { checkCache = undefined; throw e; }));

  return {
    async map(target) {
      const c = client();
      if (!c) throw new Error('index unavailable: the daemon has not started yet');
      return c.map(target);
    },
    async impact(target) {
      const c = client();
      if (!c) throw new Error('index unavailable: the daemon has not started yet');
      return c.map(target, true);
    },
    async flows(target) {
      return run(h, ['flows', target]);
    },
    async noteList(file) {
      const all = (await run(h, ['memory'])) as Array<{ file: string }>;
      return Array.isArray(all) ? all.filter((e) => e.file === file) : [];
    },
    async since() {
      return run(h, ['since']);
    },
    async check() {
      const r = await cachedCheck();
      return r;
    },
    async questions() {
      const r = await cachedCheck();
      return { questions: r.questions ?? [], notices: [], facts: { hunks: r.hunks ?? [], notes: [], guards: [] } };
    },
    async decisions() {
      return run(h, ['decisions']);
    },
    async rules() {
      return run(h, ['rules']);
    },
    async testsAtLine(file, line) {
      // selectTests (static call-graph analysis only, no test execution) is fast enough for every refresh;
      // vitest only runs when the user clicks the view's "Run" button (panelView.runTests, --run-tests below).
      void file;
      void line;
      const sel = await selectTests(resolve(h.root), { worktree: true });
      return sel.tests;
    },
    async claims(runId) {
      let id = runId;
      if (!id) {
        const runs = (await run(h, ['runs'])) as { runs?: Array<{ id: string }> };
        id = runs.runs?.[0]?.id;
      }
      if (!id) return { claims: [] };
      return run(h, ['claims', id]);
    },
    async collisions() {
      return run(h, ['collisions']);
    },
    async tried(target) {
      return run(h, ['tried', target]);
    },
    async agentIntent(target) {
      return run(h, ['agent-intent', target]);
    },
    async oneonone() {
      const root = h.root;
      const decisionsDir = join(root, '.mole', 'decisions');
      const records: OneOnOneRecord[] = existsSync(decisionsDir)
        ? readdirSync(decisionsDir)
            .filter((n) => n.endsWith('.md'))
            .sort()
            .map((n) => {
              let excerpt = '';
              try {
                excerpt = readFileSync(join(decisionsDir, n), 'utf8').slice(0, 900);
              } catch {
                excerpt = '';
              }
              return { id: n.replace(/\.md$/, ''), file: `.mole/decisions/${n}`, folder: '.mole/decisions', excerpt };
            })
        : [];
      const questionsPath = join(root, '.mole', 'local', 'oneonone', 'questions.json');
      let questions: Question[] = [];
      if (existsSync(questionsPath)) {
        try {
          questions = JSON.parse(readFileSync(questionsPath, 'utf8')) as Question[];
        } catch {
          questions = [];
        }
      }
      const matcher = buildMatcher(records);
      const groups = prep(matcher, questions);
      const readback = loadReadBack(defaultReadBackPath(root));
      return { groups, readback };
    },
    /** T40: design review / meeting note drafts (Granola model, D38 -- never invented) + a deterministic
     *  delta diagram of the working tree over the file tree (PR Lens pattern), both from @mole/reviews. */
    async reviewNotes() {
      const root = resolve(h.root);
      const notesDir = `${root}/.mole/local/meetings`;
      let files: string[] = [];
      try {
        files = readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort();
      } catch {
        files = [];
      }
      const drafts = files.flatMap((f) => {
        const text = readFileSync(`${notesDir}/${f}`, 'utf8');
        return draftsFromNotes(root, text).map((d) => ({ ...d, source: f }));
      });
      const changedFiles = await new Promise<string[]>((resolveFiles) => {
        execFile('git', ['-C', root, 'diff', '--name-only', 'HEAD'], { timeout: 5000 }, (err, stdout) => resolveFiles(err ? [] : stdout.split('\n').map((s) => s.trim()).filter(Boolean)));
      });
      const graph = buildTreeGraph(root, changedFiles);
      const diagramSvg = graph.nodes.length ? renderSvg(graph, { changed: '#2b7de9', unchanged: '#8a8a8a' }) : undefined;
      return { drafts, diagramSvg, meetingFiles: files };
    },
    // T62 Reasoning section: the same daemon CLI JSON the MCP tools return (T60 priorities, T58 incidents, T56 proposals)
    async prioritiesList() {
      return run(h, ['priorities', 'list']) as never;
    },
    async priorities() {
      // `mole priorities` with no flag is the plain engine (no phase, T60 design); the panel wants the phase in force
      // today, so it asks with the local date
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return run(h, ['priorities', '--at', today]) as never;
    },
    async prioritiesCompare(a, b) {
      return run(h, ['priorities', 'compare', a, b]) as never;
    },
    // T73: the panel's "compare with order X" what-if -- never writes .mole/priorities.md (the CLI's own
    // `whatif` subcommand is read-only, @mole/decisions compareWithOrder); resolved against today, same as
    // `priorities()` above, so the baseline side of the diff matches what the passive section already shows.
    async prioritiesWhatIf(order) {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return run(h, ['priorities', 'whatif', '--order', order.join(','), '--at', today]) as never;
    },
    async incidents() {
      return run(h, ['incident', 'list']) as never;
    },
    async proposals() {
      return run(h, ['proposals']) as never;
    },
  };
}
