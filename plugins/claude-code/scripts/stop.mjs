#!/usr/bin/env node
// Stop hook (T15): `mole check` on the session's diff, questions first, shown to you as a systemMessage.
// T21: plus what this session edited that another parallel run relies on (`mole collisions --run <session>`).
// The session's diff = everything since HEAD at SessionStart (commits the session made + uncommitted edits), via
// `mole check --diff <git diff base> --base <base>`; without a recorded start, the working tree vs HEAD (`mole check --worktree`).
// It informs and never blocks Claude from stopping. MOLE_STOP_CONTINUE=1 also hands the questions to Claude as
// hookSpecificOutput.additionalContext (which makes Claude continue once; skipped when stop_hook_active is true).
// Output: https://code.claude.com/docs/en/hooks#stop-decision-control . Nothing to say = no output, exit 0.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clip, collisionsStopText, crispViolations, crispViolationsForOverlay, decisionsDiffText, emit, findMole, git, loadSession, moleJson, readInput, repoRoot, ruleFixHint, ruleViolationsText, saveSession, sessionBaselineContent, sessionCollisions, violationKey } from './lib.mjs';
import { runVerifier, verifierParts } from './verify.mjs';

// T92/D102: crisp (zero-model, deterministic) decision-rule violations block Claude from stopping by default --
// the exact contract Anthropic's own hooks docs ship for Stop (decision: "block" + reason; fetched 2026-11-04,
// code.claude.com/docs/en/hooks#stop-decision-control; see this task's 4 log/prior-art.md). By-meaning/judged
// matches (verify.mjs's verifierParts) stay advisory text only -- never this block path; only a rule a decision
// record itself wrote (packages/decisions/src/rules, T27) counts.
// T92 review-1 fix (HIGH 2): this used to block on ANY crisp violation among `files` (what the session's diff
// touched), including one that pre-dates the session entirely (already committed to HEAD, or already dirty in
// the working tree before SessionStart ever ran) -- a false-positive block on pre-existing state, not on
// anything this session did. Fixed: only the files that have a violation RIGHT NOW are checked against their
// SESSION-START baseline (lib.mjs's sessionBaselineContent: the file's content at SessionStart, via a recorded
// git blob for an already-dirty file or the session's head commit otherwise -- never a checkout), evaluated on
// a throwaway overlay (crispViolationsForOverlay), and only a violation key (decision id + rule + file +
// target, lib.mjs's violationKey) present now but absent from that baseline blocks. Semantics vs PreToolUse:
// PreToolUse denies per-EDIT (before = this file's content right before the edit, after = right after it, so
// it catches a new violation at the instant it would be introduced); Stop blocks per-SESSION (before = this
// file's content at SessionStart, now = its content at Stop time, so it catches anything still unresolved when
// the agent tries to finish, no matter which edit introduced it or whether PreToolUse saw that edit at all --
// e.g. a violation from a shell command, a merge, or a file PreToolUse's Edit|Write|MultiEdit matcher never saw).
// Loop safety, belt and suspenders:
//   1. stop_hook_active (the docs' own field): true means Claude is already continuing from an earlier block this
//      turn -- never block again, so a condition that never resolves can't spin forever.
//   2. a small per-session counter (MOLE_STOP_BLOCK_CAP, default 3) on top of Claude Code's own built-in
//      8-consecutive-continuation cap (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP) -- the UX research (ux-research 11-04,
//      item #1) says reuse that cap, don't build a new one; this counter is a cheap, independently-testable
//      defense-in-depth on top of it, not a replacement.
// Opt-out: MOLE_STOP_BLOCK=0 (documented in plugins/claude-code/README.md and scripts/public-README.md).
const STOP_BLOCK_CAP = Number(process.env.MOLE_STOP_BLOCK_CAP) > 0 ? Number(process.env.MOLE_STOP_BLOCK_CAP) : 3;

