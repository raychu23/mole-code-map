// Shared helpers for the Mole Claude Code hooks (node >= 22, no dependencies).
// Hook I/O follows https://code.claude.com/docs/en/hooks : JSON on stdin (session_id, cwd, hook_event_name, ...), JSON on
// stdout on exit 0. A hook never fails the session: any problem = exit 0 with no output (and a line on stderr, which Claude
// Code only writes to its debug log for exit 0).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Claude Code caps additionalContext / systemMessage at 10,000 characters. */
export const MAX_CHARS = 9500;

export function readInput() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, '-c', 'log.showSignature=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** The repository root of `cwd`, or undefined outside git. */
export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || undefined;
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * How the hooks find the Mole CLI, first match wins:
 *   1. MOLE_BIN: a path to the CLI (a .js/.cjs/.mjs file runs with this node; anything else is executed). Set but missing = no CLI.
 *   2. `mole` on PATH (npm link / a global install of @mole/daemon).
 *   3. packages/daemon/dist/cli.js in the session's repository (working on Mole itself) or next to this plugin (plugin used from a Mole checkout).
 * Returns [command, prefixArgs] or undefined.
 */
export function findMole(root) {
  const asCmd = (p) => (/\.[cm]?js$/.test(p) ? [process.execPath, ['--no-warnings', p]] : [p, []]);
  if (process.env.MOLE_BIN !== undefined && process.env.MOLE_BIN !== '') return isFile(process.env.MOLE_BIN) ? asCmd(resolve(process.env.MOLE_BIN)) : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && isFile(join(dir, 'mole'))) return [join(dir, 'mole'), []];
  // T86: the plugin's own bundled CLI (plugins/claude-code/dist/cli.js, built by scripts/build.mjs) is checked
  // FIRST -- it is what makes the plugin work with no repo checkout at all. The repo-relative paths below are the
  // fallback for working on Mole itself from an unbuilt plugin dir (no `node plugins/claude-code/scripts/build.mjs` run yet).
  for (const p of [resolve(here, '../dist/cli.js'), root && join(root, 'packages/daemon/dist/cli.js'), resolve(here, '../../../packages/daemon/dist/cli.js')]) if (p && isFile(p)) return asCmd(p);
  return undefined;
}

/** Run the Mole CLI and parse its --json output; undefined on any failure. */
export function moleJson(mole, root, args, timeoutMs = 45_000) {
  try {
    const out = execFileSync(mole[0], [...mole[1], ...args, '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    process.stderr.write(`mole hook: ${args[0]} failed: ${String(e.message ?? e).split('\n')[0]}\n`);
    return undefined;
  }
}

/** Where a session's start state lives: CLAUDE_PLUGIN_DATA (persistent plugin dir) else $TMPDIR/mole-claude-code. */
export function sessionFile(sessionId) {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'mole-claude-code'), 'sessions');
  return join(dir, `${String(sessionId || 'unknown').replace(/[^\w.-]/g, '_')}.json`);
}

export function saveSession(sessionId, data) {
  try {
    const f = sessionFile(sessionId);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(data));
  } catch {
    // no state = Stop falls back to the working tree vs HEAD
  }
}

