import os from 'node:os';
import { defineConfig } from 'vitest/config';

// Root-level vitest config (none existed before). Needed because `npm run check`
// (`vitest run` at the workspace root) picks up every `*.test.ts` in the repo by default,
// including frozen bench-fixture corpora that are COPIES of an earlier Mole checkout used
// as test data by other tasks' benches (e.g. packages/decisions/bench/corpora/mole/**).
// Those corpora ship their own test files (so the benches that read them see realistic
// history), but they were never meant to run as live tests from the workspace root — they
// have no sibling `dist/` built there, so every one of them fails with "Cannot find module
// ../src/index.js". This exclude only removes bench-fixture data from discovery; it does not
// touch any package's own `src`/`test` directories or skip any real test.
export default defineConfig({
  test: {
    // T87: the public release export (scripts/export-public.mjs) strips every package's test/ (and bench/)
    // directory -- dev-only, not needed to use or build the published product -- so the exported repo
    // legitimately has zero test files to run; vitest's own default is to exit 1 on that ("No test files
    // found"), which would make the README's documented `npm run check`/`npm test` always fail on a clean
    // export even though nothing is actually broken. This config ships to both repos unchanged, so it
    // only ever matters when there truly are no test files (the export); the private repo always has
    // hundreds and runs them exactly as before.
    passWithNoTests: true,
    // Shared-machine load mitigation (the team 10-30 "fix the blocked"): several builder
    // tasks (T23/T36/T37) met their own metric gates but got blocked by `npm run check`
    // failing on UNRELATED tests ("Test timed out in 5000ms", vitest-worker onTaskUpdate
    // timeout) under heavy host load from concurrent parallel builders, not from any real
    // test bug. Vitest's own docs: testTimeout defaults to 5_000ms, hookTimeout to 10_000ms
    // (https://vitest.dev/config/testtimeout, https://vitest.dev/config/hooktimeout) — both
    // are wall-clock budgets, not acceptance criteria, so raising them under contention is
    // sound per metric-gated-build-loop skill R2 ("a test's wall-clock budget is not an
    // acceptance criterion unless the contract names a speed"). Default pool is `forks`
    // (https://vitest.dev/config/pool, https://vitest.dev/config/poolOptions); capping
    // maxForks to half the CPU count reduces contention between concurrently-scheduled
    // worker processes competing for the same cores (https://v3.vitest.dev/guide/cli —
    // poolOptions.forks.maxForks).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      forks: {
        maxForks: Math.max(1, Math.floor(os.cpus().length / 2)),
      },
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/bench/corpora/**',
      '**/bench/**/corpora/**',
      'evals/inspect/**',
      // .mole/local is gitignored per-machine scratch (verification-skill fixtures that are broken on purpose);
      // it must never run as part of the suite (T42 found `npm run check` red from .mole/local/verify-fixtures).
      '.mole/local/**',
      // (internal reference removed) is a symlink into shared research material (cloned external
      // repos kept for prior-art lookups, e.g. (internal reference removed) sdlc/.compat/atlas).
      // It ships its own *.test.js files (bun:test, differing suite shapes) that are not
      // Mole tests and were never meant to run from this workspace root.
      '(internal reference removed)',
      // (internal reference removed) is gitignored planning + benchmark material; benchmark case fixtures there (e.g. M-C v3's
      // cases/*-guard.test.ts, meant to run inside a scratch checkout) must never run in the product suite
      '(internal reference removed)',
    ],
  },
});