function stopBlockDecision(mole, root, files, input) {
  if (process.env.MOLE_STOP_BLOCK === '0') return undefined;
  if (input.stop_hook_active === true) return undefined; // already continuing from a block: never re-block
  const now = crispViolations(mole, root, files);
  if (!now.length) return undefined;
  // only the files with a violation right now need a baseline check -- a file with no violation now can't
  // contribute a "new" one, whatever its baseline looked like.
  const sess = loadSession(input.session_id);
  const nowFiles = [...new Set(now.map((v) => v.file))];
  const overrides = new Map(nowFiles.map((f) => [f, sessionBaselineContent(root, sess, f)]));
  const baseline = crispViolationsForOverlay(mole, root, overrides);
  const baseKeys = new Set(baseline.map(violationKey));
  const hits = now.filter((v) => !baseKeys.has(violationKey(v)));
  if (!hits.length) return undefined; // every violation present now already existed at session start
  const sessState = sess ?? {};
  const blocks = sessState.stopBlocks ?? 0;
  if (blocks >= STOP_BLOCK_CAP) return undefined; // our own cap reached: let Claude stop rather than loop forever
  saveSession(input.session_id, { ...sessState, stopBlocks: blocks + 1 });
  const lines = hits.map((v) => `- ${v.file}:${v.line} ${v.kind} ${v.target} breaks ${v.decision.id} "${v.decision.title}" \u2014 fix: ${ruleFixHint(v)} (rule ${v.rule} at ${v.decision.file}:${v.decision.line})`);
  return {
    decision: 'block',
    reason: `Mole: this change breaks ${hits.length} accepted decision rule${hits.length === 1 ? '' : 's'} (mole rules, zero-model, deterministic -- not a guess):\n${lines.join('\n')}\n\nFix the code (or get the decision changed), then stop. (opt out: MOLE_STOP_BLOCK=0; cap ${STOP_BLOCK_CAP}/session, then Claude Code's own ${process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8}-continuation cap applies)`,
  };
}

const range = (h) => (h.oldLines > 1 ? `${h.oldStart}-${h.oldStart + h.oldLines - 1}` : `${h.oldStart}`);
const one = (s, n = 240) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function why(f) {
  const src = f.reasonSources ?? [];
  const c = src.find((s) => s.kind === 'comment') ?? src.find((s) => s.kind === 'note') ?? src.find((s) => s.kind === 'task');
  return c ? `${c.text}${c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : ''}` : f.reason;
}

export function format(r, label) {
  const withFixes = r.hunks.filter((h) => h.pastFixes.length > 0);
  const out = [`Mole check on ${label}: ${r.hunks.length} edited hunk${r.hunks.length === 1 ? '' : 's'}, ${withFixes.length} on lines a past fix wrote.`];
  if (r.questions?.length) {
    out.push(`questions (${r.questions.length}):`);
    r.questions.forEach((q, i) => out.push(`  ${i + 1}. [${q.kind}] ${one(q.text, 600)}`, `     source: ${q.source.sha ? `${q.source.sha.slice(0, 7)} ` : ''}${q.source.file}:${q.source.line}`));
  }
  if (withFixes.length) {
    out.push('past fixes on the edited lines:');
    for (const h of withFixes) {
      out.push(`  ${h.file}:${range(h)}`);
      for (const f of h.pastFixes) {
        out.push(`    ${f.shortSha} ${one(f.subject, 160)}`, `      why: ${one(why(f), 300)}`);
        const tests = (f.tests ?? []).map((t) => `${t.file}${t.names?.length ? ` (${t.names.slice(0, 3).join('; ')})` : ''}`);
        out.push(`      tests: ${tests.length ? tests.join(', ') : 'none found'}`, `      source: ${f.source.sha.slice(0, 7)} ${f.source.file}:${f.source.line}`);
      }
    }
  }
  const others = r.hunks.length - withFixes.length;
  if (others > 0) out.push(`(${others} other hunk${others === 1 ? '' : 's'}: no past fixes on those lines)`);
  return out.join('\n');
}

