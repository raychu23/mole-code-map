// CODEOWNERS as GitHub documents it (about-code-owners): gitignore-style patterns without `!`, `[ ]` or `\#`, the LAST
// matching line wins, a matching line with no owners leaves the path unowned, the file is looked up in .github/, the root,
// then docs/ (first found wins), and a pull request uses the file on its base branch.
import { execFileSync } from 'node:child_process';
import type { CodeOwners } from './types.js';

const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

interface Rule {
  re: RegExp;
  /** true when the pattern may also match a folder that contains the path (it covers the folder's contents) */
  folders: boolean;
  dirOnly: boolean;
  anchored: boolean;
  owners: string[];
}

const OWNER = /^@[\w.-]+(?:\/[\w.-]+)?$|^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** one glob (no leading slash) -> a regex source over '/'-separated paths */
function globSource(glob: string): string {
  let s = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      s += '(?:[^/]+/)*';
      i += 3;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      s += '/.+';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      s += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      s += '[^/]*';
      i += 1;
    } else if (glob[i] === '?') {
      s += '[^/]';
      i += 1;
    } else {
      s += glob[i]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return s;
}

function rule(pattern: string, owners: string[]): Rule | null {
  const dirOnly = pattern.endsWith('/');
  let p = pattern.replace(/\/+$/, '');
  if (!p) return null;
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');
  const last = p.slice(p.lastIndexOf('/') + 1);
  // `docs/*` matches docs/a.md but not docs/sub/b.md: a wildcard last segment never covers a folder's contents
  const folders = !/[*?]/.test(last) || p.endsWith('**');
  return { re: new RegExp(`^${globSource(p)}$`), folders, dirOnly, anchored, owners };
}

function matches(r: Rule, path: string): boolean {
  const parts = path.split('/');
  for (let k = parts.length; k >= 1; k--) {
    const isDir = k < parts.length;
    if (isDir && !r.folders) continue;
    if (!isDir && r.dirOnly) continue;
    const subject = r.anchored ? parts.slice(0, k).join('/') : parts[k - 1]!;
    if (r.re.test(subject)) return true;
  }
  return false;
}

export function parseCodeowners(text: string): CodeOwners {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...rest] = line.split(/\s+/);
    const owners: string[] = [];
    for (const tok of rest) {
      if (tok.startsWith('#')) break;
      const t = tok.replace(/,+$/, '');
      if (OWNER.test(t)) owners.push(t);
    }
    const r = rule(pattern!, owners);
    if (r) rules.push(r);
  }
  return {
    ownersOf(path: string): string[] {
      let found: string[] = [];
      for (const r of rules) if (matches(r, path)) found = r.owners;
      return [...found];
    },
  };
}

/** The CODEOWNERS file GitHub would use at a revision (base branch of a PR), or null. */
export function codeownersAt(root: string, rev: string): { path: string; text: string } | null {
  for (const path of LOCATIONS) {
    try {
      const text = execFileSync('git', ['-C', root, 'show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
      return { path, text };
    } catch {
      // not at this location
    }
  }
  return null;
}
