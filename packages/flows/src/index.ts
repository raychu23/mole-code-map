// @mole/flows (T28): what actually runs. Records caller -> callee edges while vitest runs (a Vite transform wraps every
// function body with enter/exit hooks), stores per-test flows under .mole/local/flows, answers `mole flows <file#Symbol>`.
// Edge ids use the static graph's naming (@mole/indexer), so runtime edges sit next to static ones.
export type { FlowRuntime, FlowsMeta, FlowStore, InstrumentResult, RecordOptions, RecordResult, SymbolFlows, TestFlow } from './types.js';
export { instrumentSource } from './instrument.js';
export { installRuntime } from './runtime.js';
export { moleFlowsPlugin, sourceOfBuilt, type FlowsPluginOptions } from './plugin.js';
export { flowsFor, formatFlows, loadFlows, writeFlows } from './store.js';
export { recordFlows } from './record.js';
export { flowsCli } from './cli.js';
