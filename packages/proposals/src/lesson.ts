// T59: double-loop learning (Argyris & Schön 1977; prior art: (internal reference removed) log/prior-art.md).
// A lesson record (.mole/lessons/*.md: id, title, learned_from: [incidents], revises: tenet-N, owner, optional check,
// and a "## Proposed tenet" section) becomes a DRAFT revision of that tenet on a mole-proposals branch (T56):
//   1 validate against the baseline commit's own .mole (git archive snapshot, read-only): lesson, owner, incidents, tenet
//   2 create the proposal branch + worktree from HEAD (createProposal)
//   3 in the proposal worktree only: rewrite that tenet's section of .mole/tenets.md and commit on the proposal branch
//   4 report every decision that traces_to the tenet (file:line) for re-review
// Approved tenets never change here; approval = a person merging the branch.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontMatter, loadGraph } from '@mole/decisions';
import { baselineSnapshot, createProposal, ProposalError, type ProposalMeta } from './proposals.js';

export interface LessonOptions {
  repo: string;
  lesson: string;
  /** absolute, not-yet-existing path for the proposal worktree */
  path: string;
  /** proposal name, default lesson-<id> */
  name?: string;
}

export interface TenetRevision {
  proposal: ProposalMeta;
  path: string;
  lesson: { id: string; file: string; owner: string; learnedFrom: string[]; check?: string };
  tenet: { id: string; before: string; after: string };
  commit: string;
  /** records (decisions, intent) that trace_to the tenet: they rest on the old wording */
  reReview: Array<{ id: string; kind: string; title: string; file: string; line: number }>;
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LESSON_DIR = '.mole/lessons';
const TENETS = '.mole/tenets.md';

interface Lesson {
  id: string;
  file: string;
  owner?: string;
  learnedFrom: string[];
  revises?: string;
  check?: string;
  proposedTitle: string;
  proposedBody: string;
}

function readLesson(repo: string, id: string): Lesson {
  const dir = join(repo, LESSON_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const name of files) {
    const file = `${LESSON_DIR}/${name}`;
    const text = readFileSync(join(repo, file), 'utf8');
    const fm = frontMatter(text, file);
    if (!fm || 'error' in fm) continue;
    const one = (k: string) => fm.fields.get(k)?.value ?? fm.fields.get(k)?.items?.[0]?.value;
    if (one('id') !== id) continue;
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s+proposed tenet\s*$/i.test(l.trim()));
    let proposedTitle = '';
    let proposedBody = '';
    if (start >= 0) {
      const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
      const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
      const [first = '', ...rest] = section.split('\n');
      proposedTitle = first.trim();
      proposedBody = rest.join('\n').trim();
    }
    return {
      id,
      file,
      owner: one('owner'),
      learnedFrom: (fm.fields.get('learned_from')?.items ?? []).map((i) => i.value).filter((v): v is string => !!v),
      revises: one('revises'),
      check: one('check'),
      proposedTitle,
      proposedBody,
    };
  }
  throw new ProposalError(`no lesson record with id '${id}' in ${LESSON_DIR}`);
}

