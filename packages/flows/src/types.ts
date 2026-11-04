// Shared types of @mole/flows (T28).

/** One test's recorded flow. Edge ids use the static graph's naming (`kind:path#Qualified`, @mole/indexer). */
export interface TestFlow {
  test: string;
  file: string;
  /** [caller id, callee id, times] */
  edges: Array<[string, string, number]>;
  /** functions entered with no instrumented caller (called by the test runner, the event loop, or module code) */
  roots: string[];
  /** first logical call chain seen for each callee in this test, outermost first, ending with the callee */
  paths: Record<string, string[]>;
}

export interface FlowRuntime {
  begin(test: string, file: string): void;
  end(): void;
  flows(): TestFlow[];
  reset(): void;
}

export interface InstrumentResult {
  code: string;
  functions: number;
}

export interface FlowsMeta {
  time: string;
  root: string;
  commit: string;
  files: string[];
  wallMs: number;
  exit: number;
  tests: { passed: number; failed: number };
}

export interface FlowStore {
  dir: string;
  meta: FlowsMeta | null;
  tests: TestFlow[];
}

export interface RecordOptions {
  root: string;
  /** test files (relative to root); default: the repo's whole vitest suite */
  files?: string[];
  /** store dir; default <root>/.mole/local/flows */
  out?: string;
  /** false = plain vitest run with the same wrapper (overhead baseline), nothing recorded */
  instrument?: boolean;
  /** vitest config to extend; default: the root's vitest/vite config if any */
  baseConfig?: string;
}

export interface RecordResult {
  out: string;
  wallMs: number;
  exit: number;
  tests: { passed: number; failed: number };
  flows: number;
}

export interface SymbolFlows {
  target: string;
  ids: string[];
  tests: Array<{ test: string; file: string; path: string[] }>;
  callers: Array<{ id: string; count: number }>;
  callees: Array<{ id: string; count: number }>;
}
