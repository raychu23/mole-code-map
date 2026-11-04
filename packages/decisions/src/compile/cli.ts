// `mole compile draft|approve|reject|status` (T46): compile-at-capture's CLI surface. No daemon needed (same shape
// as `mole decisions` / `mole rules`).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { draftChecksFor } from './draft.js';
import { hermesLlmClient } from './llm.js';
import { allDrafts, approveDraft, getVersion, listVersions, rejectDraft, saveDraft } from './store.js';
import type { CompiledDraft, LlmClient } from './types.js';
import { loadGraph } from '../graph.js';
import { contentAnchorsOf } from '../check/options.js';

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function formatDraft(d: CompiledDraft): string {
  return (
    `${d.decision} v${d.version} [${d.status}] ${d.scope.length} scope, ${d.match.length} match, ${d.rules.length} rules, ` +
    `${d.guardTests.length} guardTests, record ${d.recordFile}` +
    (d.status === 'approved' ? ` (approved by ${d.approvedBy} at ${d.approvedAt})` : '') +
    (d.status === 'rejected' ? ` (rejected: ${d.rejectedReason})` : '')
  );
}

/** CLI entry used by packages/daemon/src/cli.ts: `mole compile <draft|approve|reject|status> --id ID ...` */
export async function compileCli(pos: string[], flags: Record<string, string | true>, root: string, llm?: LlmClient): Promise<number> {
  const sub = pos[0];
  const recordsRoot = str(flags.records) ? resolve(str(flags.records)!) : root;
  const id = str(flags.id);
  if (sub === 'draft') {
    if (!id) {
      console.error('usage: mole compile draft --id ID [--from FILE] [--records DIR] [--root DIR] [--json]');
      return 2;
    }
    const graph = loadGraph(recordsRoot, { adrDirs: str(flags['adr-dir'])?.split(',').map((s) => s.trim()).filter(Boolean) });
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) {
      console.error(`mole compile draft: no decision ${id} in ${recordsRoot}`);
      return 2;
    }
    const from = str(flags.from);
    const decisionText = from ? readFileSync(resolve(from), 'utf8') : readFileSync(resolve(recordsRoot, node.file), 'utf8');
    const existingMatch = contentAnchorsOf(recordsRoot, node).map((a) => ({ pattern: a.pattern, ...(a.in ? { in: a.in } : {}), ...(a.why ? { why: a.why } : {}) }));
    const client = llm ?? hermesLlmClient();
    const draft = await draftChecksFor(client, {
      id: node.id,
      title: node.title,
      recordFile: node.file,
      decisionText,
      existingScope: node.scope.map((a) => a.target),
      existingMatch,
    });
    const saved = saveDraft(recordsRoot, draft);
    console.log(flags.json ? JSON.stringify(saved, null, 2) : formatDraft(saved));
    return 0;
  }
  if (sub === 'approve' || sub === 'reject') {
    if (!id) {
      console.error(`usage: mole compile ${sub} --id ID [--version N] ${sub === 'approve' ? '--approver NAME' : '--reason TEXT'}`);
      return 2;
    }
    const version = str(flags.version) ? Number(str(flags.version)) : undefined;
    try {
      if (sub === 'approve') {
        const approver = str(flags.approver);
        if (!approver) {
          console.error('mole compile approve: --approver NAME is required');
          return 2;
        }
        const { recordPath, draft } = approveDraft(recordsRoot, id, { version, approver });
        console.log(flags.json ? JSON.stringify(draft, null, 2) : `approved ${formatDraft(draft)} -> merged into ${recordPath}`);
      } else {
        const reason = str(flags.reason);
        if (!reason) {
          console.error('mole compile reject: --reason TEXT is required');
          return 2;
        }
        const draft = rejectDraft(recordsRoot, id, { version, reason });
        console.log(flags.json ? JSON.stringify(draft, null, 2) : formatDraft(draft));
      }
    } catch (e) {
      console.error(`mole compile ${sub}: ${(e as Error).message}`);
      return 2;
    }
    return 0;
  }
  if (sub === 'status') {
    if (id) {
      const versions = listVersions(recordsRoot, id);
      if (flags.json) console.log(JSON.stringify(versions, null, 2));
      else if (!versions.length) console.log(`mole compile: ${id} has no drafts`);
      else for (const v of versions) console.log(formatDraft(v));
      return 0;
    }
    const all = allDrafts(recordsRoot);
    if (flags.json) {
      console.log(JSON.stringify(all, null, 2));
      return 0;
    }
    const ids = Object.keys(all).sort();
    if (!ids.length) console.log('mole compile: no drafts (run `mole compile draft --id ID` first)');
    for (const i of ids) for (const v of all[i]!) console.log(formatDraft(v));
    return 0;
  }
  console.error('usage: mole compile <draft|approve|reject|status> --id ID ...');
  return 2;
}

export { getVersion };
