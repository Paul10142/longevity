# Consolidation speed-up — what was measured, what shipped (2026-10-12)

Paul's rule: speed up **without changing the merge decisions**. Accuracy first.

## Where the time actually goes

From `pipeline_runs`, 2026-10-12 UTC daytime, ten finished sources (89–244 facts each):
extraction ≈ 8 min per episode; consolidation 5–17 s per fact, ≈ 17–30 min per episode.
Consolidation is the larger half. Per fact, measured separately:

| stage | measured | how often |
|---|---|---|
| library search (`match_claims`) | ~0.2 s | every fact |
| **judge call** (Opus 5.5, bare CLI) | **3.9 s** mean (median 3.7, p90 5.4) on the 282-pair sample | ~40% of facts |
| **enrich-merge rewrite** (Haiku 4.5) | **19.7 s** mean | ~64% of merges |
| embedding + database writes | ~1–2 s | every fact |

Two surprises against the brief: the judge is ~4 s, not ~25 s (the 25.8 s overnight mean was dominated by extraction
calls); and the **enrich rewrite is the single biggest cost**, because the CLI lets Haiku 4.5 think before it
answers (6–7 s → 3 s on one prompt with `MAX_THINKING_TOKENS=0`; 19.7 s → 2.5 s over 59 real pairs under load).

## The accuracy sample (frozen)

`eval/judge-speedup-sample.json`, 282 real pairs, built read-only by `scripts/buildJudgeSample.ts`:
92 of Paul's gold pairs (all labelled SAME), 24 reviews Paul decided himself (17 accepted / 7 rejected),
100 twin-benchmark pairs (25 per band, 0.70 → ≥0.86), 66 random corpus pairs (20 per band; only 6 reached ≥0.86).
116 pairs carry a human label (109 SAME, 7 DIFFERENT). Baseline = the judge as shipped (Opus 5.5, no effort cap,
full candidate list), run twice. Records: `eval/judge-speedup-runs/`. Score with
`scripts/evalJudgeSpeedup.ts compare --base baseline --variant <name>`.

**The judge disagrees with itself.** Re-running identical settings flips 7 of 282 merge decisions (97.5% agreement,
below the 98% target before anything is changed). All 7 are SAME → SAME with the stated confidence straddling the
0.80 bar (0.72/0.78 vs 0.80); none is SAME ↔ DIFFERENT. Any variant has to be read against that floor.

## Lever 1 — judge several facts of one source at once: SHIPPED, default 4

`lib/judgePipeline.ts`. The judge reads facts i+1…i+3 while fact i is written. Writes land strictly in order, and a
verdict is used only if the candidate list, re-searched after every earlier write, is identical to the list the judge
was shown (ids, order, statement, context note); otherwise the fact is judged again, as the sequential loop would.
So the judge sees the same input as before and the same rows are written.

- Proof: `tests/judgePipeline.test.ts` — a near-identical pair from one source ends as one claim, a canonical rewritten
  by enrich-merge forces a re-judge, and a randomised property test (60 worlds × concurrency 2/4/8) shows the final
  library and the list each fact was judged on are the sequential run's.
- Speed (same 40 pairs, real judge calls, no writes): 3.5 s/fact → **1.1 s** at 4, 0.5 s at 8.
- Cost: ≤ 8.8% of facts are re-judged at window 4 (upper bound from 1,403 stored facts in 10 Deepgram sources,
  `scripts/estimateStaleRate.ts`). Net on the judge stage ≈ 2.8×.
- Alone it is only ~1.2× on a whole source, because the judge is ~30% of per-fact time.
- Env: `CONSOLIDATION_JUDGE_CONCURRENCY` (1 = the old loop). Each source's log line now reads
  `[consolidate] source …: N fact(s) in Ts = X s/fact (… reused, re-judged …)`; read the real figure there.

## Lever 2 — lower the judge's effort: NOT shipped

| variant | per call | merge decision vs baseline | real flips (SAME↔DIFFERENT/UNSURE) | confidence hops over 0.80 | different target |
|---|---|---|---|---|---|
| baseline run again (noise) | 4.0 s | 97.5% | 0 | 7 | 0 |
| effort medium | 4.1 s (0%) | 96.1% | 0 | 11 | 1 |
| effort low | 3.3 s (**15%**) | **95.0%** | 0 | **14** | 3 |

Low does not clear the bar (twice the noise in hops, 3 pairs merged into a different candidate), and 15% of a 4 s call is
≈ 0.6 s per judged fact. Medium buys no speed. Env `CONSOLIDATION_JUDGE_EFFORT` exists, unset.

## Lever 3 — fewer candidates / skip the judge: NOT shipped

Of 239 baseline merges, 213 went into candidate #1, 16 into #2, 10 deeper — a shorter list loses real merges
(k=1 loses 11%). Skipping the judge when the best candidate scores ≥ S would be wrong on:
S 0.84: 8 of 42; 0.86: 5 of 33 (3 of them pairs the judge kept apart = false merges); 0.88: 2 of 20; only ≥ 0.90 is clean
(0 of 9), and that is 3% of pairs. Skipping would also lose the judge's enrich flag. Nothing to ship.

## Lever 4 (found, not in the brief) — enrich rewrite without the thinking pass: SHIPPED OFF

`ENRICH_NO_THINKING=1`. `scripts/evalEnrichSpeedup.ts`, 59 of Paul's gold pairs, shipped vs no-thinking:
19.7 s → **2.5 s** per call; outcome enriched/no change/rejected 59/0/0 vs 58/0/1 (the guard caught one invented number and
kept the prior text); numbers dropped 0 vs 1; detail coverage 0.861 vs 0.859 (no-thinking keeps ≥10 points less on 8
pairs, ≥10 points more on 6); the wording differs on 55 of 59 (so does any re-run). This is not a merge decision, but
the rewritten text is what later facts are judged against, so it ships off until Paul has read the side-by-sides the
script prints. Projected effect on a typical source (197 facts, 1,093 s): ≈ 1.6× alone, ≈ 2.2× with lever 1.

## What is not measured

No end-to-end consolidation was run on the new code (the run owned the writer lock until it ended; this work wrote to
nothing). The per-source figures above are projections from the component measurements; the first run on this code
prints the real ones.
