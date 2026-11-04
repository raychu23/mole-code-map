// `mole interrogate --sha SHA|--diff FILE [--base SHA] [--worktree]` and `mole check-records [--json]`:
// T23's two entry points, used by packages/daemon/src/cli.ts and (interrogate only) packages/mcp/src.
import { resolve } from 'node:path';
import type { Change } from '@mole/history';
import { checkAllRecords } from './record-check.js';
import { interrogate } from './interrogate.js';
import type { Finding, InterrogateResult } from './types.js';

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return 'mole check-records: no assumption-check findings';
  const out = [`${findings.length} findings:`];
  for (const f of findings) out.push(`${f.check.padEnd(18)} ${f.recordId}  ${f.file}:${f.line}\n  ${f.question}`);
  return out.join('\n');
}

export function formatInterrogate(r: InterrogateResult): string {
  if (!r.governed) return 'mole interrogate: nothing governs this change (silent)';
  if (r.questions.length === 0) return `mole interrogate: governed by ${r.governingDecisions.join(', ')}, no questions`;
  const out = [`governed by: ${r.governingDecisions.join(', ')}`, `${r.questions.length} question(s):`];
  for (const q of r.questions) out.push(`${q.rank}. [${q.check}] ${q.text}`);
  return out.join('\n');
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function changeFromFlags(flags: Record<string, string | boolean | undefined>): Change {
  const sha = str(flags.sha as string | undefined);
  const diff = str(flags.diff as string | undefined);
  if (sha) return { sha };
  if (diff) return { diffFile: diff, base: str(flags.base as string | undefined) };
  return { worktree: true };
}

export async function intakeCli(pos: string[], flags: Record<string, string | boolean | undefined>, root: string): Promise<number> {
  const cmd = pos[0];
  const r = resolve(root);
  if (cmd === 'interrogate') {
    const result = await interrogate(r, changeFromFlags(flags));
    console.log(flags.json ? JSON.stringify(result) : formatInterrogate(result));
    return 0;
  }
  if (cmd === 'check-records') {
    const adrDir = str(flags['adr-dir'] as string | undefined);
    const findings = checkAllRecords(r, { adrDirs: adrDir ? adrDir.split(',') : undefined });
    console.log(flags.json ? JSON.stringify(findings) : formatFindings(findings));
    return 0;
  }
  console.error(`mole intake: unknown subcommand '${cmd}' (want interrogate | check-records)`);
  return 1;
}
