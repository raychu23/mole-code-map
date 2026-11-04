#!/usr/bin/env node
// SessionStart hook (T15): your notes (T11, `mole memory --json`) on the files in play, as context for Claude.
// T21: plus other parallel runs whose work meets this session's (`mole collisions --run <session>`; resumed sessions).
// Files in play = uncommitted changes (git status, untracked included) + files changed in the last 3 commits.
// Also records HEAD for this session, so the Stop hook can check everything the session changed, commits included.
// Output (https://code.claude.com/docs/en/hooks#sessionstart): {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
// Nothing to say (no git, no notes, no Mole CLI) = no output, exit 0.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clip, collisionsStartText, decisionsBlock, emit, findMole, git, governingDecisions, moleJson, readInput, repoRoot, saveSession, sessionCollisions, weakSpotsLine } from './lib.mjs';

const RECENT_COMMITS = 3;

function filesInPlay(root) {
  const files = new Set();
  for (const line of (git(root, ['status', '--porcelain', '--untracked-files=all']) ?? '').split('\n')) {
    if (line.length < 4) continue;
    const p = line.slice(3);
    for (const part of p.split(' -> ')) files.add(part.replace(/^"|"$/g, ''));
  }
  const log = git(root, ['log', '-n', String(RECENT_COMMITS), '--name-only', '--format=']) ?? '';
  for (const f of log.split('\n')) if (f.trim()) files.add(f.trim());
  return files;
}

const STALE = new Set(['stale', 'orphaned']);

function notesText(root, mole) {
  if (!existsSync(join(root, '.mole', 'notes'))) return ''; // no notes: do not load the TypeScript compiler for nothing
  const inPlay = filesInPlay(root);
  const list = moleJson(mole, root, ['memory', '--json']);
  if (!Array.isArray(list)) return '';
  const hits = list.filter((e) => e.status !== 'invalid' && ((e.path && inPlay.has(e.path)) || (e.newPath && inPlay.has(e.newPath))));
  if (hits.length === 0) return '';
  const lines = hits.map((e) => {
    const symbol = e.symbol?.includes('#') ? e.symbol : `${e.path}#${e.symbol}`;
    const flag = STALE.has(e.status) || (e.status === 'moved' && e.changed) ? `${e.status.toUpperCase()} (stale: the code changed since this note was written; verify before relying on it)` : e.status;
    const where = e.newPath ? ` now at ${e.newPath}${e.line ? `:${e.line}` : ''}` : e.line ? ` line ${e.line}` : '';
    return `- [${flag}] ${symbol}${where}: ${String(e.text).trim().replace(/\n+/g, ' ')}  (${e.file}${e.author ? `, ${e.author}` : ''}${e.written ? ` ${e.written.slice(0, 10)}` : ''})`;
  });
  return `Mole notes on the files in play (${hits.length} of ${list.length} notes in .mole/notes; files in play = uncommitted + last ${RECENT_COMMITS} commits). These are the team's own notes on these symbols:\n${lines.join('\n')}`;
}

function decisionsText(root, mole) {
  const inPlay = filesInPlay(root);
  const list = governingDecisions(mole, root, inPlay);
  if (!list.length) return '';
  const block = decisionsBlock(list);
  const weak = weakSpotsLine(mole, root, inPlay);
  return weak ? `${block}\n\n${weak}` : block;
}

function main() {
  const input = readInput();
  const root = repoRoot(input.cwd || process.cwd());
  if (!root) return;
  saveSession(input.session_id, { root, head: git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '', started: new Date().toISOString(), source: input.source ?? '' });
  const mole = findMole(root);
  if (!mole) return;
  // T21: other parallel runs whose work meets this session's (a resumed or compacted session has steps already)
  // T37: the decisions (+ T35 weak spots) governing the files in play -- the plugin's own reason to exist (D31)
  const parts = [notesText(root, mole), decisionsText(root, mole), collisionsStartText(sessionCollisions(mole, root, input, 20_000), input.session_id)].filter(Boolean);
  if (!parts.length) return;
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: clip(parts.join('\n\n')) } });
}

try {
  main();
} catch (e) {
  process.stderr.write(`mole session-start hook: ${e.message}\n`);
}
process.exitCode = 0; // not process.exit(): stdout to a pipe is asynchronous on macOS and would be cut
