// T50 (core-audit agent-surfaces.md rank 2): shared bounded/paginated response helper for Mole's MCP tools that can
// return an unbounded-size array (mole_check hunks, mole_decisions decisions, mole_coverage files). Borrows two
// conventions rather than inventing a third:
//  - limit/offset/has_more/next_offset -- the official MCP pagination convention (mcp-builder's own
//    mcp_best_practices.md: "Always respect limit... Return has_more, next_offset, total_count... Never load all
//    results into memory"). This is the caller's EXPLICIT page.
//  - maxAnswerChars -- Serena's max_answer_chars (serena/src/serena/tools/tools_base.py:258-279
//    _resolve_max_answer_chars/_limit_length): a safety CEILING on the page's own serialized size, independent of
//    what the caller asked for. When the requested page would still serialize over budget, whole items are
//    dropped from the END of the page (never mid-item, never mid-field) until it fits; hasMore/nextOffset move
//    back to cover the dropped items, and `truncated` says why + how to get the rest.
export const DEFAULT_MAX_ANSWER_CHARS = 25_000;

export interface PageArgs {
  limit?: number;
  offset?: number;
  maxAnswerChars?: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  /** set only when maxAnswerChars forced fewer items onto this page than `limit`/the natural remainder would give */
  truncated?: string;
}

/**
 * `toSize(items)` must build the SAME shape the caller is about to put on the wire for just that candidate page
 * (e.g. `(items) => ({ decisions: items })`), so the char budget reflects the real payload, not an arbitrary one.
 */
export function boundedPage<T>(all: T[], args: PageArgs, toSize: (items: T[]) => unknown): PageResult<T> {
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const limit = args.limit !== undefined && args.limit >= 0 ? Math.trunc(args.limit) : undefined;
  const maxChars = args.maxAnswerChars !== undefined && args.maxAnswerChars >= 0 ? args.maxAnswerChars : DEFAULT_MAX_ANSWER_CHARS;
  const end = limit !== undefined ? offset + limit : all.length;
  let items = all.slice(offset, end);
  const requested = items.length;
  while (items.length > 1 && JSON.stringify(toSize(items)).length > maxChars) items = items.slice(0, -1);
  const hasMore = offset + items.length < all.length;
  const truncated =
    items.length < requested
      ? `response cut at maxAnswerChars (${maxChars}): ${requested - items.length} item(s) dropped from this page (never mid-item) -- pass offset: ${offset + items.length} to continue`
      : undefined;
  return { items, total: all.length, offset, hasMore, nextOffset: hasMore ? offset + items.length : undefined, truncated };
}
