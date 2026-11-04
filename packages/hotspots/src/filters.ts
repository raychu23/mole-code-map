// review-1 HIGH 2: rank source code only by default. CodeScene's own hotspot docs (Project
// Configuration -> "Exclude Files from an Analysis": "An analysis will include all textual
// content... that means you get an analysis of your build scripts, resource files, configuration
// files... there's also the risk you get too much noise"; it ships a default extension-exclusion
// list and a generated-content allow/deny-list, fetched 2026-11-03,
// https://codescene.io/docs/configuration/project-config/index.html) and code-maat's own
// `--numstat`-based churn (adamtornhill/code-maat README, fetched 2026-11-03) both treat
// config/lockfile/generated noise as excluded-by-default, not ranked alongside source.
import type { Buffer } from 'node:buffer';

/** lockfiles: never code, never useful to "pay down" -- excluded even with `all: true` */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'bun.lockb',
]);

/** config/docs/data extensions excluded by default (CodeScene's "config files... too much noise"),
 * lifted by `all: true` */
const DATA_EXT = new Set(['json', 'md', 'markdown', 'yaml', 'yml']);

/** known source-code extensions ranked by default; `all: true` lifts this allowlist entirely
 * (but never the lockfile/generated-dir/binary exclusions below) */
const SOURCE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx',
  'rb', 'php', 'sh', 'bash', 'zsh',
  'css', 'scss', 'less', 'vue', 'svelte',
  'swift', 'scala', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hs', 'lua', 'pl', 'sql', 'graphql', 'proto',
]);

/** generated/vendored dirs: never hand-authored source to pay down -- excluded even with `all: true` */
const GENERATED_DIR = /(^|\/)(dist|build|coverage|node_modules|\.next|\.turbo|out|target)\//;

export function extOf(file: string): string {
  const base = file.split('/').pop() ?? file;
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** review-1 HIGH 2: should this file be ranked? `all=true` lifts the source-extension allowlist
 * and the data-extension (*.json/*.md/*.yaml) exclusion, but generated dirs and lockfiles stay
 * excluded always -- they are never source to pay down, with or without `--all`. */
export function isRankableFile(file: string, all: boolean): boolean {
  if (GENERATED_DIR.test(file)) return false;
  const base = file.split('/').pop() ?? file;
  if (LOCKFILES.has(base)) return false;
  if (all) return true;
  const ext = extOf(file);
  if (DATA_EXT.has(ext)) return false;
  return SOURCE_EXT.has(ext);
}

/** review-1 HIGH 2: binary files skipped via NUL-byte detection in the blob content (git itself
 * uses this exact heuristic internally, core.git's `buffer_is_binary`, to decide `-`/`-` numstat
 * output for a blob -- cheaper here to check the content this package already reads for complexity
 * than to shell out to `git log --numstat` a second time). Skipped even with `all: true`: a binary
 * blob has no indentation to measure and is never "source to pay down". */
export function looksBinary(content: Buffer): boolean {
  const n = Math.min(content.length, 8000);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}
