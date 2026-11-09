# Extraction Reproducibility: Experiment Report

Generated 2026-11-09T03:55:23.351Z by scripts/evalReproducibility.ts. Plan: docs/plans/extraction-reproducibility.md.
Bar (Paul, 2026-11-08): pass-specific facts < 5%, coverage disagreement < 5%, fidelity flags at most +2 points (fidelity is not measured here).

## Before (plan section 1) and After (this harness)

| Run | Pass-specific A→B | B→A | Coverage disagreement (500-char / turns) | Boundary share unmatched vs matched | Insights per chunk (A / B) | Identical quotes within one pass (A / B) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (plan, post-consolidation, #183) | 23% | 16% | not measured | 36.6% vs 29.0% | n/a | 21 identical-quote splits | misses the bar |
| baseline-lexical: stored:291281d6 vs stored:3d6c7c5f | 23.5% | 17.1% | 28.6% / 2.5% | 30.5% vs 28.5% | 3.19 / 3.19 | 1 / 0 identical (68 / 45 overlapping) | misses the bar |
| E1a: 291281d6:E1a:1 vs 291281d6:E1a:2 | 17.1% | 16.2% | 31.2% / 2.5% | 33.3% vs 32.8% | 3.10 / 3.09 | 1 / 3 identical (56 / 60 overlapping) | misses the bar |
| E1b: 291281d6:E1b:1 vs 291281d6:E1b:2 | 3.6% | 1.4% | 11.6% / 2.6% | 9.1% vs 29.8% | 3.28 / 3.19 | 0 / 1 identical (29 / 29 overlapping) | misses the bar |
| E1b-cross: 291281d6:E1b:1 vs 3d6c7c5f:E1b:1 | 3.1% | 1.4% | 8.7% / 0.0% | 30.0% vs 30.3% | 3.28 / 3.26 | 0 / 3 identical (29 / 34 overlapping) | misses the bar |

Coverage disagreement counts a 500-character window as covered when any resolved quote of the pass touches it. "Turns" bins run from one speaker label to the next; only the host is labelled in these transcripts, so turn bins are coarse (median about 3.5k characters) and the 500-character figure is the stricter one.

## Passes

| Pass | Model | Prompt | Chunking | Context | Hygiene | Gate / repair | Wall clock | Tokens | List-price cost | Plan usage (7-day) before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 291281d6:E1a:1 | claude-haiku-4-5 | v1 | chars | 0 | live (2 spans) | off / off | 11.8 min | 1k in / 670k out / 492k cached | $3.72 | 72% → 73% |
| 291281d6:E1a:2 | claude-haiku-4-5 | v1 | chars | 0 | live (2 spans) | off / off | 11.8 min | 1k in / 639k out / 590k cached | $3.38 | 73% → 74% |
| 291281d6:E1b:1 | claude-opus-5-5 | v2 | chars | 0 | live (3 spans) | on / on | 3.1 min | 0k in / 125k out / 386k cached | $3.55 | 74% → 75% |
| 291281d6:E1b:2 | claude-opus-5-5 | v2 | chars | 0 | live (2 spans) | on / on | 2.8 min | 0k in / 120k out / 492k cached | $2.58 | 75% → 75% |
| 3d6c7c5f:E1b:1 | claude-opus-5-5 | v2 | chars | 0 | live (2 spans) | on / on | 2.6 min | 0k in / 120k out / 386k cached | $3.19 | 75% → 75% |

List-price cost is the CLI's own `total_cost_usd` (what the call would cost at API prices, CLI overhead included); on the subscription it is not billed in dollars. The plan-usage column is the share of the 7-day window at the start and end of the pass (best effort, a rounded reading).

## Matches in detail

### baseline-lexical: stored:291281d6 vs stored:3d6c7c5f

- Tier 2 similarity: lexical. Same transcript copy: no (offsets mapped between the two copies).
- Insights: A 217, B 217. Matched by quote A 166, B 180; by meaning A 0, B 0.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 28 (12.9%), B 26 (12.0%).
- Unmatched with no quote located: A 20, B 9.

### E1a: 291281d6:E1a:1 vs 291281d6:E1a:2

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 211, B 210. Matched by quote A 154, B 155; by meaning A 21, B 21.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 25 (11.8%), B 18 (8.6%).
- Unmatched with no quote located: A 6, B 10.

### E1b: 291281d6:E1b:1 vs 291281d6:E1b:2

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 223, B 217. Matched by quote A 192, B 196; by meaning A 23, B 18.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 7 (3.1%), B 3 (1.4%).
- Unmatched with no quote located: A 0, B 0.

### E1b-cross: 291281d6:E1b:1 vs 3d6c7c5f:E1b:1

- Tier 2 similarity: embedding. Same transcript copy: no (offsets mapped between the two copies).
- Insights: A 223, B 222. Matched by quote A 197, B 203; by meaning A 19, B 16.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 6 (2.7%), B 3 (1.4%).
- Unmatched with no quote located: A 0, B 0.
