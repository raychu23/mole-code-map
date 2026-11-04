// L1 (T13): what you looked at (.mole/local/seen.jsonl, never committed) and what changed in it since your last look.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeSymbol } from './index.js';
import { dirTree, gitTree, reanchor, type SourceTree } from './reanchor.js';
import { relPath, sourceFiles, symbolsInFile, symbolsOfText } from './symbols.js';

export const SEEN_LOG = '.mole/local/seen.jsonl';
const LOCAL_DIR = '.mole/local';

export type SeenHow = 'visible' | 'hover' | 'note';
const HOWS: readonly string[] = ['visible', 'hover', 'note'];

/** One line of .mole/local/seen.jsonl. */
export interface SeenEvent {
  time: string; // ISO
  symbol: string; // qualifiedName 'path#Tail'
  path: string;
  hash: string; // normalized-body hash at the time of looking
  how: SeenHow;
  commit: string; // HEAD sha at the time of looking ('' outside git or before the first commit)
}

/** What a recorder hands to appendSeen: text = the editor buffer when it differs from disk (else the file is read). */
export interface SeenInput {
  path: string;
  tail: string;
  how: SeenHow;
  time?: string;
  text?: string;
}

export interface SinceChange {
  commit: string; // full sha, or 'uncommitted' for working-tree edits
  author: string;
  email?: string;
  date: string; // ISO
  agent?: string; // Co-authored-by trailer name(s), ', '-joined
  subject: string;
}

export interface SinceEntry {
  symbol: string;
  path: string;
  status: 'changed' | 'deleted' | 'renamed' | 'renamed+changed';
  newPath?: string; // the symbol moved to another file (and changed), or was renamed into another file
  renamedTo?: string; // T19: 'renamed' (only the name changed) / 'renamed+changed': the symbol's qualifiedName now
  candidates?: string[]; // 'deleted' only: an ambiguous rename's equal candidates (never guessed)
  line?: number; // current 1-based start line
  seen: SeenEvent;
  changes: SinceChange[]; // newest first
}

export interface SinceFile {
  path: string;
  symbols: SinceEntry[]; // newest change first
}

export interface SinceResult {
  seenLog: string;
  nothingSeen: boolean;
  seenCount: number; // distinct symbols with a seen event
  files: SinceFile[]; // file with the newest change first
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, '-c', 'log.showSignature=false', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

const headOf = (root: string): string => git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '';

/** Record looks. Symbols that do not exist (in `text`, else on disk) are skipped; returns the events written. */
export function appendSeen(root: string, inputs: SeenInput[]): SeenEvent[] {
  const commit = headOf(root);
  const out: SeenEvent[] = [];
  const parsed = new Map<string, CodeSymbol[]>();
  for (const i of inputs) {
    if (!i || typeof i.path !== 'string' || typeof i.tail !== 'string' || !HOWS.includes(i.how)) continue;
    const path = relPath(root, i.path);
    const key = `${path}\0${i.text ?? ''}\0${i.text === undefined}`;
    let syms = parsed.get(key);
    if (!syms) {
      syms = i.text !== undefined ? symbolsOfText(path, i.text) : symbolsInFile(root, path);
      parsed.set(key, syms);
    }
    const sym = syms.find((s) => s.tail === i.tail);
    if (!sym) continue;
    out.push({ time: i.time ?? new Date().toISOString(), symbol: sym.qualifiedName, path, hash: sym.hash, how: i.how, commit });
  }
  if (out.length === 0) return out;
  const dir = join(root, LOCAL_DIR);
  mkdirSync(dir, { recursive: true });
  // the folder is private to this machine even in a repo whose .gitignore does not list it
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '# Mole: personal, never committed\n*\n');
  appendFileSync(join(root, SEEN_LOG), out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return out;
}

/** Every well-formed line of the seen log in file order; undefined when there is no log. Malformed lines are skipped. */
export function readSeen(root: string): SeenEvent[] | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, SEEN_LOG), 'utf8');
  } catch {
    return undefined;
  }
  const out: SeenEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<SeenEvent>;
      if (typeof e.symbol !== 'string' || typeof e.hash !== 'string' || !e.symbol.includes('#')) continue;
      const path = typeof e.path === 'string' && e.path ? e.path : e.symbol.slice(0, e.symbol.indexOf('#'));
      out.push({ time: String(e.time ?? ''), symbol: e.symbol, path, hash: e.hash, how: (HOWS.includes(String(e.how)) ? e.how : 'visible') as SeenHow, commit: String(e.commit ?? '') });
    } catch {
      // a torn last line (editor killed mid-write) must not hide the rest
    }
  }
  return out;
}

