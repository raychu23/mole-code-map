// Cascade at check time (T46): zero-LLM tier first (T27/T32), escalate to ONE LLM call only when a governed scope
// is touched and nothing decided a crisp verdict (FrugalGPT, arXiv:2305.05176).
export type * from './types.js';
export { cascadeCheck, decisionTextFromRecords, type CascadeOptions } from './cascade.js';
export { cascadeCheckCli, formatCascade, SEMANTIC_ROUTE_DEFAULTS } from './cli.js';
export { semanticRouteDocs } from './semantic-docs.js';
export { snapshotWorktree, type WorktreeSnapshot } from './worktree.js';
