# Extraction Reproducibility: Experiment Report

Generated 2026-11-15T21:48:44.861Z by scripts/evalReproducibility.ts. Plan: docs/plans/extraction-reproducibility.md.
Bar (Paul, 2026-11-08): pass-specific facts < 5%, coverage disagreement < 5%, fidelity flags at most +2 points (the fidelity flag rate is in its own section below).

## Before (plan section 1) and After (this harness)

| Run | Pass-specific A→B | B→A | Coverage disagreement (500-char / turns) | Boundary share unmatched vs matched | Insights per chunk (A / B) | Identical quotes within one pass (A / B) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (plan, post-consolidation, #183) | 23% | 16% | not measured | 36.6% vs 29.0% | n/a | 21 identical-quote splits | misses the bar |
| baseline-lexical: stored:291281d6 vs stored:3d6c7c5f | 23.5% | 17.1% | 28.6% / 2.5% | 30.5% vs 28.5% | 3.19 / 3.19 | 1 / 0 identical (68 / 45 overlapping) | misses the bar |
| E1a: 291281d6:E1a:1 vs 291281d6:E1a:2 | 17.1% | 16.2% | 31.2% / 2.5% | 33.3% vs 32.8% | 3.10 / 3.09 | 1 / 3 identical (56 / 60 overlapping) | misses the bar |
| E1b: 291281d6:E1b:1 vs 291281d6:E1b:2 | 3.6% | 1.4% | 11.6% / 2.6% | 9.1% vs 29.8% | 3.28 / 3.19 | 0 / 1 identical (29 / 29 overlapping) | misses the bar |
| E1b-cross: 291281d6:E1b:1 vs 3d6c7c5f:E1b:1 | 3.1% | 1.4% | 8.7% / 0.0% | 30.0% vs 30.3% | 3.28 / 3.26 | 0 / 3 identical (29 / 34 overlapping) | misses the bar |
| E2: 291281d6:E2:1 vs 291281d6:E2:2 | 0.8% | 2.5% | 11.8% / 0.0% | 37.5% vs 29.0% | 3.57 / 3.59 | 3 / 1 identical (39 / 35 overlapping) | misses the bar |
| E2-vs-E1b-crossed-1v2: 291281d6:E2:1 vs 291281d6:E1b:2 | 5.3% | 2.3% | 13.3% / 5.0% | 16.7% vs 30.3% | 3.57 / 3.19 | 3 / 1 identical (39 / 29 overlapping) | misses the bar |
| E2-vs-E1b-crossed-2v1: 291281d6:E2:2 vs 291281d6:E1b:1 | 3.7% | 3.1% | 11.7% / 2.5% | 37.5% vs 28.4% | 3.59 / 3.28 | 1 / 0 identical (35 / 29 overlapping) | misses the bar |
| E2-vs-E1b-pass1: 291281d6:E2:1 vs 291281d6:E1b:1 | 2.9% | 2.2% | 9.6% / 2.5% | 25.0% vs 29.7% | 3.57 / 3.28 | 3 / 0 identical (39 / 29 overlapping) | misses the bar |
| E2-vs-E1b-pass2: 291281d6:E2:2 vs 291281d6:E1b:2 | 6.1% | 2.3% | 16.1% / 5.0% | 15.0% vs 29.5% | 3.59 / 3.19 | 1 / 1 identical (35 / 29 overlapping) | misses the bar |

Which coverage definition is the bar? The plan (docs/plans/extraction-reproducibility.md, section 3.1) defines it on speaker turns: "Split the transcript into speaker turns (or 500-character windows when there are no labels)", and the resume criteria (section 0) say "fewer than 5% of speaker turns are covered by one pass but not the other". The 500-character figure is the stricter reading and this report keeps it as its verdict; the turn figure is the plan's literal definition. Which one governs is Paul's call.

Coverage disagreement counts a 500-character window as covered when any resolved quote of the pass touches it. "Turns" bins run from one speaker label to the next; only the host is labelled in these transcripts, so turn bins are coarse (median about 3.5k characters) and the 500-character figure is the stricter one.

## Passes

| Pass | Model | Prompt | Chunking | Context | Hygiene | Gate / repair | Wall clock | Tokens | List-price cost | Plan usage (7-day) before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 291281d6:E1a:1 | claude-haiku-4-5 | v1 | chars | 0 | live (2 spans) | off / off | 11.8 min | 1k in / 670k out / 492k cached | $3.72 | 72% → 73% |
| 291281d6:E1a:2 | claude-haiku-4-5 | v1 | chars | 0 | live (2 spans) | off / off | 11.8 min | 1k in / 639k out / 590k cached | $3.38 | 73% → 74% |
| 291281d6:E1b:1 | claude-opus-5-5 | v2 | chars | 0 | live (3 spans) | on / on | 3.1 min | 0k in / 125k out / 386k cached | $3.55 | 74% → 75% |
| 291281d6:E1b:2 | claude-opus-5-5 | v2 | chars | 0 | live (2 spans) | on / on | 2.8 min | 0k in / 120k out / 492k cached | $2.58 | 75% → 75% |
| 3d6c7c5f:E1b:1 | claude-opus-5-5 | v2 | chars | 0 | live (2 spans) | on / on | 2.6 min | 0k in / 120k out / 386k cached | $3.19 | 75% → 75% |
| 291281d6:E2:1 | claude-opus-5-5 | v2 | chars | 0 | live (2 spans) | on / on | 2.8 min | 0k in / 128k out / 355k cached | $3.59 | 19% → 19% |
| 291281d6:E2:2 | claude-opus-5-5 | v2 | chars | 0 | live (2 spans) | on / on | 2.7 min | 0k in / 127k out / 502k cached | $2.76 | 19% → 19% |

List-price cost is the CLI's own `total_cost_usd` (what the call would cost at API prices, CLI overhead included); on the subscription it is not billed in dollars. The plan-usage column is the share of the 7-day window at the start and end of the pass (best effort, a rounded reading).

## Fidelity Flag Rate

Paul's third condition: the fidelity flag rate on the new setup is at most 2 points above PR #59's Opus 5.5 figure (8.9%, so at most 10.9%), so a more complete extraction cannot pass by inventing.
Judge: the production extraction-fidelity judge (lib/extractionFidelity.ts, `judgeFidelity`, the function behind `extraction_fidelity` flagging and PR #59's report), model claude-opus-5-5, prompt fingerprint 74bffb7891. Each insight is judged against the exact chunk text it was extracted from (rebuilt from the pass file and checked against the pass's recorded chunk plan). Flag rate = (ADDED_DETAIL + DROPPED_QUALIFIER + UNRESOLVED_REFERENCE) / insights with a real verdict, the definition PR #59 used. UNSURE counts as judged and not flagged. No database access.

| Judged pass | Setup | Insights | Judged | Flagged | Flag rate (95% interval) | Added detail / Dropped qualifier / Unresolved reference | Unsure | Reference | Difference (points) | Bar (+2 points) | Quote found in chunk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stored:291281d6 | stored: haiku-4-5, prompt v1 | 217 | 217 | 65 | 30.0% (24.3% to 36.4%) | 46 / 19 / 0 | 0 | 33.5% (PR #59, Haiku 4.5 stored) | -3.5 | not held to the bar (old setup) | 100.0% |
| 291281d6:E1a:1 | haiku-4-5, prompt v1, gate off | 211 | 211 | 49 | 23.2% (18.0% to 29.4%) | 34 / 15 / 0 | 0 | 33.5% (PR #59, Haiku 4.5 stored) | -10.3 | not held to the bar (old setup) | 100.0% |
| 291281d6:E1b:1 | opus-5-5, prompt v2, gate on + repair | 223 | 223 | 9 | 4.0% (2.1% to 7.5%) | 8 / 1 / 0 | 1 | 8.9% (PR #59, Opus 5.5 new setup) | -4.9 | meets (+2 or less) | 100.0% |
| 291281d6:E1b:2 | opus-5-5, prompt v2, gate on + repair | 217 | 217 | 15 | 6.9% (4.2% to 11.1%) | 11 / 2 / 2 | 2 | 8.9% (PR #59, Opus 5.5 new setup) | -2.0 | meets (+2 or less) | 100.0% |
| 3d6c7c5f:E1b:1 | opus-5-5, prompt v2, gate on + repair | 222 | 222 | 11 | 5.0% (2.8% to 8.7%) | 9 / 1 / 1 | 0 | 8.9% (PR #59, Opus 5.5 new setup) | -3.9 | meets (+2 or less) | 100.0% |
| 291281d6:E2:1 | opus-5-5, prompt v2, gate on + repair | 243 | 243 | 15 | 6.2% (3.8% to 9.9%) | 13 / 1 / 1 | 1 | 8.9% (PR #59, Opus 5.5 new setup) | -2.7 | meets (+2 or less) | 100.0% |
| 291281d6:E2:2 | opus-5-5, prompt v2, gate on + repair | 244 | 244 | 13 | 5.3% (3.1% to 8.9%) | 11 / 1 / 1 | 1 | 8.9% (PR #59, Opus 5.5 new setup) | -3.6 | meets (+2 or less) | 100.0% |
| **E1b, 3 passes pooled** | new setup | 662 | 662 | 35 | **5.3% (3.8% to 7.3%)** | 28 / 4 / 3 | 3 | 8.9% (PR #59, Opus 5.5 new setup) | **-3.6** | **meets (+2 or less)** | |
| **E2, 2 passes pooled** | new setup | 487 | 487 | 28 | **5.7% (4.0% to 8.2%)** | 24 / 2 / 2 | 2 | 8.9% (PR #59, Opus 5.5 new setup) | **-3.2** | **meets (+2 or less)** | |

- **E1b verdict (3 passes, 662 insights): 5.3% against 8.9%, -3.6 points, meets the +2-point bar;** the whole 95% interval is under the limit.
- **E2 verdict (2 passes, 487 insights): 5.7% against 8.9%, -3.2 points, meets the +2-point bar;** the whole 95% interval is under the limit.
- **What the flags are (heuristic text match on the judge's own reasoning).** Of the E1b pooled flags, 27 of 35 say the chunk never names the speaker; without them the rate is 1.2%. The extractor is told the participants (Host / Guest names) but the judge is shown the chunk only, so a correct "James Clear said …" counts as ADDED_DETAIL. PR #59's figure was measured the same way, so the +2-point comparison is like-for-like; but a prompt that names speakers more or less often moves the flag rate without any change in invention. Judged old-setup passes: stored:291281d6 3 of 65; 291281d6:E1a:1 2 of 49.
- **What the flags are (heuristic text match on the judge's own reasoning).** Of the E2 pooled flags, 23 of 28 say the chunk never names the speaker; without them the rate is 1.0%. The extractor is told the participants (Host / Guest names) but the judge is shown the chunk only, so a correct "James Clear said …" counts as ADDED_DETAIL. PR #59's figure was measured the same way, so the +2-point comparison is like-for-like; but a prompt that names speakers more or less often moves the flag rate without any change in invention. Judged old-setup passes: stored:291281d6 3 of 65; 291281d6:E1a:1 2 of 49.
- The reference is a pooled figure over 8 other episodes (Opus 5.5 ranged 3.6% to 15.4% per episode in PR #59), so one episode's rate is a noisy test of "+2 points": a single episode of about 220 insights has a 95% interval of roughly 3 to 5 points either side.
- "Quote found in chunk" checks that the quote each insight cites occurs in the chunk text the judge saw; anything under about 95% would mean the rebuilt chunks do not match extraction.

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

### E2: 291281d6:E2:1 vs 291281d6:E2:2

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 243, B 244. Matched by quote A 223, B 217; by meaning A 18, B 21.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 0 (0.0%), B 6 (2.5%).
- Unmatched with no quote located: A 0, B 0.

### E2-vs-E1b-crossed-1v2: 291281d6:E2:1 vs 291281d6:E1b:2

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 243, B 217. Matched by quote A 203, B 197; by meaning A 27, B 15.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 11 (4.5%), B 5 (2.3%).
- Unmatched with no quote located: A 0, B 0.

### E2-vs-E1b-crossed-2v1: 291281d6:E2:2 vs 291281d6:E1b:1

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 244, B 223. Matched by quote A 213, B 209; by meaning A 22, B 7.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 8 (3.3%), B 5 (2.2%).
- Unmatched with no quote located: A 0, B 0.

### E2-vs-E1b-pass1: 291281d6:E2:1 vs 291281d6:E1b:1

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 243, B 223. Matched by quote A 217, B 208; by meaning A 19, B 10.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 6 (2.5%), B 5 (2.2%).
- Unmatched with no quote located: A 0, B 0.

### E2-vs-E1b-pass2: 291281d6:E2:2 vs 291281d6:E1b:2

- Tier 2 similarity: embedding. Same transcript copy: yes.
- Insights: A 244, B 217. Matched by quote A 202, B 200; by meaning A 27, B 12.
- Unmatched but the other pass quotes the same passage (consolidation-style misses): A 14 (5.7%), B 4 (1.8%).
- Unmatched with no quote located: A 0, B 0.

## E2: Re-Check After the Anecdote Change (PR #70), 2026-11-15

Setup: episode #183 (source 291281d6), two passes with `main` exactly as merged at `ba2d63c` (Opus 5.5, prompt v2 with PR #70's anecdote wording, gate + repair, 2,400-character chunks, live hygiene, subscription CLI). File-only: no database writes, no jobs, no pipeline run. Passes `291281d6:E2:1` and `291281d6:E2:2`; every figure below comes from the tables above except the supplementary items marked "hand analysis" (small read-only scripts over the pass and match files).

### Against the bar

| Bar | Limit | E1b (before the anecdote wording) | E2 (after) | Verdict |
| --- | --- | --- | --- | --- |
| Pass-specific facts, same copy twice (A→B / B→A) | under 5% | 3.6% / 1.4% | **0.8% / 2.5%** (mean 1.6%) | **Meets** |
| Same, leaving anecdotes out (anecdotes still count toward the bar) | reference only | not reported | 0.5% / 3.0% (n 197 / 198) | Meets |
| Passage coverage disagreement by speaker turns (the plan's written definition, 40 bins) | under 5% | 2.6% | **0.0%** | **Meets** |
| Passage coverage disagreement by 500-character windows (the stricter reading) | under 5% | 11.6% | **11.8%** | **Misses, as E1b did** |
| Fidelity flag rate (28 flagged of 487 insights, both passes pooled) | at most 10.9% (8.9% + 2 points) | 5.3% (35 of 662, 3 passes) | **5.7%** (95% interval 4.0% to 8.2%; pass 1 6.2%, pass 2 5.3%) | **Meets** (-3.2 points against 8.9%) |

Also unchanged or better than E1b: insights per chunk 3.57 / 3.59 (E1b 3.28 / 3.19); same-passage misses 0 / 6 (E1b 7 / 3); identical-quote splits inside one pass 3 / 1 (E1b 0 / 1); every insight's quote found in its chunk (100%); fidelity judge 0 errors. Cost of the two passes: $3.59 + $2.76 list price, 2.8 + 2.7 minutes.

Reading the 500-character figure: E1b and E2 give almost the same number (11.6% and 11.8%) while 97%+ of facts match, so the window figure is mostly about where a quote starts and ends, not about skipped passages. Hand analysis on E2: of the 29 windows covered by one pass only, 22 have the other pass's quote within 250 characters (a boundary effect); 7 of 245 windows (2.9%) have the other pass's nearest quote farther away. E1b: 27 one-pass-only windows, 20 near, 7 of 233 (3.0%) farther. The 500-character figure stays a miss under the stricter reading in both experiments; which definition governs remains Paul's call (see the note under the first table).

### Did the new wording lose or add facts? (hand analysis, E2 against both E1b passes)

The four cross-matches above (E2 pass 1 and 2 against E1b pass 1 and 2) show the same-size noise as two passes of one setup.

| | Pass 1 | Pass 2 |
| --- | --- | --- |
| E2 facts absent from BOTH E1b passes (new with the wording) | 6 of 243 (2.5%): 4 anecdotes, 2 other | 5 of 244 (2.0%): 2 anecdotes, 3 other |
| E1b facts absent from BOTH E2 passes (lost with the wording) | 2 of 223: 0 anecdotes | 2 of 217: 0 anecdotes |

The wording lost two non-anecdote facts per E1b pass (under 1%) and added two to three non-anecdote facts plus two to four anecdotes per E2 pass. Both are inside the pass-to-pass noise.

### Anecdotes (hand analysis)

| | E1b pass 1 / 2 (before the wording) | E2 pass 1 / 2 (after) |
| --- | --- | --- |
| Insights labelled Anecdote | 39 of 223 (17.5%) / 33 of 217 (15.2%) | **46 of 243 (18.9%) / 46 of 244 (18.9%)** |
| Pass-1 anecdotes matched to an anecdote in pass 2 | 30 of 39 (77%) | **42 of 46 (91%)** |
| Pass-2 anecdotes matched to an anecdote in pass 1 | 30 of 33 (91%) | **43 of 46 (93%)** |
| Matched to the same fact but labelled something else in the other pass (pass 1 / pass 2) | 8 / 3 | 3 / 3 |
| Anecdote that only one pass produced | 1 / 0 | 1 / 0 |

The v2 prompt before PR #70 already let an anecdote through when the speaker drew a point from it (39 and 33 in E1b), so the change moved the count from about 15-18% to 18.9% and made the label more consistent (agreement 77% / 91% before, 91% / 93% after). Anecdotes are 46 of the 243 facts that stay out of the corpus.

Label quality, reading all 46 anecdotes of E2 pass 1 and scanning the 197 other facts (statements with story wording such as described, recalled, told, friend, patient: 36; quotes with first-person past tense: 6):

- **Correct (a personal or named-person story): 31 of 46 (67%).** Examples: Clear's friend who lost 110 pounds and was not noticed until 60 pounds; the dog that finally made the 10 PM bedtime stick; Attia deciding to stop biting his nails the day of his first medical-school interview; the water-meter spreadsheet.
- **Wrong, a general fact labelled anecdote: 6 of 46 (13%).** "Mice pressed a lever about 6,000 times an hour" (1:34:2); "the average slot machine player presses the button about 800 times an hour" (1:34:3); "Vietnam soldiers addicted to heroin, 90% fine after returning home" (1:40:1); "found 40 models of human behaviour that split into two categories" (1:29:0); "people who read habit books already have decent habits" (1:63:3 and 1:64:4, a duplicate pair). In the second pass three of these were labelled Explanation or Other, so the label itself is not reproducible for them.
- **Borderline: 9 of 46 (20%).** General observations phrased with "I" or "in my patients" (food is a struggle for most patients, 1:42:0; self-forgiving patients do better, 1:44:1; Attia on mistakes compounding in race cars, 1:46:2; "I haven't met many people whose eating improves after kids", 1:42:1), Attia's observation that CrossFit turned inactive people into impressive ones (1:54:3), a couple's habits shaping each other (1:43:1, part personal and part what other couples told Clear), an illustrative example (Stephie Graff from The Sports Gene, 1:9:2; bread at 7 AM, 1:30:2) and Clear's own style of thinking (1:38:1).
- **The other direction, a personal story left as a plain fact: none clear-cut in the 197.** Two borderline: Clear acting as if he has free will in daily life (Other, 1:8:0; pass 2 labelled it Anecdote) and David Epstein telling Clear what surprised him (Controversy, 1:9:0; pass 2 labelled it Anecdote).

Effect on the corpus: the 6 wrong labels are 2.5% of the 243 facts, which would sit in the held-out pile (kept with their quote, reviewable, one flag flip from re-entering) instead of the articles. One or two personal stories could enter the corpus the other way.

### What I would change (not done: prompt and code are untouched)

1. Tighten the Anecdote definition in the prompt to "what the speaker, or a person the speaker names, personally did, saw or experienced"; research findings, statistics, historical episodes (Vietnam, mice, slot machines) and general observations stay Explanation or Other. Re-measure on #183 afterwards.
2. Nothing else: the three bar numbers that matter hold. The 500-character coverage figure is unchanged from E1b and is a quote-edge effect, so it is not a reason to hold the full extraction unless Paul chooses the stricter definition.