export function loadSession(sessionId) {
  try {
    const f = sessionFile(sessionId);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

export const clip = (s, n = MAX_CHARS) => (s.length > n ? `${s.slice(0, n - 40)}\n… (cut at ${n} chars: run mole for the rest)` : s);

/** Print one JSON object for Claude Code and exit 0. */
export function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------- T21: parallel-agent collisions for this session
const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const via = (p) => (p.path?.length ? p.path.join(', ') : `shared ${p.shared.join(', ')}`);

/**
 * The repo root written the way Claude Code writes paths for this session (its cwd), not git's resolved form: transcripts
 * record cwd + file paths as the session saw them (/var/... vs git's /private/var/..., or a symlinked project folder), and
 * mole collisions matches runs to the repo by path prefix.
 */
export function sameFormRoot(root, cwd) {
  try {
    if (!cwd) return root;
    const rel = relative(root, realpathSync(cwd));
    if (rel.startsWith('..')) return root;
    const parts = rel ? rel.split('/').length : 0;
    let r = resolve(cwd);
    for (let i = 0; i < parts; i++) r = dirname(r);
    return realpathSync(r) === realpathSync(root) ? r : root;
  } catch {
    return root;
  }
}

/**
 * `mole collisions --json --run <session>` for the last few hours; undefined when the CLI fails or the session is unknown.
 * Only when the session's transcript already has a tool call: a session with no steps of its own can't collide, and the
 * CLI call (reads every harness's recent runs) is skipped. timeoutMs = this call's own budget inside the hook's Claude Code
 * timeout (MOLE_COLLISIONS_TIMEOUT_MS overrides); on timeout nothing is printed for collisions.
 */
export function sessionCollisions(mole, root, input, timeoutMs, hours = 4) {
  const sessionId = input.session_id;
  if (!sessionId || !input.transcript_path) return undefined;
  try {
    if (!readFileSync(input.transcript_path, 'utf8').includes('"tool_use"')) return undefined;
  } catch {
    return undefined;
  }
  const budget = Number(process.env.MOLE_COLLISIONS_TIMEOUT_MS) > 0 ? Number(process.env.MOLE_COLLISIONS_TIMEOUT_MS) : timeoutMs;
  const r = moleJson(mole, sameFormRoot(root, input.cwd), ['collisions', '--json', '--run', String(sessionId), '--since', String(hours)], budget);
  return r && Array.isArray(r.pairs) ? r : undefined;
}

/** SessionStart: other parallel runs whose work meets this session's (max 3 pairs). '' when none. */
export function collisionsStartText(r, sessionId) {
  const pairs = (r?.pairs ?? []).filter((p) => p.a.run === sessionId || p.b.run === sessionId);
  if (!pairs.length) return '';
  const out = [`mole: ${pairs.length} parallel run${pairs.length === 1 ? ' touches' : 's touch'} code near yours (mole collisions):`];
  for (const p of pairs.slice(0, 3)) {
    const other = p.a.run === sessionId ? p.b : p.a;
    const did = p.changes.filter((c) => c.run === other.run).map((c) => `${c.how === 'edit' ? 'edited' : 'read'} ${c.symbol} ${hhmm(c.time)}`);
    out.push(`- ${other.harness} ${other.run}${other.title ? ` (${other.title})` : ''}: ${did.join('; ') || 'related code'}`, `  path: ${via(p)}`);
  }
  if (pairs.length > 3) out.push(`(${pairs.length - 3} more: mole collisions --run ${sessionId})`);
  return out.join('\n');
}

/** Stop: what THIS session edited that another parallel run relies on, + its edits under notes. '' when none. */
export function collisionsStopText(r, sessionId) {
  const out = [];
  for (const p of r?.pairs ?? []) {
    if (p.a.run !== sessionId && p.b.run !== sessionId) continue;
    const other = p.a.run === sessionId ? p.b : p.a;
    // the other run relies on an edit of mine when it touched the same function, or its code calls (via the chain) the
    // function I edited: the chain's LAST node. A chain starting at my edit = I call into its code, not the other way round.
    const end = p.path?.length ? p.path.at(-1).split(' -> ').at(-1) : undefined;
    const theirs = new Set(p.changes.filter((c) => c.run === other.run).map((c) => c.symbol));
    const start = p.path?.length ? p.path[0].split(' -> ')[0] : undefined;
    for (const c of p.changes.filter((c) => c.run === sessionId && c.how === 'edit')) {
      const relies = p.shared.includes(c.symbol) || (end === c.symbol && start !== undefined && theirs.has(start));
      if (relies) out.push(`mole: you changed ${c.symbol}; ${other.harness} ${other.run} relies on it (${via(p)})`);
    }
  }
  for (const n of r?.notes ?? []) if (n.run === sessionId) out.push(`mole: you edited ${n.symbol} under note ${n.note}`);
  return [...new Set(out)].join('\n');
}

// ---------------------------------------------------------------- T37: the decisions behind the code, for the agent plugin
// Mole's plugin carries the PEOPLE's decisions (.mole/decisions/*.md, .mole/tenets.md) to the agent, and reports the
// agent's effect on them back to the person. Parsed here with a plain regex, not @mole/decisions:
// the plugin scripts stay dependency-free (see the file header), and this only needs id/title/status/approver/scope,
// never the full citator graph. Flags (red/yellow/green/grey) still come from the real engine via `mole decisions --json`.
const SCOPE_BUDGET = 1500; // M31a: the governing-decisions block's id/title/status/owner lines fit in 1,500 characters
// T43: each decision's full rationale (Decision + Context/Rationale + Consequences, MADR/Nygard section
// names -- the vocabulary graph.ts's loadAdrDir already recognizes for status) gets its own, separate,
// documented budget per decision, added after the one-liner. Kept well under MAX_CHARS (9500, Claude Code's
// additionalContext/systemMessage cap) even with several decisions in play; decisionsBlock's outer clip()
// in the hook scripts is the absolute last-resort cutoff, this budget is what should make that rare.
const RATIONALE_BUDGET_PER_DECISION = 1200;
// T43 review fix P1 (reviewer-1 FAIL on T43's first submission): decisionsBlock's per-decision budget had
// no AGGREGATE cap of its own, so with ~8+ decisions in play the rationale blocks together blew past the
// outer clip() (MAX_CHARS 9,500, see pre-tool-use.mjs/session-start.mjs) and clip() cut mid-block, mid-
// sentence -- never what "never mid-Decision" was supposed to mean. Kept comfortably under MAX_CHARS minus
// the SCOPE_BUDGET (1,500) one-liner list and some margin for the header/pointer line, so clip() is a true
// no-op on this function's own output and never has to cut inside a kept rationale block.
const RATIONALE_AGGREGATE_BUDGET = 6000;

function parseFrontMatterField(text, key) {
  const m = new RegExp(`^${key}:\\s*'?([^'\\n]*)'?\\s*$`, 'm').exec(text);
  return m ? m[1].trim() : undefined;
}

/** Dependency-free MADR/Nygard/adr-tools section extraction (mirrors packages/decisions/src/rationale.ts's
 * sectionsOf exactly in spirit -- kept as a separate, duplicated implementation here on purpose, since
 * these hook scripts stay dependency-free, see the file header comment above). Returns {} with the whole
 * stripped body as `decision` when no recognized '##'/'###' heading is found. */
function stripFrontMatterBody(text) {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return text;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end < 0 ? text : lines.slice(end + 1).join('\n');
}

function bucketOf(heading) {
  const h = heading.toLowerCase();
  // same rule as packages/decisions/src/rationale.ts: 'decision drivers' is context (T54 review 2)
  if (/^decision\b(?!\s+drivers\b)/.test(h) || /^decision outcome\b/.test(h)) return 'decision';
  if (/^consequences\b/.test(h)) return 'consequences';
  if (/^context\b/.test(h) || /^rationale\b/.test(h) || /^decision drivers\b/.test(h) || /^considered options\b/.test(h) || /^links\b/.test(h)) return 'context';
  return undefined;
}

/** Mirrors packages/decisions/src/rationale.ts's sectionsOf exactly (P0/P2 review fix: the two were
 * drifting -- this one kept a one-off `^entity references\b` hack the TS side never had, and both used to
 * silently drop an unmatched sibling heading next to a matched one, e.g. Backstage adr001's Discussion/Risks
 * next to Decision). Exported so a parity test can run both implementations on the same fixtures and fail
 * on any difference, instead of relying on eyeballing two copy-pasted functions staying in sync. */
export function sectionsOfText(text) {
  const body = stripFrontMatterBody(text);
  const lines = body.split(/\r?\n/);
  const idx = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{2,3}\s+(.+?)\s*$/.exec(lines[i] ?? '');
    if (m) idx.push({ line: i, heading: m[1] });
  }
  if (idx.length === 0) {
    const whole = body.trim();
    return whole ? { decision: whole } : {};
  }
  const anyMatched = idx.some(({ heading }) => bucketOf(heading) !== undefined);
  if (!anyMatched) {
    const whole = body.trim();
    return whole ? { decision: whole } : {};
  }
  const out = {};
  for (let n = 0; n < idx.length; n++) {
    const { line, heading } = idx[n];
    const end = idx[n + 1]?.line ?? lines.length;
    const content = lines.slice(line + 1, end).join('\n').trim();
    if (!content) continue;
    const bucket = bucketOf(heading);
    if (bucket) {
      out[bucket] = out[bucket] ? `${out[bucket]}\n\n${content}` : content;
    } else {
      const labeled = `${heading}: ${content}`;
      out.context = out.context ? `${out.context}\n\n${labeled}` : labeled;
    }
  }
  return out;
}

function clipWords(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, Math.max(0, n - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trim()}\u2026`;
}

/** Named sections, Decision first (never truncated while Context/Consequences still have budget to give up
 * -- "never mid-Decision"), within `budget` characters total. '' when there is nothing to say. Exported for
 * the TS/JS parity test (P2). */
export function formatSectionsText(s, budget) {
  const order = [['Decision', s.decision], ['Context/Rationale', s.context], ['Consequences', s.consequences]].filter(([, v]) => v);
  if (!order.length) return '';
  const parts = [];
  let remaining = budget;
  for (const [label, text] of order) {
    if (remaining <= 0) {
      parts.push(`(${label} omitted: budget exhausted)`);
      continue;
    }
    const line = `${label}: ${text}`;
    if (line.length <= remaining) {
      parts.push(line);
      remaining -= line.length + 2;
    } else {
      const keep = Math.max(0, remaining - `${label}: `.length);
      parts.push(`${label}: ${clipWords(text, keep)}`);
      remaining = 0;
    }
  }
  return parts.join('\n\n');
}

/** T50 (core-audit agent-surfaces.md rank 5, Cursor rules "description-matched" tier): a decision with no file/folder
 * scope anchor at all never surfaced via SessionStart or PreToolUse before this -- governingDecisions() only matched
 * literal scope paths. Mole stays model-free at hook time (R6), so instead of Cursor's semantic description match this
 * is the audit's own narrower, deterministic, opt-in fallback: a decision whose `scope:` list contains the literal
 * item `repo-wide` governs every file. Capped separately (REPO_WIDE_CAP) so a repo with many repo-wide decisions can't
 * crowd out the file-scoped ones a PreToolUse/SessionStart call is actually about.
 * */
export const REPO_WIDE_CAP = 5;

// T64: Okapi BM25 mirrored from packages/decisions/src/route/bm25.ts (T53) -- same stopwords, tokenizer, k1/b and idf,
// kept dependency-free here like sectionsOfText; test/route-by-meaning.test.ts fails on any score difference.
const BM25_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'this', 'that', 'with', 'as',
  'by', 'at', 'from', 'it', 'its', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'so', 'if', 'than', 'then',
]);
export function bm25Tokenize(text) {
  const spaced = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[/\\._\-:#"'`(),;{}[\]<>=+*!?@%^&|~$]+/g, ' ');
  return spaced.toLowerCase().split(/\s+/).filter((t) => t.length >= 2 && !BM25_STOPWORDS.has(t) && /[a-z]/.test(t));
}
/** [{id, text}] scored against `query`; hits with score > 0, best first (stable for ties: input order). */
export function bm25Rank(docs, query, k1 = 1.2, b = 0.75) {
  if (!docs.length) return [];
  const parsed = docs.map((d) => {
    const tokens = bm25Tokenize(d.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: d.id, tf, len: tokens.length };
  });
  const df = new Map();
  let total = 0;
  for (const p of parsed) {
    total += p.len;
    for (const t of p.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = parsed.length;
  const avg = total / n || 1;
  const idf = (t) => Math.log((n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5) + 1);
  const q = new Set(bm25Tokenize(query));
  const hits = parsed.map((p) => {
    let score = 0;
    for (const t of q) {
      const f = p.tf.get(t) ?? 0;
      if (f === 0) continue;
      score += (idf(t) * (f * (k1 + 1))) / (f + k1 * (1 - b + b * (p.len / avg)));
    }
    return { id: p.id, score };
  });
  return hits.sort((x, y) => y.score - x.score).filter((h) => h.score > 0);
}

/** T50: a decision's own evidence (.mole/decisions/*.md `evidence:` list) -- the same guard-test fact the Stop hook's
 * line-level `mole check` finds post-edit, but read straight from the record so PreToolUse (pre-edit, no diff exists
 * yet to blame) can name it too. kind: 'test' pairs = test file + optional #title (the YAML value after the colon,
 * e.g. 'packages/daemon/test/daemon.test.ts#idle shutdown (T9)'); kind: 'incident' = an incident record slug. */
function parseEvidenceBlock(text) {
  const block = /^evidence:\n((?:\s+-.*\n)+)/m.exec(text);
  const out = [];
  if (!block) return out;
  for (const line of block[1].split('\n')) {
    const item = line.trim().replace(/^-\s*/, '');
    if (!item) continue;
    const test = /^test:\s*(.+)$/.exec(item);
    const incident = /^incident:\s*(.+)$/.exec(item);
    const strip = (s) => s.trim().replace(/^['"]|['"]$/g, '');
    if (test) out.push({ kind: 'test', value: strip(test[1]) });
    else if (incident) out.push({ kind: 'incident', value: strip(incident[1]) });
  }
  return out;
}

/** .mole/decisions/*.md, parsed by hand: id, title, status, approver, scope file list (symbol/folder tail dropped),
 * plus (T43) its full rationale text, named by section and bounded by RATIONALE_BUDGET_PER_DECISION, plus (T50) its
 * raw scope anchor targets (file#Symbol, never just the file part), a repo-wide flag, and its evidence (guard tests). */
export function readDecisionRecords(root) {
  const dir = join(root, '.mole', 'decisions');
  const out = [];
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const id = parseFrontMatterField(text, 'id');
    if (!id) continue;
    const scopeBlock = /^scope:\n((?:\s+-.*\n)+)/m.exec(text);
    // T64: the inline form `scope: [a, b]` (accepted by the graph loader) was ignored here; read it as the same list
    const inlineScope = /^scope:[ \t]*\[(.*)\][ \t]*$/m.exec(text); // review 1 F2: nested [..] flattened below
    const files = new Set();
    const scopeTargets = []; // T50: full raw anchor (file#Symbol or folder/), for display -- `files` above keeps only the file part for matching
    let repoWide = false; // T50
    const scopeItems = scopeBlock ? scopeBlock[1].split('\n') : inlineScope ? inlineScope[1].replace(/[[\]]/g, '').split(',') : [];
    if (scopeItems.length) {
      for (const line of scopeItems) {
        const item = line.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '');
        if (!item) continue;
        if (item.toLowerCase() === 'repo-wide') {
          repoWide = true;
          continue;
        }
        files.add(item.split('#')[0]);
        scopeTargets.push(item);
      }
    }
    out.push({
      id,
      title: parseFrontMatterField(text, 'title') ?? id,
      status: parseFrontMatterField(text, 'status') ?? 'unknown',
      approver: parseFrontMatterField(text, 'approver'),
      file: `.mole/decisions/${name}`,
      files, // repo-relative paths (folder targets keep their trailing '/')
      scopeTargets, // T50: raw anchors, for "which exact symbol/file this governs" in the PreToolUse text
      repoWide, // T50: `scope:` contained the literal item `repo-wide`
      unscoped: files.size === 0 && !repoWide, // T64: no scope at all -- surfaced only by meaning, never by file
      evidence: parseEvidenceBlock(text), // T50: guard tests / incidents this decision itself cites
      rationale: formatSectionsText(sectionsOfText(text), RATIONALE_BUDGET_PER_DECISION), // T43, '' when none
    });
  }
  return out;
}

/** A decision's scope file matches a changed file: exact path, or the changed file sits under a scope folder ('dir/'). */
function scopeMatches(scopeFile, changed) {
  if (scopeFile === changed) return true;
  if (scopeFile.endsWith('/')) return changed === scopeFile.slice(0, -1) || changed.startsWith(scopeFile);
  return false;
}

/** Decisions (hand-parsed, see readDecisionRecords) whose scope covers any of `files`, PLUS (T50) at most
 * REPO_WIDE_CAP decisions tagged `scope: - repo-wide` (the file-scope fallback, rank 5) -- those are added
 * regardless of `files` and capped on their own so they can't crowd out the file-scoped matches a caller asked
 * about. Each returned decision carries `matchedTargets`: the specific scope anchor(s) that matched (or
 * `['repo-wide']`), so the hook text can say WHICH symbol/file governs, not just the decision's title.
 * `liveFlags: true` enriches each with its CURRENT citator flag via `mole decisions --json` (tenet-3 / decision
 * 0013: heavy work stays out of the fast path -- `mole decisions --json` walks git history for every scope anchor
 * and can take seconds on a repo with a long history, so SessionStart and PreToolUse (M31a's p95 <= 2 s budget) use
 * the record's own `status` as a fast, honest proxy for the flag instead; Stop, which has no such budget, asks for
 * the live flag so drift is visible there). */
export function governingDecisions(mole, root, files, { liveFlags = false, text } = {}) {
  const all = readDecisionRecords(root);
  const fileMatched = all
    .filter((d) => [...d.files].some((f) => [...files].some((c) => scopeMatches(f, c))))
    .map((d) => ({ ...d, matchedTargets: d.scopeTargets.filter((t) => [...files].some((c) => scopeMatches(t.split('#')[0], c))) }));
  const fileMatchedIds = new Set(fileMatched.map((d) => d.id));
  // T50 rank 5: literal repo-wide fallback, capped independently of the file-scoped matches -- unchanged by T64
  // (review 1 F1: ranking these by meaning dropped a repo-wide rule whose words the edit did not share)
  const repoWide = all
    .filter((d) => d.repoWide && !fileMatchedIds.has(d.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, REPO_WIDE_CAP)
    .map((d) => ({ ...d, matchedTargets: ['repo-wide'] }));
  // T64: decisions with NO scope at all, ranked by meaning against the text of the moment (prompt, or the edited path +
  // new text): BM25 over title + rationale, score > 0, best REPO_WIDE_CAP. Zero model calls. A guess, labelled as one.
  let byMeaning = [];
  if (text && String(text).trim()) {
    const pool = all.filter((d) => d.unscoped && !fileMatchedIds.has(d.id));
    const byId = new Map(pool.map((d) => [d.id, d]));
    byMeaning = bm25Rank(pool.map((d) => ({ id: d.id, text: `${d.title}\n${d.rationale}` })), text)
      .slice(0, REPO_WIDE_CAP)
      .map((h) => ({ ...byId.get(h.id), matchedTargets: ['by meaning'], score: h.score }));
  }
  const records = [...fileMatched, ...byMeaning, ...repoWide];
  if (records.length === 0) return [];
  let flags = new Map();
  if (liveFlags && mole) {
    const r = moleJson(mole, root, ['decisions', '--json'], 15_000);
    if (r && Array.isArray(r.decisions)) flags = new Map(r.decisions.map((d) => [d.id, d.flag]));
  }
  // file-scoped matches first (by id), then the by-meaning ones in rank order (T64), then literal repo-wide (by id)
  const rank = (d) => (d.matchedTargets?.includes('by meaning') ? 1 : d.matchedTargets?.includes('repo-wide') ? 2 : 0);
  return records.map((d) => ({ ...d, flag: flags.get(d.id) })).sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (b.score ?? 0) - (a.score ?? 0) : a.id.localeCompare(b.id)));
}

/** One rule line per decision (M31a: "each as a rule to follow with its flag and owner"), clipped to SCOPE_BUDGET
 * chars; then (T43) each decision that made the cut gets its own full-rationale block appended, named by section
 * (Decision/Context-Rationale/Consequences) and bounded by RATIONALE_BUDGET_PER_DECISION each -- never mid-Decision,
 * and never replacing the one-liner summary above it (done-when 2: the compact line still always comes through).
 * The rationale blocks together are ALSO capped by RATIONALE_AGGREGATE_BUDGET (P1 review fix): once that budget is
 * spent, remaining decisions keep their one-liner in the list above but their rationale block is dropped WHOLE
 * (never clipped mid-block) with a trailing pointer naming how many and where to get the rest -- so the hook
 * scripts' outer clip() never has to cut inside a kept block. */
export function decisionsBlock(decisions, header = 'Mole decisions governing the files in play') {
  if (!decisions.length) return '';
  // T50 (core-audit rank 1, M-C v2's B3 case): the rule line now also names WHICH exact anchor governs (not just the
  // decision's title/file) and its guard test(s) straight from the record's own `evidence:` -- the specificity the
  // Stop hook's post-edit `mole check` has (line + guarding test), surfaced here pre-edit instead.
  const lines = decisions.map((d) => {
    const covers = (d.matchedTargets ?? []).filter((t) => t !== 'repo-wide' && t !== 'by meaning');
    const coversPart = covers.length ? ` \u2014 covers: ${covers.join(', ')}` : '';
    const tests = (d.evidence ?? []).filter((e) => e.kind === 'test').map((e) => e.value);
    const guardPart = tests.length ? ` \u2014 guard test: ${tests.join('; ')}` : '';
    // review 1 F3: a BM25 guess must not read as a governing rule
    const guessPart = (d.matchedTargets ?? []).includes('by meaning') ? ' \u2014 matched by words, not by file: check it applies' : '';
    return `- ${d.id} [${d.flag ?? d.status}] ${d.status} \u2014 ${d.title} \u2014 owner: ${d.approver ?? 'unassigned'} (${d.file})${coversPart}${guardPart}${guessPart}`;
  });
  let kept = decisions;
  let out = `${header} (${decisions.length}):\n${lines.join('\n')}`;
  if (out.length > SCOPE_BUDGET) {
    // keep as many whole rule lines as fit, then say how many were cut (never truncate a line mid-decision)
    const head = `${header} (${decisions.length}):`;
    const keptLines = [];
    kept = [];
    let len = head.length;
    for (let i = 0; i < lines.length; i++) {
      if (len + 1 + lines[i].length > SCOPE_BUDGET - 24) break;
      keptLines.push(lines[i]);
      kept.push(decisions[i]);
      len += 1 + lines[i].length;
    }
    const cut = lines.length - keptLines.length;
    out = `${head}\n${keptLines.join('\n')}${cut > 0 ? `\n(${cut} more: mole decisions --json)` : ''}`;
  }
  const candidates = kept.filter((d) => d.rationale);
  const rationaleBlocks = [];
  let used = 0;
  let dropped = 0;
  for (const d of candidates) {
    const block = `why ${d.id}:\n${d.rationale}`;
    if (used + block.length + 2 <= RATIONALE_AGGREGATE_BUDGET) {
      rationaleBlocks.push(block);
      used += block.length + 2;
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    rationaleBlocks.push(
      `(${dropped} more rationale block${dropped === 1 ? '' : 's'} omitted (aggregate rationale budget ${RATIONALE_AGGREGATE_BUDGET} chars): ` +
        `their one-line summary is still in the list above -- run \`mole decisions --json\` or the MCP mole_decisions tool for the full text)`,
    );
  }
  return rationaleBlocks.length ? `${out}\n\n${rationaleBlocks.join('\n\n')}` : out;
}

/** Decisions touched by a diff's files, with their CURRENT flag (Stop: "decisions the session's diff touched"). */
export function decisionsDiffText(mole, root, files) {
  const list = governingDecisions(mole, root, files, { liveFlags: true });
  if (!list.length) return '';
  return decisionsBlock(list, 'mole: decisions this session touched');
}

/** T35 weak spots (packages/coverage, `mole coverage --weak --json`) for the files in play, when that task has landed
 * on main; 'not available yet' otherwise (T35 may still be running). Only called when there is a decisions block to
 * attach it to, so a repo with nothing to say about decisions also says nothing about weak spots. Checks the package
 * exists before spawning the CLI: `mole coverage` isn't a real subcommand until T35 lands, and a spawn-and-fail per
 * session would cost ~300-500 ms it doesn't need to (M31a's p95 budget). */
export function weakSpotsLine(mole, root, files) {
  if (!mole || !existsSync(join(root, 'packages', 'coverage'))) return '(weak spots from T35: not available yet)';
  const r = moleJson(mole, root, ['coverage', '--weak', '--json'], 5_000);
  if (!r || !Array.isArray(r.files)) return '(weak spots from T35: not available yet)';
  const set = new Set(files);
  const hits = r.files.filter((f) => set.has(f.file) && f.weak?.is);
  if (!hits.length) return '';
  const reasons = hits.flatMap((f) => (f.weak.reasons ?? []).map((why) => `${f.file}: ${why}`));
  return `weak spots (T35, no guarding test / no recent human read / governed by a red-yellow decision):\n${reasons.slice(0, 5).map((l) => `- ${l}`).join('\n')}`;
}

/** T27/T92: raw `mole rules --json` result; undefined on any failure or when no CLI is found. `mole rules`
 * intentionally exits 1 when it finds a violation (packages/decisions/src/rules/cli.ts), so this calls the CLI
 * directly and reads stdout on BOTH exit 0 and exit 1 -- moleJson() in this file treats any non-zero exit as a
 * failure and would silently drop every real violation otherwise. */
export function rulesJson(mole, root) {
  if (!mole) return undefined;
  let out;
  try {
    out = execFileSync(mole[0], [...mole[1], 'rules', '--json', '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = typeof e.stdout === 'string' ? e.stdout : undefined; // exit 1 (violations found) still has valid JSON on stdout
  }
  try {
    return out ? JSON.parse(out) : undefined;
  } catch {
    return undefined;
  }
}

/** T92: crisp (zero-model, deterministic: TS AST + dependency-cruiser, packages/decisions/src/rules) rule
 * violations among `files`, raw -- each citing its decision id/title/why and the rule's kind/target/file/line.
 * Shared by the Stop hook (block on the session's diff) and PreToolUse (deny a prospective edit): both need the
 * SAME crisp signal, never the by-meaning/judged ones (those stay advisory, see verify.mjs). [] on a repo with no
 * decisions dir, no CLI, or no violations in `files` -- never throws. */
export function crispViolations(mole, root, files) {
  if (!mole || !existsSync(join(root, '.mole', 'decisions'))) return [];
  const r = rulesJson(mole, root);
  if (!r || !Array.isArray(r.violations) || !r.violations.length) return [];
  const set = new Set(files);
  return r.violations.filter((v) => set.has(v.file));
}

/** T92: a one-line, actionable fix for a crisp violation -- the decision's own authored `why` (the team's own
 * words on why the rule exists) when the record has one, else a generic action naming the exact import/call to
 * remove, grounded in the violation's own fields (never invented). */
export function ruleFixHint(v) {
  if (v.decision?.why) return v.decision.why;
  return v.kind === 'import' ? `remove the import of ${v.target}` : `remove the call to ${v.target}`;
}

/** T27 rule violations (`mole rules --json`) whose file is among `files`, each citing its decision id. '' when none,
 * silent on a clean diff (M31b) and on a repo with no rules (checkRules returns 0 rules, 0 violations). */
export function ruleViolationsText(mole, root, files) {
  const hits = crispViolations(mole, root, files);
  if (!hits.length) return '';
  const lines = hits.map((v) => `- ${v.file}:${v.line} ${v.kind} ${v.target} breaks ${v.decision.id} "${v.decision.title}"${v.decision.flag ? ` (${v.decision.flag})` : ''}${v.decision.why ? ` \u2014 ${v.decision.why}` : ''}`);
  return `mole: decision-rule violations in this session's diff (${hits.length}, T27 \`mole rules\`):\n${lines.join('\n')}`;
}

/** T92: does this repo have at least one `rules:` block anywhere in .mole/decisions? A cheap text scan (no YAML
 * parse, no subprocess) so PreToolUse's crisp-deny check can skip the `mole rules` subprocess entirely on the
 * (common) repo with no rules at all -- the fast path M31a's p95 budget needs. */
export function hasAnyRules(root) {
  const dir = join(root, '.mole', 'decisions');
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      if (/^rules\s*:/m.test(readFileSync(join(dir, name), 'utf8'))) return true;
    } catch {
      // unreadable record: not a rules source, keep scanning the rest
    }
  }
  return false;
}

// ---------------------------------------------------------------- T92 review-1 fix: never write the real file
/**
 * Review 1 (HIGH 1): crispDenyReason used to write the prospective content onto the REAL working-tree path,
 * run `mole rules`, then restore the original bytes in a `finally` -- a SIGKILL (or any crash) between the
 * write and the restore left the user's file permanently holding an edit that was never applied (reproduced
 * live, 4 log/t92-review-1.md: killedAt 956ms). The fix is to never open the real path for writing at all.
 * This mirrors two well-known prior-art patterns for "check content without touching the file": eslint's own
 * `--stdin --stdin-filename <path>` (https://eslint.org/docs/latest/use/command-line-interface#--stdin,
 * fetched 2026-11-04 -- pipe the candidate content in, lint it as if it were at that path, never write
 * anything), and dependency-cruiser's documented pattern of running its checks against a throwaway copy of a
 * tree rather than the tree being edited (https://github.com/sverweij/dependency-cruiser/blob/main/doc/
 * cli.md#programmatic-use, fetched 2026-11-04). Since dependency-cruiser (import rules) and our own TS-AST
 * scan (call rules) both need real files on disk to resolve a module graph against (there is no "pass content
 * as a string" API for either that also replays the *surrounding* repo's imports), the safe equivalent is a
 * throwaway overlay directory that mirrors the repo with symlinks and holds ONLY the file(s) under test as
 * real bytes -- buildOverlay() below. The real working tree is never opened O_WRONLY; a kill at any point
 * leaves nothing behind but an orphaned temp directory (best-effort removed, and OS-temp-cleaned regardless).
 */

/**
 * A throwaway directory at the same relative shape as `root`, built entirely from symlinks, except the paths
 * named in `overrides` (Map<relPath, content|undefined>) which become REAL files holding `content` -- or are
 * left absent entirely when `content` is undefined (simulates "this file does not exist in this snapshot").
 * Only directories on the path to an override are ever created for real; every sibling is one symlink (cheap:
 * no tree copy, however large the repo). `root` itself is never opened for writing. Returns the overlay root
 * and a `cleanup()` that best-effort removes it (never throws).
 */
export function buildOverlay(root, overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'mole-overlay-'));
  const needed = new Set(['']);
  for (const rel of overrides.keys()) {
    const parts = rel.split('/');
    let p = '';
    for (let i = 0; i < parts.length - 1; i++) {
      p = p ? `${p}/${parts[i]}` : parts[i];
      needed.add(p);
    }
  }
  const mirror = (relDir) => {
    const srcDir = relDir ? join(root, relDir) : root;
    const dstDir = relDir ? join(dir, relDir) : dir;
    mkdirSync(dstDir, { recursive: true });
    let entries = [];
    try {
      entries = readdirSync(srcDir, { withFileTypes: true });
    } catch {
      entries = []; // srcDir doesn't exist in the real tree (e.g. a brand-new nested path): nothing to mirror
    }
    for (const e of entries) {
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (needed.has(childRel)) {
        mirror(childRel);
        continue;
      }
      if (overrides.has(childRel)) continue; // an override target: handled below, real content or absent
      try {
        symlinkSync(join(srcDir, e.name), join(dstDir, e.name));
      } catch {
        // a name collision or unreadable entry: skip it, never throw out of a hook
      }
    }
  };
  mirror('');
  for (const [rel, content] of overrides) {
    if (content === undefined) continue; // absent in this snapshot: leave the hole, never fall back to the real file
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort: an orphaned temp dir is cleaned by the OS eventually, never fail the hook over it
      }
    },
  };
}