// T24: one line per claim in the session's last answer that its own tool calls don't back (unsupported / contradicted)
// Quiet and short: an unknown session (`mole claims` exits 1), a timeout (10 s) or a crash prints nothing, every stop.
function claimLines(mole, root, sessionId) {
  if (!sessionId) return [];
  let r;
  try {
    const out = execFileSync(mole[0], [...mole[1], 'claims', String(sessionId), '--json', '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    r = JSON.parse(out);
  } catch {
    return [];
  }
  // round-8 precision guard: only the flags `mole claims` marks hook-worthy (strong reasons, success claims)
  return (r?.claims ?? []).filter((c) => c.verdict !== 'supported' && c.hook !== false).map((c) => `mole claims: ${c.verdict}: "${one(c.text, 200)}" (${one(c.why, 160)})`);
}

function checkResult(root, mole, input) {
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '';
  const sess = loadSession(input.session_id);
  const base = sess && sess.root === root && sess.head && sess.head !== head && git(root, ['cat-file', '-e', `${sess.head}^{commit}`]) !== undefined ? sess.head : undefined;
  let r;
  let label;
  if (base) {
    const diff = git(root, ['diff', '--no-color', '--no-ext-diff', base]);
    if (!diff?.trim()) return done();
    const dir = mkdtempSync(join(tmpdir(), 'mole-stop-'));
    try {
      const file = join(dir, 'session.diff');
      writeFileSync(file, diff);
      r = moleJson(mole, root, ['check', '--diff', file, '--base', base, '--json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    label = `this session's diff (since ${base.slice(0, 7)}, commits + uncommitted)`;
  } else {
    r = moleJson(mole, root, ['check', '--worktree', '--json']);
    label = 'the uncommitted change (working tree vs HEAD)';
  }
  if (!r || !Array.isArray(r.hunks)) return undefined;
  const fixes = r.hunks.some((h) => h.pastFixes.length > 0);
  if (!fixes && !(r.questions?.length > 0)) return undefined;
  return { r, label };
}

// T37: files this session's diff touched, independent of whether `mole check` found a past fix or a question (checkResult
// below returns undefined then, but decisions-touched / rule-violation reporting must not depend on that).
function diffFiles(root, input) {
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '';
  const sess = loadSession(input.session_id);
  const base = sess && sess.root === root && sess.head && sess.head !== head && git(root, ['cat-file', '-e', `${sess.head}^{commit}`]) !== undefined ? sess.head : undefined;
  if (base) {
    const out = git(root, ['diff', '--name-only', base]) ?? '';
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const files = new Set();
  for (const line of (git(root, ['status', '--porcelain', '--untracked-files=all']) ?? '').split('\n')) {
    if (line.length < 4) continue;
    const p = line.slice(3);
    for (const part of p.split(' -> ')) files.add(part.replace(/^"|"$/g, ''));
  }
  return [...files];
}

function main() {
  const input = readInput();
  const root = repoRoot(input.cwd || process.cwd());
  if (!root) return;
  const mole = findMole(root);
  if (!mole) return;
  const check = checkResult(root, mole, input);
  const files = diffFiles(root, input);
  // T37: decisions this session's diff touched (with their current flag) + T27 rule violations it introduced
  const decisions = decisionsDiffText(mole, root, files);
  const violations = ruleViolationsText(mole, root, files);
  // T21: what this session edited that another parallel run relies on
  const coll = collisionsStopText(sessionCollisions(mole, root, input, 35_000), input.session_id);
  const claims = claimLines(mole, root, input.session_id); // T24: unsupported / contradicted claims in the last answer
  // T65: Mole's measured verifier (cascade + semantic routing) on the session's change; first, since it is the one that
  // can say "this violates decision X, because ..."
  const sess = loadSession(input.session_id);
  const verified = verifierParts(runVerifier(mole, root, sess && sess.root === root ? sess.head : undefined));
  const block = stopBlockDecision(mole, root, files, input); // T92/D102: crisp-rule violation -> decision: "block"
  const parts = [verified.text, check ? format(check.r, check.label) : '', decisions, violations, coll, claims.join('\n')].filter(Boolean);
  if (!parts.length && !block) return;
  const msg = parts.length ? { systemMessage: clip(parts.join('\n\n')) } : {};
  const cont = [];
  if (verified.continueText) cont.push(verified.continueText);
  if (check && check.r.questions?.length) cont.push(`Mole asks about the lines you just edited (answer briefly, then stop):\n${check.r.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}`);
  if (cont.length && process.env.MOLE_STOP_CONTINUE === '1' && input.stop_hook_active !== true) {
    msg.hookSpecificOutput = { hookEventName: 'Stop', additionalContext: clip(cont.join('\n\n')) };
  }
  if (block) Object.assign(msg, block); // decision: "block" + reason -- top-level fields, Stop's own contract
  emit(msg);
}

try {
  main();
} catch (e) {
  process.stderr.write(`mole stop hook: ${e.message}\n`);
}
process.exitCode = 0; // not process.exit(): stdout to a pipe is asynchronous on macOS and would be cut
