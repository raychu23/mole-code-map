# How we measure

## Summary
This page is Mole's "benchmarks" page: every verified number the project makes, where it came from, and
one result we are not hiding — a pre-registered test where Mole did not show a win. Numbers below are
quoted, not estimated, and are the same ones cited in [`../README.md`](../README.md#verified-numbers-with-sources)
(the published `scripts/public-README.md`) and the [project site](https://raychu23.github.io/mole-code-map/).
Nothing here is extrapolated beyond the stated benchmark's scope. Open: a larger, pre-registered
agent-task run is in progress (see "What we deliberately do not claim" below).

## Method, in order of how much it proves

1. **Component benchmarks** (deterministic, repeatable, no model call) — the no-model decision-conflict
   checker and the incremental argumentation engine. These measure one mechanism in isolation.
2. **Held-out agreement test** (one model as a judge, human-audited for the counts but not every label) —
   the conflict-checker-vs-LLM-judge comparison.
3. **Pre-registered agent-task benchmark** (the highest bar: frozen protocol, paired comparison, real coding
   agent) — the dcbench productivity test. This is the only one of the three designed to show (or fail to
   show) an end-to-end productivity effect, and it is the one with a negative result.

### 1. Test selection vs. running everything

Mole's test-selection feature picked and ran the tests whose coverage touched the changed lines, instead of
the full suite.

| | |
|---|---|
| Regressions caught | 10/10 |
| Share of the suite run | **1.2%** (163/14,065 tests) |

### 2. No-model decision-conflict checker vs. an LLM judge

Mole's deterministic, no-LLM-call conflict checker vs. a Claude-based LLM-judge baseline, same 89 held-out
synthetic changes based on real ADRs across 5 repositories.

| | Mole (no model) | LLM judge |
|---|---|---|
| Caught | 28/29 | 29/29 |
| False alarms | 4/60 | 9/60 |
| Mean estimated inference cost | $0.0054 | $0.0698 (**~13× lower** for Mole) |

Caveat, stated every time this number appears: this is **not** a demonstrated accuracy advantage — the LLM
judge still caught one more — and the judge's labels were not independently human-audited.

### 3. Incremental re-check vs. a full re-solve (argumentation engine)

One ICCMA19 benchmark graph (`admbuster_10000`, one edge removed):

| | Incremental (Mole) | Full re-solve (Carneades) |
|---|---|---|
| p50 | **7.17 ms** | 2,081.87 ms |
| Outcome agreement | 15/15 matching before/after | — |

A second graph (`random-10000`) measured 17.16 ms vs. 36.75 ms — a real but much smaller gap, which is why
the README calls the 7.17 ms/2,081.87 ms pair "a specific benchmark result, not a universal 10k-node claim."

### 4. The pre-registered agent-task benchmark — what we deliberately do not claim

This is the test built to answer the actual product question ("does Mole make an agent's work better"), and
the honest answer from the first full run is **no measurable gain, not statistically significant**.

- **Design, frozen before running**: dcbench, 1 coding agent (`claude-sonnet-5`), 8 tasks × 3 context
  arms × 3 runs = 72 pre-registered runs. Arms: **A** no context, **R** decisions pasted into a plain rules
  file, **M** Mole's hooks/context.
- **Primary metric**: share of available decision-compliance points earned at each task's decision points.

| Arm | Decision-compliance points | Merge-ready diffs (of 24) |
|---|---|---|
| A — no context | 31.7% | 4 |
| R — rules file | 27.6% | 5 |
| M — Mole | 23.6% | 3 |

- **Significance**: paired permutation test on task means (n = 8 tasks) — R vs. M p = 1.0, A vs. M p = 0.375.
  Neither context arm beat no context; none of the differences is significant.
- **What did work**: Mole's hooks named the right decision for 15 of 18 scored checks, and M's runs used
  fewer tokens than A or R (36.2 M vs. 40.3 M and 46.9 M).
- **What did not work and why it matters**: the agent still missed decisions it had just been shown, and in
  this setup the Stop-hook verifier never forced a fix — it is model-free by design (not a model judging the
  agent's work), so it could flag a problem but not block completion.
- **Why we publish this instead of hiding it**: the point of pre-registering the design before running it is
  that we do not get to pick a friendlier metric after seeing the numbers. A tool that only publishes wins it
  found after the fact is not measuring anything. This result is also why neither the README, the site, nor
  any resume line claims a productivity gain from Mole.

### Where each number comes from

Every figure above traces to a source file kept outside this public repository (internal verification notes,
reviewed independently before publication) — not to this page's own prose. If a number here and a number on
the [site](https://raychu23.github.io/mole-code-map/) or in the [README](../README.md) ever disagree, the
README is the canonical copy and this page has drifted; open an issue.

## What's next

- A second, larger pre-registered run (adding a "Mole + a human reviewing the hook's output" arm) is planned
  to test whether the gap between "Mole names the right decision" (15/18) and "the agent acts on it" closes
  with a person in the loop, instead of assuming the Stop hook should force the fix.
- Cross-platform numbers (this release is macOS arm64 only) are not yet collected.
