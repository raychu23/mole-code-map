// Question routing (task contract: "records first, else the CODEOWNERS owner").
import { execFileSync } from 'node:child_process';
import type { Pool } from './db.js';
import { getGoverningDecisions } from './graph.js';

function parseCodeowners(text: string): { pattern: string; owners: string[] }[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern: pattern!, owners };
    });
}

function matchesCodeownersPattern(pattern: string, file: string): boolean {
  if (pattern === '*') return true;
  return file.startsWith(pattern.replace(/^\//, '').replace(/\*$/, ''));
}

function codeownersOwnerFor(repoDir: string, filePath: string): string | undefined {
  let text: string;
  try {
    text = execFileSync('git', ['show', 'HEAD:CODEOWNERS'], { cwd: repoDir, encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const rules = parseCodeowners(text);
  for (let i = rules.length - 1; i >= 0; i--) {
    if (matchesCodeownersPattern(rules[i]!.pattern, filePath)) {
      return rules[i]!.owners[0];
    }
  }
  return undefined;
}

export interface QuestionRoute {
  owner: string;
  via: 'record' | 'codeowners' | 'none';
}

export async function routeQuestion(pool: Pool, orgId: string, repoDir: string, filePath: string): Promise<QuestionRoute> {
  const rows = await getGoverningDecisions(pool, orgId, filePath, { forOrg: orgId });
  const withOwner = rows.find((r) => r.owner);
  if (withOwner) return { owner: withOwner.owner as string, via: 'record' };
  const owner = codeownersOwnerFor(repoDir, filePath);
  if (owner) return { owner, via: 'codeowners' };
  return { owner: 'unassigned', via: 'none' };
}
