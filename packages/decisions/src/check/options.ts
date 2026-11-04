// Options round of `mole pr-check` (T32): content anchors and the version-bump rule. Code only, no model, no network.
//  1. content anchors: a decision record may carry `match:` items {pattern: <JS regex>, in?: <glob>, why?: text}; the record
//     governs an ADDED line whose text matches a pattern in a file the glob covers. For codebase-wide conventions (named
//     exports, React.FC, msw, ...) that no path anchor can express.
//  2. version-bump rule: a hunk whose old and new lines differ only in version-like tokens (semver, ~> / ^ pins, sha refs,
//     numbers on a version/tag/ref line) is not governed by a scope anchor: architecture decisions are not about routine
//     dependency bumps unless they name the dependency (a content anchor matching the changed line or the hunk's
//     enclosing-block header still fires).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { frontMatter } from '../graph.js';
import type { GraphNode, Problem } from '../types.js';

/** review 1 P2-3: added lines longer than this are never tested against `match:` patterns (bounds regex work per line) */
export const MAX_MATCH_LINE = 2000;

const repeatAt = (p: string, i: number): boolean => {
  const c = p[i];
  if (c === '+' || c === '*') return true;
  if (c !== '{') return false;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
  if (!m) return false;
  if (m[2] === undefined) return Number(m[1]) > 1;
  return m[3] === '' || Number(m[3]) > 1;
};