interface Commit {
  sha: string;
  parent: string;
  author: string;
  email: string;
  date: string;
  cdate: string;
  body: string;
}

const tailOf = (q: string) => q.slice(q.indexOf('#') + 1);

/** Co-authored-by trailer names ('Claude <x@y>' -> 'Claude'), ', '-joined. */
function agentOf(body: string): string | undefined {
  const names = [...body.matchAll(/^[ \t]*Co-authored-by:[ \t]*(.+?)[ \t]*$/gim)].map((m) => m[1]!.replace(/\s*<[^>]*>\s*$/, '').trim()).filter(Boolean);
  return names.length ? [...new Set(names)].join(', ') : undefined;
}

class History {
  private texts = new Map<string, CodeSymbol[] | undefined>();
  constructor(private readonly root: string) {}

  symbolsAt(rev: string, path: string): CodeSymbol[] | undefined {
    const k = `${rev}:${path}`;
    if (!this.texts.has(k)) {
      const text = rev ? git(this.root, ['show', `${rev}:${path}`]) : undefined;
      this.texts.set(k, text === undefined ? undefined : symbolsOfText(path, text));
    }
    return this.texts.get(k);
  }

  hashAt(rev: string, path: string, tail: string): string | undefined {
    return this.symbolsAt(rev, path)?.find((s) => s.tail === tail)?.hash;
  }

