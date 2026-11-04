#!/usr/bin/env node
// mole daemon | map | impact | check | status | stop | reindex  — thin CLI over the daemon (offerings F1.9).
// mole note add <file#Symbol> "text" | mole memory [--json]  — L2 notes on code (T11), no daemon needed.
// mole since [--json] | mole seen <file#Symbol>... | mole seen --stdin  — L1 what changed since you last looked (T13), no daemon needed.
import { defaultSources } from './detect.js';
import { resolve } from 'node:path';
import { formatNeighborhood } from '@mole/core';
import type { MemoryEntry, SeenInput } from '@mole/memory';
import { readFileSync } from 'node:fs';
import type { Change } from '@mole/history';
import { ensureDaemon, MoleClient } from './client.js';
// heavy modules (TypeScript compiler, SQLite, git history) load only in the subcommand that needs them:
// every CLI call loading all of them made a 3-call CLI test exceed 5 s on a loaded machine

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function formatMemory(list: MemoryEntry[]): string {
  if (list.length === 0) return 'mole: no notes (.mole/notes is empty)';
  return list
    .map((e) => {
      if (e.status === 'invalid') return `invalid   ${e.problem ?? e.file}`;
      const status = e.status === 'moved' && e.changed ? 'moved*' : e.status;
      const where = e.newPath ? ` -> ${e.newPath}${e.line ? `:${e.line}` : ''}` : e.line ? `:${e.line}` : '';
      const text = e.text.split('\n')[0] ?? '';
      // T19: a renamed symbol keeps its note ('renamed' = only the name changed, fresh; 'renamed + changed' = stale)
      const sym = e.renamedTo
        ? `${e.changed ? 'renamed + changed' : 'renamed'}: ${e.symbol} → ${e.renamedTo}${e.line ? `:${e.line}` : ''}`
        : `${e.symbol}${where}`;
      const ambiguous = e.candidates?.length ? `  (ambiguous rename, not re-anchored: ${e.candidates.join(', ')})` : '';
      return `${status.padEnd(9)} ${sym}  ${text.length > 80 ? `${text.slice(0, 77)}...` : text}  (${e.file})${ambiguous}`;
    })
    .join('\n') + (list.some((e) => e.status === 'moved' && e.changed) ? '\n(moved* = moved and its body changed since the note)' : '');
}

