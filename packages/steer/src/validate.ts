// Update validators (Temporal's "Update Validator": a read-only check that accepts or rejects before the write is
// applied -- see (internal reference removed) log/prior-art.md). Kept dependency-free of @mole/decisions on purpose
// (same reasoning as plugins/claude-code/scripts/lib.mjs's own decision parsing: this package must not gain a
// dependency on the decisions package just to spell a decision id, and the check here is intentionally light --
// existence, not the full citator graph).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SteerUpdateRequest } from './types.js';

export const KNOWN_UPDATE_KINDS = ['stop-editing', 'decision-superseded', 'scope', 'note'] as const;
export type UpdateKind = (typeof KNOWN_UPDATE_KINDS)[number];

function decisionIds(root: string): Set<string> {
  const dir = join(root, '.mole', 'decisions');
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const text = readFileSync(join(dir, name), 'utf8');
      const m = /^id:\s*'?([^'\n]*)'?\s*$/m.exec(text);
      if (m) out.add(m[1]!.trim());
    } catch {
      // unreadable record: not a candidate target, not a crash
    }
  }
  return out;
}

/** Accept/reject verdict for an update request; `reason` is set (and only set) when rejected. Never throws. */
export function validateUpdate(root: string, req: SteerUpdateRequest): { accepted: boolean; reason?: string } {
  if (!req.kind || !(KNOWN_UPDATE_KINDS as readonly string[]).includes(req.kind)) {
    return { accepted: false, reason: `unknown update kind '${req.kind}' (known: ${KNOWN_UPDATE_KINDS.join(', ')})` };
  }
  if (!req.text || !req.text.trim()) return { accepted: false, reason: 'update text is required' };
  if (req.kind === 'stop-editing') {
    if (!req.target || !req.target.trim()) return { accepted: false, reason: 'stop-editing requires a target file path' };
    const abs = resolve(root, req.target);
    if (abs !== resolve(root) && !abs.startsWith(`${resolve(root)}/`)) return { accepted: false, reason: `target '${req.target}' is outside the repo` };
  }
  if (req.kind === 'decision-superseded') {
    if (!req.target || !req.target.trim()) return { accepted: false, reason: 'decision-superseded requires a target decision id' };
    const ids = decisionIds(root);
    if (!ids.has(req.target)) {
      return { accepted: false, reason: ids.size ? `no decision '${req.target}' in .mole/decisions (known: ${[...ids].sort().join(', ')})` : `no .mole/decisions directory in ${root}` };
    }
  }
  if (req.kind === 'scope' && (!req.target || !req.target.trim())) return { accepted: false, reason: 'scope requires a target (the file/folder/decision the new scope is about)' };
  return { accepted: true };
}

export const decisionExists = (root: string, id: string): boolean => decisionIds(root).has(id);
export const decisionsDirExists = (root: string): boolean => existsSync(join(root, '.mole', 'decisions'));