  /** Non-merge commits touching path after the look, oldest first. */
  commits(path: string, seen: SeenEvent): Commit[] {
    const ancestor = seen.commit !== '' && git(this.root, ['merge-base', '--is-ancestor', seen.commit, 'HEAD']) !== undefined;
    const range = ancestor ? `${seen.commit}..HEAD` : 'HEAD';
    const raw = git(this.root, ['log', '--no-merges', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%B%x1e', range, '--', path]);
    if (!raw) return [];
    const after = Date.parse(seen.time);
    return raw
      .split('\x1e')
      .map((r) => r.replace(/^\n/, ''))
      .filter((r) => r.includes('\x1f'))
      .map((r) => {
        const [sha = '', parents = '', author = '', email = '', date = '', cdate = '', body = ''] = r.split('\x1f');
        return { sha, parent: parents.split(' ')[0] ?? '', author, email, date, cdate, body: body.trim() };
      })
      .filter((c) => ancestor || !Number.isFinite(after) || Date.parse(c.cdate) > after);
  }
}

function userName(root: string): string {
  return git(root, ['config', 'user.name'])?.trim() || process.env.USER || process.env.USERNAME || 'you';
}

interface Where {
  sym?: CodeSymbol;
  same: boolean;
  renamed?: 'renamed' | 'renamed+changed';
  candidates?: string[];
}

/** Where the seen symbol is now: undefined = gone; same = moved or untouched with the seen body; renamed = re-anchored (T19). */
function locate(root: string, e: SeenEvent, repo: () => CodeSymbol[], now: () => SourceTree): Where {
  const tail = tailOf(e.symbol);
  const here = symbolsInFile(root, e.path).find((s) => s.tail === tail);
  if (here) return { sym: here, same: here.hash === e.hash };
  // T11's re-anchoring: same tail + same body elsewhere = moved, not changed; a renamed container keeps the member's last segment
  const elsewhere = repo().filter((s) => s.path !== e.path);
  const moved = elsewhere.find((s) => s.tail === tail && s.hash === e.hash);
  if (moved) return { sym: moved, same: true };
  const last = tail.slice(tail.lastIndexOf('.') + 1);
  const renamed = [...symbolsInFile(root, e.path), ...elsewhere].filter((s) => s.tail.slice(s.tail.lastIndexOf('.') + 1) === last && s.hash === e.hash);
  if (renamed.length === 1) return { sym: renamed[0], same: true };
  // T19: the name is gone: re-anchor from the tree at the look (same kind, body equal modulo its own name, or similar)
  if (!e.commit) return { same: false };
  const r = reanchor({ path: e.path, tail, kind: '', hash: e.hash }, gitTree(root, e.commit), now());
  if ((r.outcome === 'renamed' || r.outcome === 'renamed+changed') && r.to) {
    // 'renamed' only when the body is the one you looked at (a dirty-buffer look may differ from the commit's)
    return { sym: r.to, same: false, renamed: r.outcome === 'renamed' && r.from?.hash === e.hash ? 'renamed' : 'renamed+changed' };
  }
  if (r.outcome === 'ambiguous') return { same: false, candidates: (r.candidates ?? []).map((c) => c.qualifiedName) };
  return { same: false };
}

/** The symbols you saw whose normalized body changed after your last look, newest change first, grouped by file. */
export function since(root: string): SinceResult {
  const events = readSeen(root);
  if (!events || events.length === 0) return { seenLog: SEEN_LOG, nothingSeen: true, seenCount: 0, files: [] };
  const last = new Map<string, SeenEvent>();
  for (const e of events) last.set(e.symbol, e); // the later line is the newer look (append-only log)
  let repoSyms: CodeSymbol[] | undefined;
  const repo = () => (repoSyms ??= sourceFiles(root).flatMap((f) => symbolsInFile(root, f)));
  const hist = new History(root);
  const head = headOf(root);
  let tree: SourceTree | undefined;
  const now = () => (tree ??= dirTree(root));
  // seen history follows renames (T19): a look at the old name and a later look at the new name are one symbol; the latest wins
  const resolved = new Map<string, { e: SeenEvent; where: Where; order: number }>();
  let order = 0;
  for (const e of last.values()) {
    const where = locate(root, e, repo, now);
    const k = where.sym ? where.sym.qualifiedName : e.symbol;
    const prev = resolved.get(k);
    const t = Date.parse(e.time) || 0;
    if (!prev || t > (Date.parse(prev.e.time) || 0) || (t === (Date.parse(prev.e.time) || 0) && order > prev.order)) resolved.set(k, { e, where, order });
    order++;
  }
  const entries: Array<SinceEntry & { key: number }> = [];
  for (const { e, where } of resolved.values()) {
    if (where.same) continue;
    const tail = tailOf(e.symbol);
    // commits after the look that changed this symbol's normalized body; a commit that brings back the seen body is a look-equal state
    let changes: SinceChange[] = [];
    for (const c of hist.commits(e.path, e)) {
      const before = c.parent ? hist.hashAt(c.parent, e.path, tail) : undefined;
      const after = hist.hashAt(c.sha, e.path, tail);
      if (before === after) continue;
      if (after === e.hash) {
        changes = [];
        continue;
      }
      changes.push({ commit: c.sha, author: c.author, email: c.email, date: c.date, agent: agentOf(c.body), subject: c.body.split('\n')[0] ?? '' });
    }
    if (where.renamed && where.sym) {
      // commits that changed the renamed symbol after the rename (its new path + name), if any
      for (const c of hist.commits(where.sym.path, e)) {
        if (changes.some((x) => x.commit === c.sha)) continue;
        const before = c.parent ? hist.hashAt(c.parent, where.sym.path, where.sym.tail) : undefined;
        const after = hist.hashAt(c.sha, where.sym.path, where.sym.tail);
        if (before === undefined || before === after) continue;
        changes.push({ commit: c.sha, author: c.author, email: c.email, date: c.date, agent: agentOf(c.body), subject: c.body.split('\n')[0] ?? '' });
      }
      changes.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    }
    const atHead = head ? hist.hashAt(head, e.path, tail) : undefined;
    const nowHash = where.sym && where.sym.path === e.path && where.sym.tail === tail ? where.sym.hash : undefined;
    if (nowHash !== atHead) {
      let date = new Date().toISOString();
      try {
        date = statSync(join(root, e.path)).mtime.toISOString();
      } catch {
        // file deleted in the working tree
      }
      if (atHead === e.hash) changes = [];
      const subject = nowHash !== undefined ? 'uncommitted change in the working tree' : where.renamed ? 'renamed in the working tree' : 'removed in the working tree';
      changes.push({ commit: 'uncommitted', author: userName(root), date, subject });
    }
    changes.reverse(); // newest first
    const key = changes.length ? Math.max(...changes.map((c) => Date.parse(c.date) || 0)) : Date.parse(e.time) || 0;
    entries.push({
      symbol: e.symbol,
      path: e.path,
      status: where.renamed ?? (where.sym ? 'changed' : 'deleted'),
      ...(where.sym && where.sym.path !== e.path ? { newPath: where.sym.path } : {}),
      ...(where.renamed && where.sym ? { renamedTo: where.sym.qualifiedName } : {}),
      ...(where.candidates?.length ? { candidates: where.candidates } : {}),
      ...(where.sym ? { line: where.sym.startLine } : {}),
      seen: e,
      changes,
      key,
    });
  }
  entries.sort((a, b) => b.key - a.key || a.symbol.localeCompare(b.symbol));
  const files = new Map<string, SinceFile>();
  for (const { key: _k, ...s } of entries) {
    const f = files.get(s.path) ?? { path: s.path, symbols: [] };
    f.symbols.push(s);
    files.set(s.path, f);
  }
  return { seenLog: SEEN_LOG, nothingSeen: false, seenCount: last.size, files: [...files.values()] };
}

const day = (iso: string) => iso.slice(0, 10);
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function formatSince(r: SinceResult): string {
  if (r.nothingSeen)
    return [
      `mole since: nothing seen yet (no ${r.seenLog}).`,
      'To start: open TypeScript files in VS Code with the Mole extension; a symbol visible for 5 s or hovered is recorded',
      '(setting mole.recordSeen, on by default). Or record a look by hand: mole seen <file#Symbol>; mole note add also counts as a look.',
      `The log stays on this machine (${r.seenLog.slice(0, r.seenLog.lastIndexOf('/') + 1)} is gitignored).`,
    ].join('\n');
  const n = r.files.reduce((a, f) => a + f.symbols.length, 0);
  if (n === 0) return `mole since: nothing changed since you last looked (${r.seenCount} symbol${r.seenCount === 1 ? '' : 's'} seen)`;
  const out = [`mole since: ${n} of the ${r.seenCount} symbols you looked at changed after your last look (newest first)`];
  for (const f of r.files) {
    out.push('', f.path);
    for (const s of f.symbols) {
      const newTail = s.renamedTo ? s.renamedTo.slice(s.renamedTo.indexOf('#') + 1) : '';
      const oldTail = s.symbol.slice(s.symbol.indexOf('#') + 1);
      const what =
        s.status === 'renamed' || s.status === 'renamed+changed'
          ? `${s.status === 'renamed' ? 'renamed' : 'renamed + changed'}: ${oldTail} → ${newTail}${s.newPath ? ` (now in ${s.newPath})` : ''}`
          : s.status === 'deleted'
            ? `deleted since you looked${s.candidates?.length ? ` (ambiguous rename, not followed: ${s.candidates.join(', ')})` : ''}`
            : s.newPath
              ? `moved to ${s.newPath} and changed`
              : 'changed';
      out.push(`  ${s.symbol.slice(s.symbol.indexOf('#') + 1)}${s.line ? `:${s.line}` : ''}  ${what}  (you looked ${minute(s.seen.time)}, ${s.seen.how})`);
      for (const c of s.changes) {
        const sha = c.commit === 'uncommitted' ? 'uncommitted' : c.commit.slice(0, 7);
        out.push(`      ${sha.padEnd(11)} ${day(c.date)}  ${c.author}${c.agent ? `  agent ${c.agent}` : ''}  ${c.subject}`);
      }
      if (s.changes.length === 0) out.push('      (no commit found: changed outside the history this repo has)');
    }
  }
  return out.join('\n');
}
