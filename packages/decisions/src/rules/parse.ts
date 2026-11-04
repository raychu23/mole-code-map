// Parse `rules:` from .mole/decisions/*.md front matter into RuleSpec[], with the record's file:line for every rule and
// every error. A rule with a syntax error is reported (never silently skipped); the record's other rules still load.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YNode, type Pair } from 'yaml';
import { MOLE_DIR, normStatus } from '../graph.js';
import type { Problem } from '../types.js';
import type { RuleKind, RuleSpec, RulesLoad } from './types.js';

const KEYS = new Set(['forbid', 'from', 'to', 'callee', 'except', 'dynamic', 'types', 'why']);
const NOT_ENFORCED = new Set(['superseded', 'deprecated', 'rejected']);

/** Record metadata the citation needs: id, title, status. */
export interface RecordMeta {
  id: string;
  title: string;
  status: string;
  file: string;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Glob (** * ? {a,b}) to a regex body; throws on an unbalanced or nested brace. */
export function globBody(g: string): string {
  let out = '';
  let inBrace = false;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++; // '**/' = any depth, including none
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      if (inBrace) throw new Error(`bad glob '${g}': nested '{'`);
      inBrace = true;
      out += '(?:';
    } else if (c === '}') {
      if (!inBrace) throw new Error(`bad glob '${g}': '}' without '{'`);
      inBrace = false;
      out += ')';
    } else if (c === ',' && inBrace) out += '|';
    else out += escapeRe(c);
  }
  if (inBrace) throw new Error(`bad glob '${g}': unclosed '{'`);
  return out;
}

