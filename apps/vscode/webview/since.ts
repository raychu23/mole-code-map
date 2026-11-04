// T15: the panel's "Since you last looked" section, fed by `mole since --json` (T13). Kept out of the map's layout code:
// the host posts {type:'since'} and main.ts writes this HTML into its own container below the map.
import type { SinceChange, SinceEntry, SinceResult } from '@mole/memory';
import { ago, esc } from './render.js';

const MAX_ROWS = 30;

function change(c: SinceChange, now: number): string {
  const t = Date.parse(c.date);
  const when = Number.isFinite(t) ? ago(now - t) : '';
  if (c.commit === 'uncommitted') return `uncommitted edit${when ? ` · ${when}` : ''}`;
  return [`${c.commit.slice(0, 7)} ${c.subject}`, c.author + (c.agent ? ` + ${c.agent}` : ''), when].filter(Boolean).join(' · ');
}

function row(e: SinceEntry, now: number): string {
  const tail = e.symbol.includes('#') ? e.symbol.slice(e.symbol.indexOf('#') + 1) : e.symbol;
  const path = e.newPath ?? e.path;
  const latest = e.changes[0];
  const more = e.changes.length > 1 ? ` (+${e.changes.length - 1} more)` : '';
  const line = e.line ?? 1;
  return (
    `<li class="since-item ${esc(e.status)}" data-path="${esc(path)}" data-line="${line}" title="${esc(`${path}:${line}`)}">` +
    `<span class="sym">${esc(tail)}</span> <span class="st">${esc(e.status)}${e.newPath ? ` → ${esc(e.newPath)}` : ''}</span>` +
    `<div class="what">${latest ? esc(change(latest, now)) : ''}${esc(more)}</div></li>`
  );
}

/** HTML for the section; '' when there is no data (the CLI failed or has not answered yet). */
export function renderSince(r: SinceResult | undefined, now = Date.now()): string {
  if (!r) return '';
  const entries = r.files.flatMap((f) => f.symbols);
  const head = `<div class="since-head">Since you last looked${entries.length ? ` <span class="count">${entries.length}</span>` : ''}</div>`;
  if (r.nothingSeen) return `<section class="since">${head}<div class="since-empty">Nothing recorded yet: a symbol you keep in view for 5 s, hover or write a note on is remembered (.mole/local, never shared).</div></section>`;
  if (entries.length === 0) return `<section class="since">${head}<div class="since-empty">Nothing changed since you last looked (${r.seenCount} symbol${r.seenCount === 1 ? '' : 's'} remembered).</div></section>`;
  const rows = entries.slice(0, MAX_ROWS).map((e) => row(e, now)).join('');
  const rest = entries.length > MAX_ROWS ? `<div class="since-empty">+${entries.length - MAX_ROWS} more: run mole since</div>` : '';
  return `<section class="since">${head}<ul>${rows}</ul>${rest}</section>`;
}
