// `mole steer signal|update|query|deliver` (T74). Registered in packages/daemon/src/cli.ts as a direct, light entry
// (same reasoning as claims/cli.ts: signal/update/deliver must stay fast -- a hook calls `deliver` on every tool
// call -- so this never loads the LangGraph-backed main index; only `query` does, and only when actually called).
import { deliverPending, queryAgentState, requestUpdate, sendSignal } from './index.js';
import { KNOWN_UPDATE_KINDS } from './validate.js';

const USAGE =
  'usage: mole steer signal --session ID "text" [--from NAME] [--json]\n' +
  '   or: mole steer update --session ID --kind KIND [--target T] "text" [--from NAME] [--json]  (kind: ' + KNOWN_UPDATE_KINDS.join('|') + ')\n' +
  '   or: mole steer query --session ID [--json]\n' +
  '   or: mole steer deliver --session ID [--json]   (hook-internal: pending signals + accepted updates, marked delivered, returned once)\n' +
  '  [--root DIR]';

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export async function steerCli(pos: string[], flags: Record<string, string | true>, root: string): Promise<number> {
  const cmd = pos[0];
  const session = str(flags.session);
  const json = flags.json === true;
  const print = (v: unknown, text: () => string): void => console.log(json ? JSON.stringify(v, null, 2) : text());
  if (!cmd || !['signal', 'update', 'query', 'deliver'].includes(cmd) || !session) {
    console.error(USAGE);
    return 2;
  }
  if (cmd === 'signal') {
    const text = pos.slice(1).join(' ').trim();
    if (!text) {
      console.error(`mole steer signal: text is required\n${USAGE}`);
      return 2;
    }
    const s = sendSignal(root, session, text, { from: str(flags.from) });
    print(s, () => `queued signal ${s.id} for session ${session} (delivered on its next tool call or prompt)`);
    return 0;
  }
  if (cmd === 'update') {
    const kind = str(flags.kind);
    const text = pos.slice(1).join(' ').trim();
    if (!kind || !text) {
      console.error(`mole steer update: --kind and text are required\n${USAGE}`);
      return 2;
    }
    const r = requestUpdate(root, session, { kind, target: str(flags.target), text, from: str(flags.from) });
    print(r, () => (r.accepted ? `accepted update ${r.id} for session ${session} (delivered on its next tool call or prompt)` : `rejected: ${r.reason}`));
    return r.accepted ? 0 : 1;
  }
  if (cmd === 'query') {
    const s = await queryAgentState(root, session);
    print(s, () =>
      s.found
        ? [`session ${s.session} (${s.harness}) ${s.cwd ?? ''}`, `intent: ${s.intent ?? '(none)'}`, `files in play: ${(s.filesInPlay ?? []).join(', ') || '(none)'}`, `decisions in play: ${(s.decisionsInPlay ?? []).map((d) => `${d.id} ${d.title}`).join('; ') || '(none)'}`].join('\n')
        : `mole: no run ${session} (or the prefix is not unique)`,
    );
    return 0;
  }
  const d = deliverPending(root, session);
  print(d, () => (d.signals.length || d.updates.length ? [...d.signals.map((s) => `signal: ${s.text}`), ...d.updates.map((u) => `update (${u.kind}): ${u.text}`)].join('\n') : ''));
  return 0;
}
