// L1 (T13) recorder logic, no vscode import so it is unit-testable: which symbols you looked at (visible >= 5 s, hovered).

export const DWELL_MS = 5000;

/** A symbol's line span in the editor (0-based, inclusive, like vscode.Range lines). tail = 'Class.method' as in @mole/memory. */
export interface SymbolSpan {
  tail: string;
  startLine: number;
  endLine: number;
}

/** What the active editor shows: its repo-relative path, its symbols and its visible line ranges (0-based, inclusive). */
export interface View {
  path: string;
  symbols: SymbolSpan[];
  ranges: Array<{ start: number; end: number }>;
}

export interface SeenHit {
  path: string;
  tail: string;
  how: 'visible' | 'hover';
}

/** The subset of vscode.DocumentSymbol this module reads. */
export interface DocSymbol {
  name: string;
  kind: number; // vscode.SymbolKind
  range: { start: { line: number }; end: { line: number } };
  children?: DocSymbol[];
}

// vscode.SymbolKind values (stable API numbers)
const CLASS = 4;
const METHOD = 5;
const CONSTRUCTOR = 8;
const FUNCTION = 11;
const VARIABLE = 12;
const CONSTANT = 13;

/** Top-level functions/classes/consts and class methods/constructors, named like @mole/memory's tails. */
export function documentSymbolTails(nodes: DocSymbol[]): SymbolSpan[] {
  const out: SymbolSpan[] = [];
  const span = (tail: string, n: DocSymbol): SymbolSpan => ({ tail, startLine: n.range.start.line, endLine: n.range.end.line });
  for (const n of nodes) {
    if (n.kind === CLASS) {
      out.push(span(n.name, n));
      for (const m of n.children ?? []) if (m.kind === METHOD || m.kind === CONSTRUCTOR) out.push(span(`${n.name}.${m.name}`, m));
    } else if (n.kind === FUNCTION || n.kind === VARIABLE || n.kind === CONSTANT) out.push(span(n.name, n));
  }
  return out;
}

/**
 * Spans that count for the 5 s dwell: a class whose members are listed is dropped, because a class is on screen whenever any
 * of its methods is, and recording it would list the whole class after every member change. A class still counts when hovered.
 */
export function dwellSpans(spans: SymbolSpan[]): SymbolSpan[] {
  return spans.filter((s) => !spans.some((o) => o !== s && o.tail.startsWith(`${s.tail}.`) && o.startLine >= s.startLine && o.endLine <= s.endLine));
}

/** The innermost span on a line (hover target). */
export function spanAt(spans: SymbolSpan[], line: number): SymbolSpan | undefined {
  let best: SymbolSpan | undefined;
  for (const s of spans) if (s.startLine <= line && line <= s.endLine && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) best = s;
  return best;
}

interface Pending {
  since: number;
  hit: SeenHit;
}

/** Per-symbol continuous-visibility timers: a symbol is seen once it stays in view for dwellMs; once per visibility period. */
export class DwellTracker {
  private pending = new Map<string, Pending>();
  private fired = new Set<string>(); // fired in the current visibility period

  constructor(readonly dwellMs = DWELL_MS) {}

  /** The editor now shows `view` (undefined = nothing / window unfocused). Returns hits already due at `now`. */
  view(now: number, view: View | undefined): SeenHit[] {
    const visible = new Map<string, SeenHit>();
    if (view)
      for (const s of view.symbols)
        if (view.ranges.some((r) => s.startLine <= r.end && r.start <= s.endLine)) visible.set(`${view.path}#${s.tail}`, { path: view.path, tail: s.tail, how: 'visible' });
    for (const k of [...this.pending.keys()]) if (!visible.has(k)) this.pending.delete(k);
    for (const k of [...this.fired]) if (!visible.has(k)) this.fired.delete(k);
    for (const [k, hit] of visible) if (!this.pending.has(k) && !this.fired.has(k)) this.pending.set(k, { since: now, hit });
    return this.tick(now);
  }

  /** Hits whose dwell completed by `now`. */
  tick(now: number): SeenHit[] {
    const out: SeenHit[] = [];
    for (const [k, p] of this.pending)
      if (now - p.since >= this.dwellMs) {
        this.pending.delete(k);
        this.fired.add(k);
        out.push(p.hit);
      }
    return out;
  }

  /** Earliest time a pending symbol becomes due, if any. */
  nextDue(): number | undefined {
    let due: number | undefined;
    for (const p of this.pending.values()) due = due === undefined ? p.since + this.dwellMs : Math.min(due, p.since + this.dwellMs);
    return due;
  }

  /** Forget completed periods for a path (after a save, so looking at the new body counts again). */
  reset(path: string): void {
    const own = (k: string) => k.startsWith(`${path}#`);
    for (const k of [...this.fired]) if (own(k)) this.fired.delete(k);
    for (const k of [...this.pending.keys()]) if (own(k)) this.pending.delete(k);
  }
}

export interface RecorderOptions {
  enabled: () => boolean; // the mole.recordSeen setting
  write: (hits: SeenHit[]) => void;
  dwellMs?: number;
  now?: () => number;
}

/** DwellTracker + hover events + batching, gated by the setting. */
export class SeenRecorder {
  private readonly tracker: DwellTracker;
  private readonly now: () => number;
  private batch: SeenHit[] = [];

  constructor(private readonly opts: RecorderOptions) {
    this.tracker = new DwellTracker(opts.dwellMs);
    this.now = opts.now ?? Date.now;
  }

  view(view: View | undefined): void {
    const on = this.opts.enabled();
    const hits = this.tracker.view(this.now(), on ? view : undefined);
    if (on) this.batch.push(...hits);
  }

  hover(path: string, tail: string): void {
    if (!this.opts.enabled()) return;
    const last = this.batch[this.batch.length - 1];
    if (last && last.path === path && last.tail === tail && last.how === 'hover') return; // one hover per batch, not one per mouse rest
    this.batch.push({ path, tail, how: 'hover' });
  }

  /** Collect due dwell hits into the batch. */
  tick(): void {
    const hits = this.tracker.tick(this.now());
    if (this.opts.enabled()) this.batch.push(...hits);
  }

  /** Forget completed periods for a path (after a save). */
  reset(path: string): void {
    this.tracker.reset(path);
  }

  pendingCount(): number {
    return this.batch.length;
  }

  /** Hand the batch to write (nothing when disabled or empty). */
  flush(): void {
    if (!this.opts.enabled()) {
      this.batch = [];
      return;
    }
    if (this.batch.length === 0) return;
    const hits = this.batch;
    this.batch = [];
    this.opts.write(hits);
  }
}