/** `${decision id}::${rule}::${file}::${target}` -- a violation's identity independent of its line number, so an
 * unrelated edit elsewhere in the file (which can shift line numbers) never makes an old violation look "new"
 * (T92 review-1 HIGH 2). Shared by PreToolUse's before/after diff and Stop's session-baseline/now diff. */
export function violationKey(v) {
  return `${v.decision?.id}::${v.rule}::${v.file}::${v.target}`;
}

/** A hash of every rules-bearing decision record's own text (name + content), so the rules-result cache below
 * is invalidated the moment a decision's `rules:` block changes -- never served stale just because a file's
 * content hash happened to repeat. Cheap (same files hasAnyRules already scans; no subprocess). */
export function rulesFingerprint(root) {
  const dir = join(root, '.mole', 'decisions');
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return '';
  }
  const h = createHash('sha256');
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    if (/^rules\s*:/m.test(text)) h.update(name).update('\u0000').update(text).update('\u0000');
  }
  return h.digest('hex');
}

function rulesCacheDir() {
  return join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'mole-claude-code'), 'rules-cache');
}

/** T92 review-1 LOW: a (rulesFingerprint, rel path, content) -> violations[] cache so re-checking content this
 * process (or an earlier edit in the same session) already checked never re-spawns `mole rules`. Written
 * atomically (temp file + rename) so two concurrent hook processes writing the same key can never corrupt it
 * (one wins, both wrote identical bytes anyway since the key already encodes the exact content). */
