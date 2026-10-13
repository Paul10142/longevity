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

## Lever 4 (found, not in the brief) — enrich rewrite without the thinking pass: SHIPPED ON, with a thinking fallback

`ENRICH_NO_THINKING` (default on since 2026-10-12, `=0` restores thinking everywhere). `scripts/evalEnrichSpeedup.ts` on Paul's gold pairs, shipped vs no-thinking:
19.7 s → **2.5 s** per call (19.8 → 2.6 s in the two re-runs below); detail coverage 0.861 vs 0.859 (re-runs: 0.866 vs 0.880,
0.874 vs 0.883). The rewritten text is what later facts are judged against, so it shipped off until the guard below was
measured; Paul then chose the fast-first design under "Decision".

### The guard now checks both directions (2026-10-12)

Until now the guard rejected only a number the rewrite *invented*. It did not reject one the rewrite *dropped*. In the first
59-pair run the no-thinking rewrite dropped one number and invented one (the guard caught only the invented one). Now
`droppedSpecifics()` mirrors it: a number carried by a member or the prior canonical and absent from the rewrite → reject,
keep the prior canonical (nothing is lost: members stay linked), and log `[enrich] guard rejected …` with the numbers.

Decisions on false alarms (each has a unit test in `tests/enrichGuard.test.ts`, using gold-pair wording where there is one):

| case | decision |
|---|---|
| `5 mg` / `5 milligrams`, `30-40` / `30 to 40`, `5.0` / `5`, `1,000` / `1000`, `VO₂` / `VO2` | same number — compared as numbers, units and separators ignored |
| `five` / `5`, `three months` / `3 months`; `20%` / `one-fifth`, `50%` / `half` | counted as kept, both directions (a member's "five" also grounds a rewrite's "5", so the old "invented" check is kinder too). "one" is never a quantity when *grounding* |
| a point inside a range the rewrite states (member `35`, rewrite `30–40`) | counted as kept (strictly inside only; endpoints must appear) — known hole: a range from member A can hide a *different* dose from member B (`2 g in children` inside `1–3 g in adults`). Zero such cases in 340 rewrites; revisit if it shows up |
| a number only in a member's direct quote | **not required** (quotes are evidence, not canonical text); still counts as grounding for "invented" |
| years (`2019`), `[12]`, `PMID…`, `NCT…`, `Table 2`, `et al. 2018` | not required to survive. A year *followed by a unit* (`2000 mg`, `2000 steps`) is a dose and is required. An *invented* year is still rejected |
| unit exponent `ml·kg⁻¹·min⁻¹` | not a number |
| `90 minutes` → `1.5 hours`, `1:1` → `1 to 1`, `phase 3` → `phase III`, `type 2` → `T2D` | **not handled**: reads as dropped, rewrite rejected. Costs one enrichment (the detail stays in the evidence list), never data |

### Measured with the new check (2026-10-12; records `eval/judge-speedup-runs/enrich-eval-guard*.{txt,json}`)

| run | mode | rewrites | rejected | dropped a number | invented one | digit dropped before the guard → in the canonical after it | s/call |
|---|---|---|---|---|---|---|---|
| 60 gold pairs (59 usable) | shipped | 59 | 0 | 0 | 0 | 0 → 0 | 19.5 |
| | no thinking | 59 | 0 | 0 | 0 | 0 → 0 | 2.6 |
| the 37 number-bearing gold pairs × 3 | shipped | 111 | **0** | 0 | 0 | 0 → 0 | 19.8 |
| | no thinking | 111 | **3 (2.7%)** | 1 | 2 | 1 → 0 | 2.6 |