async function main(): Promise<number> {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  const root = resolve(str(flags.root) ?? process.cwd());
  if (cmd === 'note') {
    const [sub, target, ...words] = pos;
    if (sub !== 'add' || !target || words.length === 0) {
      console.error('usage: mole note add <file#Symbol> "text" [--root DIR] [--author NAME]');
      return 2;
    }
    const { addNote } = await import('@mole/memory');
    const n = addNote(root, target, words.join(' '), { author: str(flags.author) });
    console.log(`wrote ${n.file} on ${n.symbol} (hash ${n.hash})`);
    // writing a note is a look (L1, T13): `mole since` then reports changes after it
    try {
      const { appendSeen } = await import('@mole/memory');
      appendSeen(root, [{ path: n.path, tail: n.symbol.slice(n.symbol.indexOf('#') + 1), how: 'note' }]);
    } catch {
      // the note is written; a seen log that cannot be written must not fail it
    }
    return 0;
  }
  if (cmd === 'memory') {
    const { memory } = await import('@mole/memory');
    const list = memory(root);
    console.log(flags.json ? JSON.stringify(list, null, 2) : formatMemory(list));
    return 0;
  }
  if (cmd === 'since') {
    // L1 (T13): the symbols you looked at whose body changed after your last look
    const { formatSince, since } = await import('@mole/memory');
    const r = since(root);
    console.log(flags.json ? JSON.stringify(r, null, 2) : formatSince(r));
    return 0;
  }
  if (cmd === 'seen') {
    // record looks: `mole seen <file#Symbol>... [--how visible|hover|note]`, or a JSON batch on stdin (the VS Code extension's sink)
    const { appendSeen, splitTarget } = await import('@mole/memory');
    let inputs: SeenInput[];
    if (flags.stdin) {
      const raw = readFileSync(0, 'utf8').trim();
      const parsed: unknown = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      inputs = Array.isArray(parsed) ? (parsed as SeenInput[]) : [];
    } else {
      const how = (str(flags.how) ?? 'visible') as SeenInput['how'];
      if (pos.length === 0 || !['visible', 'hover', 'note'].includes(how)) {
        console.error('usage: mole seen <file#Symbol>... [--how visible|hover|note] [--root DIR] | mole seen --stdin  (JSON [{path, tail, how, time?, text?}])');
        return 2;
      }
      inputs = [];
      for (const t of pos) {
        const s = splitTarget(root, t);
        if (s) inputs.push({ ...s, how });
        else console.error(`mole seen: not a file#Symbol target: ${t}`);
      }
    }
    const ev = appendSeen(root, inputs);
    if (!flags.stdin || flags.verbose) console.log(`recorded ${ev.length} look${ev.length === 1 ? '' : 's'} in .mole/local/seen.jsonl${ev.length < inputs.length ? ` (${inputs.length - ev.length} unknown symbol${inputs.length - ev.length === 1 ? '' : 's'} skipped)` : ''}`);
    return ev.length === 0 && inputs.length > 0 && !flags.stdin ? 1 : 0;
  }
  if (cmd === 'claims') return (await import('./_oss-agentstate-stub.js')).claimsCli(pos, flags); // claim check (T24): light entry, no daemon
  if (cmd === 'steer') return (await import('@mole/steer/dist/src/cli.js')).steerCli(pos, flags, root); // T74: signal/update/query/deliver, light entry, no daemon
  if (['runs', 'run', 'tried', 'agents', 'agent-intent', 'collisions'].includes(cmd)) return (await import('./_oss-agentstate-stub.js')).agentCli(cmd, pos, flags, root); // agent states (T18) + collisions (T21) + external agent-session intent (T39), no daemon needed
  if (cmd === 'decisions') return (await import('@mole/decisions')).decisionsCli(pos, flags, root); // decision graph + flags (T29), no daemon needed
  if (cmd === 'decision') return (await import('@mole/decisions')).decisionCli(pos, flags, root); // write records: new / supersede / link / suggest / recover (T51)
  if (cmd === 'incident') return (await import('@mole/decisions')).incidentCli(pos, flags, root); // incident revives dissent: suggest / accept / dismiss (T58)
  if (cmd === 'priorities') return await (await import('@mole/decisions')).prioritiesCli(pos, flags, root); // tenet order per phase, launch -> scale (T60)
  if (cmd === 'recall') return (await import('@mole/decisions')).recallCli(pos, flags, root); // T71: similar past decisions/incidents, Klein RPD "resembles", read-only
  if (cmd === 'export') return (await import('@mole/decisions')).exportCli(pos, flags, root); // T72: `mole export --format okf` -- OKF v0.2 bundle, no daemon needed
  if (cmd === 'assurance') return (await import('@mole/decisions')).assuranceCli(pos, flags, root); // T78 (D65): assured share of door: one-way decisions per governed folder, no daemon needed
  if (cmd === 'outcomes') return (await import('@mole/decisions')).outcomesCli(pos, flags, root); // T81 (D66): prediction vs outcome + due/overdue checks, no daemon needed
  if (cmd === 'proposals') { // this repo's what-if proposals vs their baseline, same JSON as mole_proposals_compare (T62); read-only
    try {
      console.log(JSON.stringify((await import('@mole/proposals')).summarizeProposals(root, pos.length ? pos : undefined, { ...(typeof flags.phase === 'string' ? { phase: flags.phase } : {}), ...(typeof flags.at === 'string' ? { at: flags.at } : {}), ...(typeof flags.order === 'string' ? { order: flags.order.split(',').map((s) => s.trim()).filter(Boolean) } : {}) }), null, 2)); // T68 review: forward --phase/--at; T73: --order (a what-if, never written)
      return 0;
    } catch (e) {
      console.error(`mole proposals: ${(e as Error).message}`);
      return 2;
    }
  }
  if (cmd === 'pr-check') return (await import('@mole/decisions')).prCheckCli(pos, flags, root);
  if (cmd === 'flows') return (await import('@mole/flows')).flowsCli(pos, flags, root); // runtime call flows recorded from tests (T28), no daemon needed
  if (cmd === 'rules') return (await import('@mole/decisions')).rulesCli(pos, flags, root);
  if (cmd === 'compile') return (await import('@mole/decisions')).compileCli(pos, flags, root); // T46: compile-at-capture (draft/approve/reject/status)
  if (cmd === 'arguments') return (await import('@mole/decisions')).argumentsCli(pos, flags, root); // T80: captured-argument capture/approve/reject/list
  if (cmd === 'cascade-check') return (await import('@mole/decisions')).cascadeCheckCli(pos, flags, root); // T46: zero-LLM tier then one-call LLM escalation
  if (cmd === 'coverage') return (await import('./_oss-coverage-stub.js')).coverageCli(pos, flags, root); // which agents cover which files, weak spots (T35)
  if (cmd === 'hotspots') return (await import('@mole/hotspots/dist/src/cli.js')).hotspotsCli(pos, flags, root); // T70/D68: churn x complexity x decision volatility x fix density, ranked
  if (cmd === 'coupling') return (await import('@mole/coupling/dist/src/cli.js')).couplingCli(pos, flags, root); // T77/D69: logical coupling (co-change) x CODEOWNERS teams, cross-team pairs first
  if (['interrogate', 'check-records'].includes(cmd)) return (await import('@mole/intake')).intakeCli(pos, flags, root); // T23: agents interrogate, people write
  if (cmd === 'demo') return (await import('./demo.js')).demoCli(); // T87: 30-second sample-repo walkthrough, no daemon, no network, no model calls
  const stateDir = str(flags['state-dir']);
  const common = { root, stateDir, ...defaultSources(root, str(flags.tsconfig), str(flags['src-dir'])) };

  if (cmd === 'daemon') {
    // a background process nobody asked for must not outlive its editor: stop after 30 idle minutes (0 = never)
    const idleMinutes = Number(str(flags['idle-minutes']) ?? 30);
    const { Daemon } = await import('./server.js');
    const otel = await import('@mole/telemetry'); // T16: RPC spans when MOLE_OTEL=1, flushed on stop
    await otel.startTelemetry('mole-daemon');
    const d = new Daemon({ ...common, idleMs: Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60_000 : 0, log: (l) => console.error(`[mole] ${l}`) });
    await d.start();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void d.stop());
    await d.closed;
    await otel.shutdownTelemetry();
    return 0;
  }
  if (cmd === 'map' || cmd === 'impact') {
    const target = pos[0];
    if (!target) {
      console.error(`usage: mole ${cmd} <path | path#Symbol | symbol> [--root DIR]`);
      return 2;
    }
    const client = flags['no-start'] ? new MoleClient({ root, stateDir }) : await ensureDaemon(common);
    let n = await client.map(target, cmd === 'impact');
    for (let i = 0; i < 100 && n.state === 'indexing'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      n = await client.map(target, cmd === 'impact');
    }
    console.log(flags.json ? JSON.stringify(n, null, 2) : formatNeighborhood(n));
    return n.state === 'ok' ? 0 : 1;
  }
  if (cmd === 'check') {
    // L2 (T12): past fixes that last wrote the lines a change edits, with their reason, guarding tests and source
    const sha = pos[0];
    const diffFile = str(flags.diff);
    const modes = [sha !== undefined, diffFile !== undefined, flags.worktree === true].filter(Boolean).length;
    if (modes !== 1) {
      console.error('usage: mole check <sha | --diff FILE [--base SHA] | --worktree> [--json] [--fix-rule RE] [--root DIR] [--notes-root DIR] [--reword] [--spec-kit [--adr-dir DIR[,DIR]]]');
      return 2;
    }
    if (flags['run-tests']) return (await import('@mole/verify')).verifyCli(pos, flags, root); // T22: run the tests that matter, no daemon needed
    const change: Change = diffFile !== undefined ? { diffFile: resolve(diffFile), base: str(flags.base) } : sha !== undefined ? { sha } : { worktree: true };
    // T16: with MOLE_OTEL=1 one span per stage under a root mole.check span, flushed before exit; otherwise no-ops, nothing loaded
    const otel = await import('@mole/telemetry');
    await otel.startTelemetry('mole-cli');
    try {
      return await otel.withSpan('mole.check', { 'mole.change.kind': 'sha' in change ? 'sha' : 'diffFile' in change ? 'diff' : 'worktree', 'mole.change.ref': sha ?? diffFile ?? 'working tree' }, async (span) => {
    // L3 (T14): at most 3 questions from templates over those facts (+ notes); T12's output fields stay as they were
    const [{ formatCheck }, { questions, formatQuestions }] = await Promise.all([import('@mole/history'), import('@mole/questions')]);
    const notesRoot = str(flags['notes-root']);
    const q = await otel.withSpan('mole.questions', {}, () => questions(root, change, { fixRule: str(flags['fix-rule']), notesRoot: notesRoot ? resolve(notesRoot) : undefined, reword: flags.reword === true }));
    span({ 'mole.hunks': q.facts.hunks.length, 'mole.past_fixes': q.facts.hunks.reduce((n, h) => n + h.pastFixes.length, 0), 'mole.questions.count': q.questions.length });
    for (const n of q.notices) console.error(`mole: ${n}`);
    const { notes: _notes, guards: _guards, ...r } = q.facts;
    // T36: --spec-kit (one flag) -- the files this change touched, cross-referenced against the decision graph's own
    // scope anchors (.mole + ADR folders + spec-kit specs/*/research.md), so a spec-kit /speckit.implement hook can
    // show the agent which decisions its change touched, same flags/hover/view the rest of Mole computes.
    let touched: Array<{ id: string; kind: string; title: string; flag: string; anchor: string }> | undefined;
    if (flags['spec-kit']) {
      const { computeFlags, loadGraph } = await import('@mole/decisions');
      const adrArg = str(flags['adr-dir']);
      const adrDirs = adrArg ? adrArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const graph = loadGraph(root, { adrDirs });
      const flagged = new Map(computeFlags(graph).map((f) => [f.id, f]));
      const changedFiles = new Set(q.facts.hunks.map((h) => h.file));
      touched = [];
      for (const n of graph.nodes) {
        if (n.scope.length === 0) continue;
        const hit = n.scope.find((a) => [...changedFiles].some((f) => f === a.target.replace(/\/$/, '') || f.startsWith(a.target.endsWith('/') ? a.target : `${a.target}/`) || a.target === f));
        if (!hit) continue;
        const f = flagged.get(n.id);
        touched.push({ id: n.id, kind: n.kind, title: n.title, flag: f?.flag ?? 'grey', anchor: hit.target });
      }
    }
    if (flags.json) console.log(JSON.stringify({ ...r, questions: q.questions, ...(touched ? { decisionsTouched: touched } : {}) }, null, 2));
    else {
      console.log(formatCheck(r) + (q.questions.length ? `\n\n${formatQuestions(q.questions)}` : ''));
      if (touched) {
        console.log(touched.length === 0 ? '\ndecisions touched: none' : `\ndecisions touched (${touched.length}):`);
        for (const t of touched) console.log(`  ${t.flag.padEnd(6)} ${t.id}  ${t.title}  (${t.anchor})`);
      }
    }
    return 0;
      });
    } finally {
      await otel.shutdownTelemetry();
    }
  }
  const client = new MoleClient({ root, stateDir });
  if (cmd === 'status') {
    try {
      console.log(JSON.stringify(await client.status(), null, 2));
      return 0;
    } catch {
      console.log('mole: daemon not running');
      return 1;
    }
  }
  if (cmd === 'stop' || cmd === 'reindex') {
    try {
      await client.call(cmd === 'stop' ? 'shutdown' : 'reindex');
      return 0;
    } catch {
      console.log('mole: daemon not running');
      return 1;
    }
  }
  console.error(
    'usage: mole <command> [target] [--root DIR] [--json]\n' +
      '  core:        daemon | map | impact | check | status | reindex | stop | demo\n' +
      '  notes:       note add | memory | since | seen\n' +
      '  decisions:   decision | decisions | rules | incident | priorities | recall | export | assurance | outcomes | proposals | compile | arguments | cascade-check | pr-check\n' +
      '  agent state: runs | run | tried | agents | agent-intent | collisions | claims | steer\n' +
      '  analysis:    coverage | hotspots | coupling | flows | interrogate | check-records\n' +
      '  flags:       [--state-dir DIR] [--tsconfig F] [--src-dir D] [--idle-minutes N]\n' +
      '  new here? -> mole demo',
  );
  return cmd === 'help' ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`mole: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