function rulesCacheGet(key) {
  try {
    return JSON.parse(readFileSync(join(rulesCacheDir(), `${key}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

function rulesCacheSet(key, violations) {
  try {
    const dir = rulesCacheDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    writeFileSync(tmp, JSON.stringify(violations));
    renameSync(tmp, join(dir, `${key}.json`));
    pruneRulesCache(dir);
  } catch {
    // best effort: a cache miss next time just costs one more `mole rules` call, never a crash
  }
}

const RULES_CACHE_CAP = 500;
function pruneRulesCache(dir) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length <= RULES_CACHE_CAP) return;
    const withTime = files.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }));
    withTime.sort((a, b) => a.t - b.t);
    for (const { f } of withTime.slice(0, withTime.length - RULES_CACHE_CAP)) rmSync(join(dir, f), { force: true });
  } catch {
    // pruning is housekeeping, never a hook failure
  }
}

/** T92 review-1 HIGH 1 + LOW: crisp violations `rel` would have if its content were exactly `content`, computed
 * on a throwaway overlay (buildOverlay) -- the real path at `root`/`rel` is never opened for writing. `content
 * === undefined` means "this file does not exist in this snapshot" (a brand-new file's `before` state): no
 * violations are possible for a file that isn't there. Cached per (rulesFingerprint, rel, content) so the SAME
 * content (e.g. the previous edit's `after` becoming this edit's `before`) only ever runs `mole rules` once. */
export function crispViolationsForContent(mole, root, rel, content) {
  if (content === undefined) return [];
  const key = createHash('sha256').update(rulesFingerprint(root)).update('\u0000').update(rel).update('\u0000').update(content).digest('hex');
  const cached = rulesCacheGet(key);
  if (cached !== undefined) return cached;
  const { dir, cleanup } = buildOverlay(root, new Map([[rel, content]]));
  let violations = [];
  try {
    violations = crispViolations(mole, dir, [rel]);
  } finally {
    cleanup();
  }
  rulesCacheSet(key, violations);
  return violations;
}

/** T92 review-1 HIGH 2: crisp violations for exactly the files named in `overrides` (Map<rel, content |
 * undefined>), evaluated on a throwaway overlay holding that recorded content instead of the real file(s) --
 * Stop's session-baseline check (what the files looked like before this session touched them), never a git
 * checkout (which would disturb the real working tree mid-session). Not cached: baseline combinations are
 * session-specific and rarely repeat, unlike PreToolUse's single-file before/after. */
export function crispViolationsForOverlay(mole, root, overrides) {
  const { dir, cleanup } = buildOverlay(root, overrides);
  try {
    return crispViolations(mole, dir, [...overrides.keys()]);
  } finally {
    cleanup();
  }
}

/** T92 review-1 HIGH 2: the content `file` had BEFORE this session touched it -- never by checking out. If the
 * file was already dirty at SessionStart, session-start.mjs recorded its exact bytes as a git blob
 * (`git hash-object -w`, which writes to .git/objects only, never the working tree or the index) in
 * `sess.baselineBlobs[file]`; otherwise the file's content at `sess.head` (or current HEAD, for a session that
 * never got a SessionStart record) is the baseline. undefined means the file did not exist at the baseline
 * (e.g. the session itself created it) -- not an error. */
export function sessionBaselineContent(root, sess, file) {
  if (sess?.baselineBlobs && Object.prototype.hasOwnProperty.call(sess.baselineBlobs, file)) {
    return git(root, ['cat-file', '-p', sess.baselineBlobs[file]]);
  }
  const head = sess?.head || git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim();
  if (!head) return undefined;
  return git(root, ['cat-file', '-p', `${head}:${file}`]);
}

/** PreToolUse: decisions already added as context this session, so each is added at most once (never a second time, never a block). */
function addedDecisionsFile(sessionId) {
  return join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'mole-claude-code'), 'sessions', `${String(sessionId || 'unknown').replace(/[^\w.-]/g, '_')}.decisions.json`);
}

export function loadAddedDecisions(sessionId) {
  try {
    const f = addedDecisionsFile(sessionId);
    return existsSync(f) ? new Set(JSON.parse(readFileSync(f, 'utf8'))) : new Set();
  } catch {
    return new Set();
  }
}

export function saveAddedDecisions(sessionId, set) {
  try {
    const f = addedDecisionsFile(sessionId);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...set]));
  } catch {
    // best effort: a decision may be re-added once more next call, never a crash
  }
}

// ---------------------------------------------------------------- T74: steering dials (signal / update / query)
/**
 * The per-session steer inbox path, duplicated from packages/agentstate/src/steer/store.ts's `inboxFile` on
 * purpose (same reasoning as this file's own duplicated decision parsing: a hook stays dependency-free of
 * @mole/agentstate's TypeScript build, it only ever shells out to the CLI). Kept in sync by
 * packages/agentstate/test/steer.test.ts asserting the real inboxFile() lands at this same path shape.
 */
function steerInboxFile(root, sessionId) {
  return join(root, '.mole', 'local', 'steer', `${String(sessionId || 'unknown').replace(/[^\w.-]/g, '_')}.json`);
}

/**
 * Review 1 (HIGH 2): this used to call `mole steer deliver` (a subprocess spawn, measured +60-80ms) on EVERY
 * Edit|Write call even when the session's inbox was empty or fully delivered already. Before spawning anything, do
 * the cheap in-process check the CLI itself would otherwise have done: no inbox file at all (existsSync, no
 * subprocess) or an inbox with nothing undelivered (one readFileSync + JSON.parse, still no subprocess) both
 * short-circuit to '' without ever touching execFileSync. Only an inbox with real pending signals/updates pays for
 * the CLI call (which also performs the atomic claim -- see packages/agentstate/src/steer/store.ts). Timed proof
 * kept in this task's own internal log ("Review 1: HIGH 2 latency").
 */
function hasPendingSteer(root, sessionId) {
  const f = steerInboxFile(root, sessionId);
  if (!existsSync(f)) return false;
  try {
    const inbox = JSON.parse(readFileSync(f, 'utf8'));
    return (inbox.signals ?? []).some((s) => !s.delivered) || (inbox.updates ?? []).some((u) => u.accepted && !u.delivered);
  } catch {
    return true; // unreadable/corrupt: let the real CLI (same failure tolerance as readInbox) decide, never guess empty
  }
}

/**
 * PreToolUse/UserPromptSubmit: pending steering signals + accepted updates for this session, delivered exactly once
 * (`mole steer deliver`, @mole/agentstate's steer/ -- the per-session inbox lives under .mole/local/steer/, never
 * CLAUDE_PLUGIN_DATA, so it works the same whether a human or another agent sent the signal). '' when nothing is
 * pending, on any CLI failure, or on a repo with no mole CLI: delivery never blocks or fails the session (T74 stop
 * condition). A short budget (default 10s, well under the hooks' own 15/30s timeouts) so a stuck daemon-less CLI
 * call can't eat the hook's whole timeout.
 */
export function steerDeliverText(mole, root, sessionId, timeoutMs = 10_000) {
  if (!mole || !sessionId) return '';
  if (!hasPendingSteer(root, sessionId)) return ''; // HIGH 2 fix: never spawn the CLI for an empty/fully-delivered inbox
  const r = moleJson(mole, root, ['steer', 'deliver', '--session', String(sessionId), '--json'], timeoutMs);
  if (!r || (!r.signals?.length && !r.updates?.length)) return '';
  const lines = [
    ...(r.signals ?? []).map((s) => `- signal${s.from ? ` (from ${s.from})` : ''}: ${s.text}`),
    ...(r.updates ?? []).map((u) => `- update (${u.kind}${u.target ? ` ${u.target}` : ''})${u.from ? ` (from ${u.from})` : ''}: ${u.text}`),
  ];
  return `mole: steering for this session (mole steer, delivered once):\n${lines.join('\n')}`;
}
