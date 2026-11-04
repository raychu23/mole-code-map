// Scope anchors and evidence against the working tree and git: does each anchor still exist, did its code change since the
// approver's confirmed sha (normalized: whitespace + comments don't count), is each evidence test still there / passing.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { normalizedHash, symbolsInFile, symbolsOfText } from '@mole/memory';
import type { EvidenceRef } from './types.js';

const CODE = /\.(?:[mc]?[jt]sx?)$/;

/** Hash that ignores whitespace (and comments, for JS/TS). */
export function contentHash(path: string, text: string): string {
  return CODE.test(path) ? normalizedHash(text) : text.replace(/\s+/g, ' ').trim();
}

export class Git {
  readonly ok: boolean;
  private prefix = '';
  private verified = new Map<string, string | null>();
  private changed = new Map<string, Set<string> | null>();
  private shown = new Map<string, string | null>();

  constructor(readonly root: string) {
    const p = this.run(['rev-parse', '--show-prefix']);
    this.ok = p !== null;
    this.prefix = (p ?? '').trim();
  }

  private run(args: string[]): string | null {
    try {
      return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    } catch {
      return null;
    }
  }

  /** full sha of a commit-ish, or null when git does not know it */
  commit(rev: string): string | null {
    if (!this.ok) return null;
    if (!this.verified.has(rev)) this.verified.set(rev, this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])?.trim() || null);
    return this.verified.get(rev) ?? null;
  }

  /** root-relative paths of tracked files that differ between sha and the working tree */
  changedSince(sha: string): Set<string> | null {
    if (!this.changed.has(sha)) {
      const out = this.run(['diff', '--name-only', '--relative', '--no-renames', '-z', sha]);
      this.changed.set(sha, out === null ? null : new Set(out.split('\0').filter(Boolean)));
    }
    return this.changed.get(sha) ?? null;
  }

  /** a root-relative file's text at sha, or null if it did not exist */
  show(sha: string, path: string): string | null {
    const k = `${sha}:${path}`;
    if (!this.shown.has(k)) this.shown.set(k, this.run(['show', `${sha}:./${path}`]));
    return this.shown.get(k) ?? null;
  }

  /** ISO 8601 (with UTC offset) commit date of a commit-ish, or null when git does not know it (T72: OKF `generated.at`, SPEC.md §5.2). */
  commitDate(rev: string): string | null {
    if (!this.ok) return null;
    const out = this.run(['show', '-s', '--format=%cI', rev]);
    return out?.trim() || null;
  }

  /** last commit that touched each of the given root-relative files (one git log pass) */
  lastCommits(paths: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.ok || paths.length === 0) return out;
    const want = new Set(paths);
    const dirs = [...new Set(paths.map((p) => p.slice(0, p.lastIndexOf('/') + 1) || '.'))];
    const log = this.run(['log', '--format=%x00%H', '--name-only', '--no-renames', '--', ...dirs.map((d) => `./${d}`)]);
    if (log === null) return out;
    let sha = '';
    for (const line of log.split('\n')) {
      if (line.startsWith('\0')) sha = line.slice(1).trim();
      else if (line) {
        const rel = this.prefix && line.startsWith(this.prefix) ? line.slice(this.prefix.length) : line;
        if (want.has(rel) && !out.has(rel)) out.set(rel, sha);
      }
      if (out.size === want.size) break;
    }
    return out;
  }
}

