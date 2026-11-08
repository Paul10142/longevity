# Extraction Reproducibility: Experiment Report

Generated 2026-11-08T21:55:09.987Z by scripts/evalReproducibility.ts. Plan: docs/plans/extraction-reproducibility.md.
Bar (Paul, 2026-11-08): pass-specific facts < 5%, coverage disagreement < 5%, fidelity flags at most +2 points (fidelity is not measured here).

## Before (plan section 1) and After (this harness)

| Run | Pass-specific A→B | B→A | Coverage disagreement (500-char / turns) | Boundary share unmatched vs matched | Insights per chunk (A / B) | Identical quotes within one pass (A / B) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (plan, post-consolidation, #183) | 23% | 16% | not measured | 36.6% vs 29.0% | n/a | 21 identical-quote splits | misses the bar |
| baseline-lexical: stored:291281d6 vs stored:3d6c7c5f | 23.5% | 17.1% | 28.6% / 2.5% | 30.5% vs 28.5% | 3.19 / 3.19 | 1 / 0 identical (68 / 45 overlapping) | misses the bar |

Coverage disagreement counts a 500-character window as covered when any resolved quote of the pass touches it. "Turns" bins run from one speaker label to the next; only the host is labelled in these transcripts, so turn bins are coarse (median about 3.5k characters) and the 500-character figure is the stricter one.

## Passes

| Pass | Model | Prompt | Chunking | Context | Hygiene | Gate / repair | Wall clock | Tokens | List-price cost | Plan usage (7-day) before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

List-price cost is the CLI's own `total_cost_usd` (what the call would cost at API prices, CLI overhead included); on the subscription it is not billed in dollars. The plan-usage column is the share of the 7-day window at the start and end of the pass (best effort, a rounded reading).

## Matches in detail

### baseline-lexical: stored:291281d6 vs stored:3d6c7c5f

- Tier 2 similarity: lexical. Same transcript copy: no (offsets mapped between the two copies).
- Insights: A 217, B 217. Matched by quote A 166, B 180; by meaning A 0, B 0.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 28 (12.9%), B 26 (12.0%).
- Unmatched with no quote located: A 20, B 9.