/** A repo path prefix or glob as an anchored regex: 'dir/' = under dir, 'a/b.ts' = that file or a folder of that name. */
export function pathRegex(p: string): string {
  const s = p.replace(/^\.\//, '');
  const body = globBody(s);
  return s.endsWith('/') ? `^${body}` : `^${body}(?:$|/)`;
}

/** `to` that starts with '@' or has no '/' is a module name; anything else is a repo path prefix. */
export const isModuleName = (to: string): boolean => to.startsWith('@') || !to.includes('/');

/** A module name matches its bare form, sub-paths and the installed node_modules path; '@scope/' = the whole scope. */
export function moduleRegex(name: string): string {
  const n = escapeRe(name);
  return name.endsWith('/') ? `^${n}|(?:^|/)node_modules/${n}` : `^${n}(?:/|$)|(?:^|/)node_modules/${n}(?:/|$)`;
}

export const toRegex = (to: string): string => (isModuleName(to) ? moduleRegex(to) : pathRegex(to));
export const anyOf = (res: string[]): string => (res.length === 1 ? res[0]! : res.map((r) => `(?:${r})`).join('|'));

interface FM {
  map: YNode | null;
  lineAt: (offset: number) => number;
  src: string;
}

function readFrontMatter(text: string, file: string, errors: Problem[]): FM | undefined {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const body = lines.slice(1, end < 0 ? lines.length : end);
  const mentionsRules = body.some((l) => /^rules\s*:/.test(l));
  if (end < 0) {
    if (mentionsRules) errors.push({ file, line: 1, message: 'front matter is not closed with ---' });
    return undefined;
  }
  const src = body.join('\n');
  const lc = new LineCounter();
  const doc = parseDocument(src, { lineCounter: lc, prettyErrors: false });
  const lineAt = (offset: number) => lc.linePos(offset).line + 1; // +1: the opening ---
  if (doc.errors.length > 0) {
    if (mentionsRules) {
      const e = doc.errors[0]!;
      errors.push({ file, line: lineAt(e.pos[0]), message: `YAML: ${e.message.split('\n')[0]}` });
    }
    return undefined;
  }
  return { map: doc.contents as YNode | null, lineAt, src };
}

/** loadRules plus each record's metadata (id, title, status), for citations. */
export function parseRules(root: string): RulesLoad & { meta: Map<string, RecordMeta> } {
  const out: RulesLoad & { meta: Map<string, RecordMeta> } = { rules: [], errors: [], warnings: [], skipped: [], meta: new Map() };
  const idFile = new Map<string, string>();
  const dir = join(root, MOLE_DIR, 'decisions');
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const file = `${MOLE_DIR}/decisions/${name}`;
    const fm = readFrontMatter(readFileSync(join(dir, name), 'utf8'), file, out.errors);
    if (!fm || !fm.map || !isMap(fm.map)) continue;
    const pairs = fm.map.items as Pair<YNode, YNode | null>[];
    const get = (k: string) => pairs.find((p) => isScalar(p.key) && String(p.key.value) === k);
    const rulesPair = get('rules');
    if (!rulesPair) continue;
    const str = (p: Pair<YNode, YNode | null> | undefined): string | undefined => {
      const v = p?.value;
      if (!v || !isScalar(v)) return undefined;
      if (v.type === 'PLAIN' && v.range) return fm.src.slice(v.range[0], v.range[1]).trim(); // keeps '0013', not 13
      return v.value === null || v.value === undefined ? undefined : String(v.value);
    };
    const lineOf = (n: YNode | null | undefined, fallback: number) => (n && n.range ? fm.lineAt(n.range[0]) : fallback);
    const rulesLine = lineOf(rulesPair.key, 2);
    const id = str(get('id'));
    if (!id) {
      out.errors.push({ file, line: rulesLine, message: 'a record with rules: needs an id' });
      continue;
    }
    const meta: RecordMeta = { id, title: str(get('title')) ?? id, status: normStatus(str(get('status'))), file };
    // a duplicate id keeps its own rules apart: names carry the file stem, so each violation cites the record it was written in
    const dupOf = idFile.get(id);
    const stem = dupOf ? `-${name.replace(/\.md$/, '').replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
    if (dupOf) out.warnings.push({ file, line: lineOf(get('id')?.key, rulesLine), message: `duplicate id ${id} (also ${dupOf}): its rules are named mole-${id}${stem}-<n>` });
    else {
      idFile.set(id, file);
      out.meta.set(id, meta);
    }
    // not enforced, but still syntax-checked: a broken rule must not wait for the record's reinstatement to surface
    const enforced = !NOT_ENFORCED.has(meta.status);
    if (!enforced) out.skipped.push({ decision: id, reason: `record is ${meta.status}: its rules are not enforced`, file, line: rulesLine });
    const seq = rulesPair.value;
    if (!seq || !isSeq(seq)) {
      out.errors.push({ file, line: rulesLine, message: 'rules: must be a list of {forbid: import | call, from, to | callee, ...}' });
      continue;
    }
    seq.items.forEach((itemNode, i) => {
      const item = itemNode as YNode;
      const line = lineOf(item, rulesLine);
      const err = (message: string, at = line) => out.errors.push({ file, line: at, message: `rule ${i + 1} of ${id}: ${message}` });
      if (!isMap(item)) return err('a rule must be a map starting with forbid: import | call');
      const ps = item.items as Pair<YNode, YNode | null>[];
      const field = (k: string) => ps.find((p) => isScalar(p.key) && String(p.key.value) === k);
      let bad = false;
      const fail = (message: string, at?: number) => {
        bad = true;
        err(message, at);
      };
      for (const p of ps) {
        const k = isScalar(p.key) ? String(p.key.value) : '';
        if (!KEYS.has(k)) fail(`unknown key '${k}' (forbid, from, to, callee, except, dynamic, types, why)`, lineOf(p.key, line));
      }
      const scalar = (k: string): string | undefined => {
        const p = field(k);
        if (!p) return undefined;
        const v = str(p);
        if (v === undefined || v === '') fail(`${k} must be a non-empty string`, lineOf(p.key, line));
        return v;
      };
      const list = (k: string): string[] | undefined => {
        const p = field(k);
        if (!p) return undefined;
        const v = p.value;
        if (v && isSeq(v)) {
          const vals = v.items.map((x) => (isScalar(x) && x.value !== null && x.value !== undefined ? String(x.value).trim() : ''));
          if (vals.length === 0 || vals.some((x) => !x)) fail(`${k} must be a string or a list of non-empty strings`, lineOf(p.key, line));
          return vals.filter(Boolean);
        }
        const s = str(p);
        if (!s) {
          fail(`${k} must be a string or a list of non-empty strings`, lineOf(p.key, line));
          return [];
        }
        return [s];
      };
      const bool = (k: string): boolean | undefined => {
        const p = field(k);
        if (!p) return undefined;
        const v = p.value;
        if (v && isScalar(v) && typeof v.value === 'boolean') return v.value;
        fail(`${k} must be true or false`, lineOf(p.key, line));
        return undefined;
      };
      const kindRaw = scalar('forbid');
      let kind: RuleKind | undefined;
      if (kindRaw === undefined) {
        if (!field('forbid')) fail('missing forbid: import | call');
      } else if (kindRaw === 'import' || kindRaw === 'call') kind = kindRaw;
      else fail(`forbid: '${kindRaw}' is not import | call`, lineOf(field('forbid')?.key, line));
      const from = scalar('from');
      if (!field('from')) fail('missing from: (a repo path prefix or glob)');
      const to = list('to');
      const callee = list('callee');
      const except = list('except') ?? [];
      const dynamic = bool('dynamic');
      const types = bool('types');
      const why = field('why') ? scalar('why') : undefined;
      if (kind === 'import') {
        if (!to) fail('forbid: import needs to: (a module name or repo path prefix, or a list)');
        if (callee) fail('callee: belongs to forbid: call', lineOf(field('callee')?.key, line));
      }
      if (kind === 'call') {
        if (!callee) fail('forbid: call needs callee: (a function name such as writeFileSync or fs.rmSync, or a list)');
        if (to) fail('to: belongs to forbid: import', lineOf(field('to')?.key, line));
        for (const k of ['dynamic', 'types']) if (field(k)) fail(`${k}: belongs to forbid: import`, lineOf(field(k)?.key, line));
      }
      // repo-relative with forward slashes: an absolute, '..' or backslash path matches no repo file and would read as green
      const paths: Array<[string, string[]]> = [['from', from ? [from] : []], ['except', except], ['to', to ?? []]];
      for (const [k, vals] of paths)
        for (const v of vals) {
          const why = v.includes('\\')
            ? "uses '\\' (write paths with /)"
            : /^(?:\/|[A-Za-z]:)/.test(v)
              ? 'is absolute (write a repo-relative path)'
              : /(?:^|\/)\.\.(?:\/|$)/.test(v)
                ? "leaves the repo ('..')"
                : undefined;
          if (why) fail(`${k}: '${v}' ${why}`, lineOf(field(k)?.key, line));
        }
      const globs: Array<[string, string[]]> = [['from', from ? [from] : []], ['except', except], ['to', (to ?? []).filter((t) => !isModuleName(t))]];
      for (const [k, vals] of globs)
        for (const v of vals)
          try {
            pathRegex(v);
          } catch (e) {
            fail(`${k}: ${(e as Error).message}`, lineOf(field(k)?.key, line));
          }
      if (bad || !kind || !from || !enforced) return;
      out.rules.push({
        name: `mole-${id.replace(/[^A-Za-z0-9_-]/g, '_')}${stem}-${i + 1}`,
        kind,
        decision: id,
        title: meta.title,
        status: meta.status,
        from,
        to: to ?? [],
        callee: callee ?? [],
        except,
        ...(dynamic === undefined ? {} : { dynamic }),
        types: types ?? false,
        ...(why === undefined ? {} : { why }),
        file,
        line,
      });
    });
  }
  return out;
}

/** Load every rule of every decision record under root/.mole/decisions. */
export function loadRules(root: string): RulesLoad {
  const { rules, errors, warnings, skipped } = parseRules(root);
  return { rules, errors, warnings, skipped };
}