export type AnchorState = { present: boolean; changed: boolean; kind: 'file' | 'symbol' | 'folder'; path: string; tail?: string };

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function checkAnchor(root: string, git: Git, target: string, sha: string | null): AnchorState {
  const hash = target.indexOf('#');
  if (hash > 0) {
    const path = target.slice(0, hash).replace(/^\.\//, '');
    const tail = target.slice(hash + 1);
    const abs = join(root, path);
    let now: string | undefined;
    if (isFile(abs)) {
      const name = tail.slice(tail.lastIndexOf('.') + 1);
      if (readFileSync(abs, 'utf8').includes(name)) now = symbolsInFile(root, path).find((s) => s.tail === tail)?.hash;
    }
    if (now === undefined) return { present: false, changed: false, kind: 'symbol', path, tail };
    let changed = false;
    if (sha && git.changedSince(sha)?.has(path)) {
      const old = git.show(sha, path);
      const before = old === null ? undefined : symbolsOfText(path, old).find((s) => s.tail === tail)?.hash;
      changed = before !== now;
    }
    return { present: true, changed, kind: 'symbol', path, tail };
  }
  const path = target.replace(/^\.\//, '').replace(/\/+$/, '');
  const abs = join(root, path);
  if (target.endsWith('/') || isDir(abs)) {
    if (!isDir(abs)) return { present: false, changed: false, kind: 'folder', path };
    let changed = false;
    const set = sha ? git.changedSince(sha) : null;
    if (sha && set)
      for (const f of set) {
        if (!(path === '' || path === '.' || f.startsWith(`${path}/`))) continue;
        const old = git.show(sha, f);
        const nowAbs = join(root, f);
        if (old === null || !existsSync(nowAbs) || contentHash(f, old) !== contentHash(f, readFileSync(nowAbs, 'utf8'))) {
          changed = true;
          break;
        }
      }
    return { present: true, changed, kind: 'folder', path };
  }
  if (!isFile(abs)) return { present: false, changed: false, kind: 'file', path };
  let changed = false;
  if (sha && git.changedSince(sha)?.has(path)) {
    const old = git.show(sha, path);
    changed = old === null || contentHash(path, old) !== contentHash(path, readFileSync(abs, 'utf8'));
  }
  return { present: true, changed, kind: 'file', path };
}

// ---- evidence

const fileCache = new Map<string, string | null>();
function readOrNull(abs: string): string | null {
  if (!fileCache.has(abs)) {
    let t: string | null = null;
    try {
      t = isFile(abs) ? readFileSync(abs, 'utf8') : null;
    } catch {
      t = null;
    }
    fileCache.set(abs, t);
  }
  return fileCache.get(abs) ?? null;
}

/** 'path#test name' -> present in the file as a quoted string? */
export function testPresent(root: string, test: string): { present: boolean; path: string; name: string } {
  const i = test.indexOf('#');
  const path = (i > 0 ? test.slice(0, i) : test).replace(/^\.\//, '');
  const name = i > 0 ? test.slice(i + 1) : '';
  fileCache.delete(join(root, path)); // files change between calls (tests, bench scenarios)
  const text = readOrNull(join(root, path));
  if (text === null) return { present: false, path, name };
  if (!name) return { present: true, path, name };
  return { present: [`'${name}'`, `"${name}"`, `\`${name}\``].some((q) => text.includes(q)), path, name };
}

interface Assertion {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
}
interface FileResult {
  name?: string;
  status?: string;
  assertionResults?: Assertion[];
}

/** A vitest / jest JSON report: which evidence tests failed. */
export class TestReport {
  private files: FileResult[];
  constructor(report: unknown) {
    const r = report as { testResults?: FileResult[] } | null;
    this.files = Array.isArray(r?.testResults) ? r!.testResults : [];
  }
  static load(src: string | unknown, cwd: string): TestReport | undefined {
    if (src === undefined || src === null) return undefined;
    if (typeof src === 'string') {
      const p = isAbsolute(src) ? src : join(cwd, src);
      return new TestReport(JSON.parse(readFileSync(p, 'utf8')));
    }
    return new TestReport(src);
  }
  /** 'failed' if a matching test failed, 'passed' if it ran and passed, undefined if the report does not have it */
  status(root: string, ev: EvidenceRef): 'failed' | 'passed' | undefined {
    if (!ev.test) return undefined;
    const i = ev.test.indexOf('#');
    const path = (i > 0 ? ev.test.slice(0, i) : ev.test).replace(/^\.\//, '');
    const name = i > 0 ? ev.test.slice(i + 1) : '';
    let seen: 'failed' | 'passed' | undefined;
    for (const f of this.files) {
      const n = (f.name ?? '').split('\\').join('/');
      const rel = isAbsolute(n) ? relative(root, n).split('\\').join('/') : n;
      if (!(rel === path || n.endsWith(`/${path}`))) continue;
      const tests = (f.assertionResults ?? []).filter(
        (a) => !name || a.title === name || a.fullName === name || (a.ancestorTitles ?? []).includes(name) || (a.fullName ?? '').startsWith(`${name} `),
      );
      for (const a of tests) {
        if (a.status === 'failed') return 'failed';
        if (a.status === 'passed') seen = 'passed';
      }
      if (!name && f.status === 'failed') return 'failed';
    }
    return seen;
  }
}