- The 1 dropped number (the new check's only hit in 340 rewrites) was real: `~1200 ng/dL` (adult male testosterone) left out of the
  pair that also gave `~400–600 ng/dL`. The 2 invented were the same pair, both repetitions: a made-up worked example
  ("someone weighing ~100 lb (45 kg) would consume ~60 g/day", which is not even arithmetically consistent). Shipped never did either.
- The false-alarm rules above changed no outcome on this sample (a plain "any digit missing" rule gives the same 1 of 340); the equivalences
  are covered by the unit tests, not by the gold set.
- Also noticed, not covered by any number guard: on pair `50fe5b5a` no-thinking returned the prior text unchanged on all 3 reps
  (outcome "no change", so the new member's detail stayed buried); shipped enriched it 3/3.

### Decision (Paul, 2026-10-12): fast first, thinking only when the guard rejects — SHIPPED ON

The rule for a bare fast mode was: rejection rate no worse than shipped, and no dropped number reaching the canonical. The second held;
the first did not (3/111 vs 0/111), so the bare mode stays unavailable as a default. Paul chose the fallback instead:
`synthesizeEnrichedCanonical` tries the rewrite without the thinking pass and, **only when the guard rejects it**, re-runs it once
with thinking. What is kept is always a rewrite the guard passed. `[enrich] fast rewrite of claim … rejected, thinking re-run passed (…)`
is logged on each fallback; a rejection of the thinking re-run too is logged as before and keeps the prior canonical.

Measured on the real path (same 37 number-bearing gold pairs × 3, `enrich-eval-fallback.{txt,json}`):

| | rewrites | re-run with thinking | final rejections | digit dropped before guard → in canonical | s per rewrite | detail coverage |
|---|---|---|---|---|---|---|
| thinking always (as before) | 111 | – | 0 | 0 → 0 | **19.7** | 0.875 |
| fast first, thinking on rejection | 111 | 7 (6.3%) | **0** | 0 → 0 | **4.1** | 0.888 |

- 4.8× faster per rewrite, including the 7 re-runs (those cost ~11–41 s each). The re-run rate was 3/111 in the bare-fast run and 7/111 here:
  the fast rewrite varies between runs, so read it as 3–6%.
- The re-runs were real catches, not false alarms: the dropped `~1200 ng/dL` again; the invented "~100 lb (45 kg)" worked example again; and a
  new one — members said "~10-day" and "about two weeks" and the fast rewrite kept only "two weeks" (dropped 10, reproduced 3 of 6 tries).
- On pair `50fe5b5a` the fast rewrite returned the prior text unchanged on all 3 reps (3/111 "no change", vs 0/111 with thinking), so that
  member's detail stayed buried — not a number problem, so the guard cannot see it. **Paul chose to treat that as a second trigger** (2026-10-12):
  a fast rewrite identical to the prior canonical is also re-run with thinking (`fastRejection: "fast rewrite was identical to the prior canonical"`).
  Measured on all 92 gold pairs × 1 (`enrich-eval-fallback2.{txt,json}`): 4/91 rewrites re-run for either reason, **4.1 s** per rewrite (thinking
  always: 20.9 s), 0 final rejections, 0 dropped numbers, 0 left unchanged (thinking-always left 2 of 91 unchanged: those are cases where the
  members add nothing). A re-run that is unchanged again is kept as "no change", at the cost of one wasted ~20 s call.
- The `20%` / `one-fifth` equivalence mattered once on this sample (a thinking rewrite wrote "roughly one-fifth" for a member's `20%`; a
  plain digit comparison would have rejected it).

### The next risk: a dropped qualifier ("in mice", "only in men over 50")

Not built. A word-list check (animal / lab-model words, only / except / unless, population phrases, hedges) was replayed over the
118 stored rewrites from the first run: 0 hits for animal words (none of the gold pairs contains one, so recall cannot be measured at
all); 4 hits for only/except/population, of which 3 are false alarms (`except` → `however`, `unless` → `without`, twice) and 1 is
plausibly real (no-thinking dropped "in men" from the aromatase pair); and 7–8 rewrites losing a hedge word (`may`, `about`, `roughly`),
which is paraphrase more often than loss. A cheap lexical
check would be mostly noise (1 true hit in 4). It needs the claim-level judge (is each member's population/qualifier still true of the canonical?), i.e. a
model call per rewrite; do that, and measure it on pairs that carry qualifiers, if a qualifier drop is ever seen in practice.
Until then this is an unguarded risk on both rewrite modes, not only no-thinking.

## What is not measured

No end-to-end consolidation was run on the new code (the run owned the writer lock until it ended; this work wrote to
nothing). The per-source figures above are projections from the component measurements; the first run on this code
prints the real ones.