/** The `## tenet-N …` section of tenets.md: [start line, end line exclusive]. */
function tenetSection(lines: string[], tenetId: string): [number, number] | undefined {
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${tenetId.replace(/[.]/g, '\\.')}(\\s|$)`, 'i').test(l));
  if (start < 0) return undefined;
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return [start, next < 0 ? lines.length : next];
}

export function proposeTenetRevision(opts: LessonOptions): TenetRevision {
  // 1 validate, read-only, before any write
  if (spawnSync('git', ['-C', opts.repo, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }).status !== 0) throw new ProposalError(`not a git repository: ${opts.repo}`);
  const repo = git(opts.repo, ['rev-parse', '--show-toplevel']);
  if (git(repo, ['status', '--porcelain', '--', '.mole'])) {
    throw new ProposalError(`commit the .mole records first: the draft is made from the pinned baseline (HEAD), and .mole has uncommitted changes`);
  }
  // review 2 HIGH: validate the SAME records the draft is pinned to. Read HEAD's .mole from a `git archive` snapshot
  // (as T56 evaluate does), never the working tree: skip-worktree / assume-unchanged / ignored files cannot diverge.
  // review 3 MEDIUM: an empty repository is a clean refusal, not a raw git error
  if (spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { stdio: 'ignore' }).status !== 0) {
    throw new ProposalError(`repository has no commits yet: commit the .mole records first (${repo})`);
  }
  const rev = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const snap = baselineSnapshot(repo, rev);
  let lesson: Lesson;
  let tenet: { id: string; title: string };
  let reReview: TenetRevision['reReview'];
  try {
    try {
      lesson = readLesson(snap, opts.lesson);
    } catch (e) {
      // review 3: only the pinned rev is read; the message covers both cases instead of peeking at the working tree
      throw new ProposalError(`no lesson record with id '${opts.lesson}' in ${LESSON_DIR} at HEAD (not committed? the draft is made from the pinned baseline)`);
    }
    if (!lesson.owner) throw new ProposalError(`lesson ${lesson.id} has no owner (a lesson needs someone who carries it through, ${lesson.file})`);
    if (lesson.learnedFrom.length === 0) throw new ProposalError(`lesson ${lesson.id} has no learned_from incident (${lesson.file})`);
    if (!lesson.revises) throw new ProposalError(`lesson ${lesson.id} names no tenet in revises: (${lesson.file})`);
    if (!lesson.proposedTitle) throw new ProposalError(`lesson ${lesson.id} has no "## Proposed tenet" section with the new wording (${lesson.file})`);
    const graph = loadGraph(snap);
    for (const inc of lesson.learnedFrom) {
      if (!graph.nodes.some((n) => n.kind === 'incident' && n.id === inc)) throw new ProposalError(`lesson ${lesson.id}: learned_from ${inc} has no record in .mole/incidents at HEAD`);
    }
    const t = graph.nodes.find((n) => n.kind === 'tenet' && n.id === lesson.revises);
    if (!t) throw new ProposalError(`lesson ${lesson.id}: revises ${lesson.revises}, which is not a tenet in ${TENETS} at HEAD`);
    if (t.retired) throw new ProposalError(`lesson ${lesson.id}: ${t.id} is retired; propose a new tenet instead`);
    tenet = { id: t.id, title: t.title };
    reReview = graph.edges
      .filter((e) => e.type === 'traces_to' && e.to === t.id)
      .map((e) => {
        const n = graph.nodes.find((x) => x.id === e.from);
        return { id: e.from, kind: n?.kind ?? 'unknown', title: n?.title ?? e.from, file: e.file, line: e.line };
      })
      .sort((x, y) => x.id.localeCompare(y.id));
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }

  // 2 the proposal branch + worktree (all createProposal checks run before its first write)
  const proposal = createProposal({ repo, name: opts.name ?? `lesson-${lesson.id.toLowerCase()}`, path: opts.path, base: rev });

  // 3 rewrite only the tenet's section, in the proposal worktree, and commit there. Any failure from here on undoes
  //   exactly what this call created (the worktree + branch), so a refusal never leaves anything behind (review 1)
  let commit: string;
  try {
    // 3 rewrite only the tenet's section, in the proposal worktree, and commit there
    const tenetsPath = join(opts.path, TENETS);
    const text = readFileSync(tenetsPath, 'utf8');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const [start, end] = tenetSection(lines, tenet.id)!;
    const section = [
      `## ${tenet.id} · ${lesson.proposedTitle}`,
      '',
      ...(lesson.proposedBody ? [lesson.proposedBody, ''] : []),
      `Draft revision from lesson ${lesson.id} (learned from ${lesson.learnedFrom.join(', ')}; owner ${lesson.owner}${lesson.check ? `; check ${lesson.check}` : ''}). Was: "${tenet.title}".`,
      '',
    ];
    lines.splice(start, end - start, ...section);
    writeFileSync(tenetsPath, lines.join(nl).replace(/\n{3,}$/, '\n'));
    const identity = git(opts.path, ['config', '--default', '', 'user.email']) ? [] : ['-c', 'user.name=Mole', '-c', 'user.email=mole@localhost'];
    git(opts.path, ['add', '--', TENETS]);
    git(opts.path, [...identity, 'commit', '-q', '-m', `draft: lesson ${lesson.id} revises ${tenet.id} (learned from ${lesson.learnedFrom.join(', ')})`, '--', TENETS]);
    commit = git(opts.path, ['rev-parse', 'HEAD']);
  } catch (e) {
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', opts.path], { stdio: 'ignore' });
    spawnSync('git', ['-C', repo, 'branch', '-D', proposal.branch], { stdio: 'ignore' });
    throw e instanceof ProposalError ? e : new ProposalError(`could not write the draft tenet: ${(e as Error).message}`);
  }

  return {
    proposal,
    path: opts.path,
    lesson: { id: lesson.id, file: lesson.file, owner: lesson.owner, learnedFrom: lesson.learnedFrom, ...(lesson.check ? { check: lesson.check } : {}) },
    tenet: { id: tenet.id, before: tenet.title, after: lesson.proposedTitle },
    commit,
    reReview,
  };
}