/** review 1 P2-3: true when a repeated group contains a repeat itself (`(a+)+`, `(?:x*y)*`, `(a{1,}){2,}`): the shape of
 *  catastrophic backtracking. A syntactic check (escapes and [classes] skipped), deliberately conservative. */
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      if (pattern[i + 1] === '^') i++;
      if (pattern[i + 1] === ']') i++;
      continue;
    }
    if (c === '(') {
      stack.push(false);
      continue;
    }
    if (c === ')') {
      const inner = stack.pop() ?? false;
      const rep = repeatAt(pattern, i + 1);
      if (inner && rep) return true;
      if ((inner || rep) && stack.length) stack[stack.length - 1] = true;
      continue;
    }
    if (repeatAt(pattern, i) && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

export interface ContentAnchor {
  pattern: string;
  re: RegExp;
  in?: string;
  inRe?: RegExp;
  why?: string;
  file: string;
  line: number;
}

/** gitignore-ish glob -> anchored RegExp: `**` any depth (incl. none), `*` and `?` within a segment, `{a,b}` alternatives */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  const g = glob.replace(/^\.?\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const j = g.indexOf('}', i);
      if (j < 0) out += '\\{';
      else {
        out += `(?:${g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = j;
      }
    } else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** the `match:` items of a record (read from its file under the records root). Invalid regexes and nested quantifiers are
 *  not applied; each is pushed to `problems` at the record's file:line when a sink is given (review 1 P2-3). */
export function contentAnchorsOf(recordsRoot: string, n: GraphNode, problems?: Problem[]): ContentAnchor[] {
  if (n.format !== 'mole') return [];
  let text: string;
  try {
    text = readFileSync(join(recordsRoot, n.file), 'utf8');
  } catch {
    return [];
  }
  const fm = frontMatter(text, n.file);
  if (!fm || 'error' in fm) return [];
  const out: ContentAnchor[] = [];
  for (const it of fm.fields.get('match')?.items ?? []) {
    const pattern = it.map ? it.map.pattern : it.value;
    if (!pattern) continue;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      problems?.push({ file: n.file, line: it.line, message: `match: invalid regex ${JSON.stringify(pattern)} (${(e as Error).message}); this anchor is not applied` });
      continue;
    }
    if (hasNestedQuantifier(pattern)) {
      problems?.push({ file: n.file, line: it.line, message: `match: nested quantifier in ${JSON.stringify(pattern)} (catastrophic backtracking risk); this anchor is not applied` });
      continue;
    }
    const glob = it.map?.in || undefined;
    out.push({ pattern, re, in: glob, inRe: glob ? globToRegExp(glob) : undefined, why: it.map?.why, file: n.file, line: it.line });
  }
  return out;
}

const VERSION_TOKEN = /(?:~>\s*|[~^]|[<>]=?\s*)?\bv?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?\b|\bv\d+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const VERSION_KEY = /version|\btag\b|\bref\b|\brev\b|digest|\bsha\b/i;
const norm = (line: string) => {
  let s = line.replace(VERSION_TOKEN, '\u0000');
  if (VERSION_KEY.test(line)) s = s.replace(/\b\d+\b/g, '\u0000');
  return s.trim();
};

/** true when the hunk's old and new lines differ, pairwise, only in version-like tokens */
export function isVersionOnlyHunk(del: string[], add: string[]): boolean {
  if (!del.length || del.length !== add.length) return false;
  let differs = false;
  for (let i = 0; i < del.length; i++) {
    const o = del[i]!;
    const n = add[i]!;
    if (o === n) continue;
    if (norm(o) !== norm(n)) return false;
    differs = true;
  }
  return differs;
}

// Option 3 (options round 2, T32): title-term bump gate. A standard IR/VSM preprocessing step (tokenize + drop a fixed
// stopword list), applied to the record's OWN title (already in the frozen overlay, no new authored data) rather than to
// a codebase corpus. A version-only hunk (a dependency/provider bump) under a folder or file scope anchor is governed
// only when the hunk's enclosing-block context or added text literally names the record's own title vocabulary (e.g. a
// `helm_release` resource block for "Use Helm..."); a bump that names no part of the title (a routine provider-version
// line next to it in the same folder) is not. Distinct from option 2 (`versionBumpRule`, off by default), which drops
// every version-only hunk unconditionally and so also drops true bumps of the decided component (2 insights round 1).
/** a small, fixed, corpus-independent English stopword list (standard IR practice; not tuned to any record's title) */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'these', 'those', 'use', 'uses', 'using', 'used',
  'avoid', 'prefer', 'default', 'defaults', 'proper', 'non', 'policy', 'record', 'records', 'architecture', 'decision',
  'about', 'over', 'under', 'than', 'then', 'when', 'what', 'which', 'where', 'will', 'shall', 'should', 'would',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being', 'not', 'but', 'via', 'per', 'each', 'all', 'any',
  'some', 'such', 'only', 'instead', 'retire', 'restructure', 'maintain', 'give', 'expose', 'split', 'replace',
]);
/** title -> distinctive lowercase terms: tokens >=4 chars, not a stopword, deduped. Pure IR query-term extraction
 *  (no corpus IDF, no per-record curation): applies identically to every record's title. */
export function titleTermsOf(title: string): string[] {
  const toks = title.match(/[A-Za-z][A-Za-z0-9+.#-]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of toks) {
    const lw = t.toLowerCase();
    if (lw.length < 4 || STOPWORDS.has(lw) || seen.has(lw)) continue;
    seen.add(lw);
    out.push(lw);
  }
  return out;
}
/** true when any of `terms` occurs (case-insensitive substring) in `text` */
export function hasTitleTerm(text: string, terms: string[]): boolean {
  if (!text) return false;
  const lw = text.toLowerCase();
  return terms.some((t) => lw.includes(t));
}

// Options round 3 (T32): three more code-only levers, grounded in prior-art.md round 3 (ast-grep/drift AST anchoring,
// Dependabot/Renovate classifier precedent, GitHub CODEOWNERS 'most specific pattern wins'). None touches the frozen
// key or overlay (R2): every check below runs identically for any record whose title/scope already has this generic
// shape, with no per-record authored pattern.

/** generic test-file detector (not per-record data): a scope folder/file/symbol anchor governs production code, not
 *  its own tests, the same distinction CODEOWNERS and ast-grep tooling draw between a symbol and its test double. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path);
}

/** true when every added line of a hunk is comment/doc syntax only (JSDoc `/** ... *\/`, `*`-continuation, `//`): a
 *  decision about code structure/behaviour is never about what a comment says, so this is safe to drop generically
 *  for ANY folder/file/symbol scope anchor, not just the ones this round's bench happens to exercise. */
export function isCommentOnlyHunk(add: string[]): boolean {
  if (!add.length) return false;
  return add.every((l) => {
    const t = l.trim();
    return t === '' || t.startsWith('/**') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//');
  });
}

/** title -> generic IR trigger: true when the record's OWN title is itself about the export/named-export convention
 *  (same titleTermsOf extraction as option 3, no new data). Scopes the option-4 detector below to records that are
 *  actually about exports, so it never fires for an unrelated scope:[] convention record.
 *
 *  Deliberately BROAD (any title term merely starting with "export"): this only decides whether the record becomes
 *  a prCheck candidate and gets an `export-convention` AST hit at all (routing). A record titled "Audit every data
 *  export" also passes this -- on purpose, same as a `match:` content anchor would route it -- because dropping a
 *  routing hit silently removes the decision from `governed` entirely (T49's recall-ceiling finding). Whether that
 *  hit is CRISP enough to decide alone with no judge is a separate, narrower question: see isModuleExportTitle. */
export function isExportConventionTitle(title: string): boolean {
  return titleTermsOf(title).some((t) => t.startsWith('export'));
}

/** T66 review-1: narrower than isExportConventionTitle -- true only when the title uses actual JS/TS module-export
 *  vocabulary (default/named exports, module export structure, barrel/index/re-export, conventions, entry point,
 *  public API surface), not merely a title term that happens to start with "export" (e.g. "Audit every data export"
 *  is about a data/report export, not the language construct). Grounded in real-world wording (prior-art.md #4):
 *  Backstage's ADR003 "Avoid Default Exports and Prefer Named Exports" and ADR004 "Module Export Structure"
 *  (bs-adr003/004, the bench's own motivating cases); eslint-plugin-import's `no-default-export`,
 *  `prefer-default-export`, `no-named-export`, `no-anonymous-default-export` and `group-exports` rule names/
 *  descriptions; and public ADRs titled "Barrel Export Boundaries" / "Barrel Export Pattern". Review-1 (HIGH) found
 *  the first cut missed genuine module-export titles that use "convention(s)" with no other listed word (e.g.
 *  "Export conventions") or pair "barrel" with a hyphenated "re-exporting" that the old `\bre-?export\b` word-
 *  boundary test couldn't match (e.g. "Barrel files re-exporting") -- both now pass via the wider vocabulary list
 *  and a dedicated `re-?export(?:s|ing)?` alternative outside the `\b...\b` wrapping.
 *
 *  Three-part test, in order:
 *   1. the title must mention "export" at all (substring, so "exporting"/"exporter"/"exports" all count) --
 *      otherwise there is nothing to be a module-export title about;
 *   2. it must then contain module/code-structure vocabulary (default, named, module(s), barrel(s), index,
 *      convention(s), entry point, public api / api surface, or a re-export form);
 *   3. it must NOT also contain data/business-export vocabulary (data, csv, report(s), download(s), endpoint(s),
 *      job(s), pipeline(s), user(s), excel, pdf) -- a safety net for a title that mixes both registers (e.g.
 *      "Default export of CSV report data"), which stays non-crisp because the data-export reading dominates.
 *      Deliberately excludes "file"/"files" from that data list: "Barrel files re-exporting" and "index files" are
 *      genuine module-structure phrasing (ADR004's own body: "only index files will have re-exports"), and no real
 *      motivating data-export title in this repo's bench corpora needs "file" to be caught (none contain it).
 *  Used by cascade.ts's isCrisp to gate whether an `export-convention` hit decides outright (no judge) or must
 *  escalate; it never affects routing (isExportConventionTitle, above, is unchanged and still broad). */
export function isModuleExportTitle(title: string): boolean {
  const lw = title.toLowerCase();
  if (!/export/.test(lw)) return false;
  const moduleVocab = /\b(default|named|module|modules|barrel|barrels|index|convention|conventions|entry point|public api|api surface)\b|re-?export(?:s|ing)?/;
  if (!moduleVocab.test(lw)) return false;
  const dataVocab = /\b(data|csv|report|reports|download|downloads|endpoint|endpoints|job|jobs|pipeline|pipelines|user|users|excel|pdf)\b/;
  return !dataVocab.test(lw);
}

const scriptKindOf = (path: string) => (/\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
/** a TS/TSX source file, never a declaration file (exported: reused to skip the git-show lookups in pr-check.ts) */
export const isTsSource = (path: string) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts');

/** Option 4: lines that newly introduce a named export, found generically with the TypeScript compiler (the same
 *  AST-anchoring precedent ast-grep/drift use for symbol anchors, applied to export DECLARATIONS instead): (a) any
 *  added line inside an `export { ... } from` / `export type { ... } from` / `export * from` re-export statement --
 *  adding a name to a barrel list is always a new named export, whether the statement itself predates the PR or not
 *  (bs-adr004's own "module export structure"); (b) a whole new top-level `export` declaration (function, class,
 *  variable, interface, type alias) whose name is not present anywhere in the file's OLD text, so an edit to an
 *  EXISTING export's body (same name already in the old file) never matches -- only a declaration that is genuinely
 *  new does. Reused for ANY record whose own title is export-convention (isExportConventionTitle), never authored
 *  per record: same two AST shapes, every file, every such record. */
export function exportConventionRanges(path: string, newText: string, oldText: string | null, addedRanges: Array<[number, number]>): Array<[number, number]> {
  if (!addedRanges.length || !isTsSource(path)) return [];
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(path, newText, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  } catch {
    return [];
  }
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const clip = (lo: number, hi: number): Array<[number, number]> =>
    addedRanges.map(([a, b]): [number, number] => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => a <= b);
  const hasExportMod = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  const hasDefaultMod = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  const out: Array<[number, number]> = [];
  for (const st of sf.statements) {
    const start = lineOf(st.getStart(sf));
    const end = lineOf(st.getEnd());
    if (ts.isExportDeclaration(st)) {
      out.push(...clip(start, end));
      continue;
    }
    if (!hasExportMod(st) || hasDefaultMod(st)) continue;
    let name: string | undefined;
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) name = st.name?.text;
    else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
      const d = st.declarationList.declarations[0]!;
      if (ts.isIdentifier(d.name)) name = d.name.text;
    }
    if (name && (oldText === null || !oldText.includes(name))) out.push(...clip(start, end));
  }
  return merge2(out);
}
function merge2(rs: Array<[number, number]>): Array<[number, number]> {
  const s = [...rs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Option 5: a Terraform `locals`/`variable`/`output` block carries no resource-TYPE signal at all (unlike a typed
 *  `resource "helm_release" "x" {` block, already handled by option 3's title gate on version-only hunks): any value
 *  can live there, so a folder/file scope anchor on a technology-named record (title names a tool/resource, e.g.
 *  "Use Helm...") governs a hunk inside one of these bare blocks only if the hunk's context or added text names a
 *  term from the record's own title -- the same generic IR title-term check as option 3, just applied to a narrower,
 *  generically-detected block KIND instead of only to version-only hunks. `resource "type" ...` blocks are untouched
 *  (the resource type name is already a strong, correctly-handled signal); this only tightens the weak bare-block
 *  case. Dependabot/Renovate-style classifiers draw the same line (a dependency manifest's named resource vs. a free-
 *  form config block) -- see prior-art.md round 3. */
export function isTfBareBlock(context: string): boolean {
  return /^(locals|variable|output)\b/.test(context.trim());
}

/** true when `text` (a whole Terraform file) declares a `resource "type" "name" { ... }` whose type or name names a
 *  term from the record's own title: the file as a whole is "about" that technology (e.g. a `helm_release` resource
 *  sits beside a `locals` block in the same file), so option 6 leaves every other block in THIS file ungated -- it
 *  only tightens a bare block in a file that names the title's technology nowhere at all (a different file under the
 *  same folder anchor, e.g. an RBAC policy file with no Helm resource in it). File-scoped, not per-record authored. */
export function fileHasTitledResource(text: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const re = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (hasTitleTerm(`${m[1]} ${m[2]}`, terms)) return true;
  return false;
}
