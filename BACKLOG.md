# Backlog

Known outstanding work, captured 2026-07-22 during the v1 dead-code cleanup
(commits `0a37deb`..`ebe3697`). Everything here was verified against the code
or the live database at that time — items are written with enough context to
act on without re-deriving them.

`ARCHITECTURE.md` remains the authoritative design doc; this file is a to-do
list, not a spec. Items already specced there are linked rather than restated.
The v4 synthesis rewrite has its own buildable spec at
[`docs/synthesis-v4-spec.md`](docs/synthesis-v4-spec.md) — Stage 2 below points
there.

---

## ▶ START HERE — execution entry point

> **🌃 2026-08-16 DAY WINDOW — HANDOFF (read this FIRST; supersedes every block below for live state).**
>
> **LIVE STATE (2026-08-16 ~10:45 UTC):** **96/249 sources have insights** (95 succeeded); **18,379 raw
> insights**; active claims **12,997 and about to move for the first time in 29 h** (see the queue bug below).
> `main`==`origin/main`@`7f3aced`, **91/91 tests**, lint at its real baseline (23 problems, 3 pre-existing).
> A **bulk merge-accept is RUNNING** (started 10:31, ~80 merges at ~1.5 min each → finishes ~12:30 UTC).
> **Do not start a second writer until it finishes.**
>
> **⛔ THE FINDING THAT MATTERS THIS WINDOW — extraction was healthy and the library still stopped growing.**
> `claim_next_job()` ordered strictly by `created_at`. `overnightExtract` enqueues `extract_source` in
> batches of 4, and each source's `consolidate_source` job is only created ~an hour later when its extract
> finishes — so every consolidate landed BEHIND the rest of its batch and behind any older extract. At
> ~1 source/hour the queue head stayed extract-only for a full day:
> **21 consolidate jobs queued, oldest 2026-08-15 06:58, never claimed once** (`attempts 0`,
> `started_at NULL`); **no consolidate completed since 2026-08-15 05:08**; **4,114 raw insights (22% of the
> corpus) had no claim_member**; active claims pinned at exactly 12,997 while raw insights grew ~3,500.
> Nothing was failing — the work was simply always last in line, which is why a week of green runs hid it.
> **Fixed + applied: migration `022_consolidate_priority.sql`** (`7f3aced`) claims `consolidate_source`
> first, FIFO within a tier. Queue head verified as the 06:58 consolidate immediately after.
> **Consequence for the plan: "sources extracted" was never the real progress metric — claims are.**
> The next run must drain the 21-source consolidation backlog BEFORE more extraction; with 022 the worker
> now does that by itself.
>
> **RESUME EXTRACTION with:** `npx tsx --env-file=.env.local scripts/overnightExtract.ts --hours 8 --batch 4`
> from the repo root (`/Users/paulclancy/_lifestyleacademy` — the worktree has NO `.env.local`), then attach
> `caffeinate -dims -w <pid>` separately. ONE writer at a time. It will now consolidate first, which is
> slower per source than raw extraction but is what actually produces claims.
>
> **THIS WINDOW SHIPPED:**
> - **ENRICH_MERGE decision TAKEN — Paul chose ON** (`33ac555`; `ENRICH_MERGE=1` set in `.env.local`, which
>   is gitignored — a fresh clone must re-add it). Evidence: `eval/enrich-merge-test.json` — 30/30 rewrites,
>   **0 invented specifics**, **27/30 fully lossless** (the 3 gaps are wording nuance, not facts).
>   **Verified live on real merges**, e.g. a 5-member power-training claim now carries the Type 2A fibre
>   mechanism AND the "starting in the 40s" finding that were previously buried in the drill-down.
>   *Read caution:* `recomputeAggregates` commits the new member_count BEFORE `enrichClaimCanonical` writes,
>   so a claim sampled mid-merge shows the new count with the old sentence — that is a race in the reader,
>   not a lost rewrite.
> - **The merge queue was diagnosed, not just counted:** all 145 pending rows were `SAME` verdicts that fell
>   under `AUTO_MERGE_CONFIDENCE` (0.85) — **83 at 0.82–0.83** (a threshold miss, not a judgement), 57 at
>   0.72–0.78, 5 at 0.60–0.62. Parking them was only ever right while merging was lossy; enrich ends that.
> - **`scripts/acceptNearMissReviews.ts`** (`33ac555`) clears exactly the ≥0.80 band and leaves the **62
>   uncertain rows for Paul** (his call, asked and answered). Dry-run default, backup before apply, survivor
>   resolution through `merged_into_id`, `decided_by: 'auto-accept-near-miss'`, refuses `--apply` while
>   `overnightExtract` runs. Dry run: 83 → 78 merges + 5 already merged elsewhere.
> - **The 38 taxonomy proposals became a decision surface for Paul** (published page; verbatim source stays
>   `scratchpad/discover-dryrun-87-sources-20260815.txt`). Key finding: **8 proposals are cross-batch
>   duplicates** — cancer screening ×4, dementia diagnosis ×3, dementia treatment ×2, female athlete ×2,
>   ultra-processed food ×2, sex differences ×2, obesity/weight ×2 — because each parent shelf is examined
>   with no memory of the others. **38 → ~31 real topics.** Only 1 came from unfiled claims.
>   **Paul's 7 verdicts on the overlap groups are the reshape's input.**
> - **ESLint no longer walks the nested worktree** (`.claude/worktrees/**`): `npm run lint` had been
>   reporting **15,308 problems** against a real baseline of **23**.
>
> **KNOWN GAP (not a bug, worth closing):** `mergeClaims` discards the `EnrichResult`, so a rewrite the
> fidelity guard REJECTS (invented specific → prior canonical kept) is invisible. Log it when convenient;
> `claims.enriched_at` is also still never set by `enrichClaimCanonical`.
>
> **STILL OPEN FOR PAUL:** (1) the **62 remaining merge reviews** at `/admin/reviews` — the 83 are handled;
> (2) the **7 overlap verdicts** on the taxonomy page; (3) topics board: 47 unreviewed.
>
> **NEXT WINDOW'S PHASE — pick ONE:** (a) **restart extraction** and let 022 drain the consolidation backlog
> into claims — re-run the `discover --dry-run` checkpoint only once claims are caught up AND sources ≈110
> (that is ~14 more sources, i.e. two or three windows at ~1 source/hour); or (b) **fidelity-judge
> recalibration** (the 9 confirmed rulings → prompt revision → re-run 40 → re-score), only while extraction
> is idle.
>
> **OPERATIONAL NOTES:** the Bash tool's cwd flips between the repo root and the worktree between turns —
> always `cd /Users/paulclancy/_lifestyleacademy` first. A killed run leaves one `extract_source` row
> `running`; that is self-healing (heartbeat stale >10 min is reclaimable, `lib/jobs.ts`) — never "fix" it
> by hand. Background runs are children of the chat window and die with it; the jobs queue loses nothing.

> **🌆 2026-08-15/16 EVENING WINDOW — HANDOFF (superseded by the block above; kept as dated history).**
>
> **LIVE STATE (2026-08-16 ~01:30 UTC):** **89/249 sources**; 16.4k raw insights → **12,997 active claims**
> (net DOWN from 13,087 — real consolidation); **145 pending merge_reviews, ALL genuine** (Paul reviewing);
> DB **448 MB on Pro**. `main`==`origin/main`@`4e92b37`, build green, **91/91 tests**. An 8 h extraction run
> launched 01:12 UTC (deadline ~09:12 UTC) as a child of the closing chat window — **if it died with the
> window, nothing is lost**; the jobs queue holds everything.
>
> **RESUME EXTRACTION with:** `npx tsx --env-file=.env.local scripts/overnightExtract.ts --hours 8 --batch 4`
> from the repo root (idempotent, drains the queue first; attach `caffeinate -dims -w <pid>` separately —
> wrapping the command in caffeinate can trip the permission classifier). ONE writer at a time, as ever.
>
> **THIS WINDOW SHIPPED (all on main, pushed):**
> - **Junk-review bug KILLED at the source** (`18e9a5e`): when the dedup checker itself is down (usage-limit
>   window / CLI crash), `adjudicate()` now THROWS (`AdjudicationUnavailableError`) so the job fails and the
>   heal loop retries — it no longer files an UNSURE merge_review per insight. The 05:08 outage alone had
>   filed 121 junk rows; that class of queue pollution is over.
> - **The 121 existing junk rows re-adjudicated** (`scripts/readjudicateCheckerErrors.ts`, backup `3576d1c`):
>   **90 auto-merged** (real duplicates the outage had hidden), **15 closed distinct** (+near-dup links),
>   **16 genuine UNSUREs kept** with real verdicts. Queue 253 → 148 pending, all genuine. The script refuses
>   to run while overnightExtract runs (CLI + writer contention).
> - **Fidelity certification CLOSED — Paul's item DONE:** his re-checks kept every original ruling (his
>   exported goldset verified byte-identical to the DB). Official κ = **-0.11 — judge FAILS cert,
>   definitively and two-sided** (flags pairs Paul calls faithful AND missed both his ADDED_DETAIL catches).
>   Shadow mode stays. Next fidelity step: recalibrate the judge prompt using the 9 confirmed disagreements
>   (#4,7,8,9,13,16,18,24,40) as alignment examples, re-run over the 40, re-score. Needs the CLI — never
>   alongside an extraction drain.
> - **The 3 latent silent-truncations FIXED** (`06ad3e2`): flagClaims member batch (was one row-cap away from
>   raising FALSE merge_fidelity flags), flagClaims open-flag report, topic-proposals claim lookup (chunked).
>   **Every bulk-tag prerequisite is now clear.**
> - **⛔ TAXONOMY CHECKPOINT AT 87 SOURCES: NOT STABLE — 38 topics proposed** (the tag job STAYS PARKED).
>   Verbatim list with rationales: `scratchpad/discover-dryrun-87-sources-20260815.txt` (committed).
>   Character: ~all are SPLITS of oversized topics (Medications 121 claims, Behavioral Science 141,
>   Neurodegenerative Disease 146); only 1/38 from unfiled claims; several near-duplicate proposals across
>   parent batches (cancer screening ×3, dementia treatment ×2, female athlete ×2 — discover has no
>   cross-batch dedup, so the reshape round must merge those first).
> - **Overnight supervisor hardened** (`4e92b37`): a total network blip (Supabase fetch failed + CLI
>   unreachable at once) killed the 22:22 UTC run within a minute; a dead round now backs off and retries
>   like a usage-limit stall instead of crashing the process.
>
> **NEXT WINDOW'S PHASE — pick ONE:**
> (a) **Resume extraction toward ~110** (the default; re-run `discover --dry-run` there as the next
>     stability checkpoint), or
> (b) **Fidelity-judge recalibration** (the 9 confirmed rulings → prompt revision → re-run 40 → re-score) —
>     only when extraction is idle.
> The **taxonomy reshape** is Paul-gated curation from the saved 38-proposal list (his reading, the drag
> board, the proposals queue) and runs before any re-tag — but `tag_claims` (`f0e7998d`) stays parked until
> a checkpoint comes back quiet AFTER the reshape.
>
> **PAUL'S OPEN ITEMS:** (1) merge reviews (145) + the **ENRICH_MERGE decision** — his stated goal ("keep
> the new detail without repetition") IS enrich; still the compounding one; (2) skim the 38-proposal list —
> his browse-instinct verdict is the reshape's input; (3) topics board: 47 unreviewed.
>
> **OPERATIONAL NOTES:** background Bash tasks may start in a worktree — prefix pipeline commands with
> `cd` to the repo root (`.env.local` lives there). Extraction throughput ≈ 1 source/hour on long Drive
> episodes. Claude-in-Chrome was not connected this session (fidelity recovery worked around it).

> **🌙 2026-08-15 MORNING — HANDOFF (superseded by the block above; kept as dated history).
> Extraction STOPPED cleanly for a window change; ~26 queued jobs resume on the next run.**
>
> **LIVE STATE (2026-08-15 ~09:00 UTC):** **77/249 sources extracted** (172 pending); 14,835 raw insights →
> **13,087 active claims**; **253 pending merge_reviews** (grows ~25/source — the ENRICH_MERGE decision now
> compounds daily); DB **430 MB on Supabase PRO** (verified `plan: pro`; brake raised to 6000 MB — storage is
> no longer a constraint). Laptop on AC. `main` == `origin/main` @ `1b32e50`, build green, **91/91 tests**.
>
> **RESUME EXTRACTION with:** `caffeinate -dimsu npx tsx --env-file=.env.local scripts/overnightExtract.ts
> --hours 8 --batch 4` — idempotent; drains the queued backlog first. ONE writer at a time, as ever.
>
> **THIS SESSION SHIPPED (all on main, pushed):**
> - **Vercel cron (the second writer) removed & CONFIRMED dead** — 08-15's 08:40 UTC window watched: zero
>   signature. Production builds from `main` (Paul fixed the production branch; a build log confirmed it).
> - **Speaker attribution end-to-end** (migration 020): every new insight records who said it. Guests inferred
>   from transcript intros when titles lack them (213/249 do); host variants canonicalized; null over guessing.
>   **Working live:** Dan Rader 118 vs Attia 32 on Rader's episode; 796 attributed so far. **Backfill of the
>   ~14k pre-020 insights is a planned pass.** First-run bug (all-Attia attributions) caught + 83 cleared.
> - **Dedup verdict (do NOT relitigate):** full-corpus sweep = 11,502 claims → 14 merges (0.13%), 0 reviews.
>   92% singletons is corpus diversity, NOT broken dedup. Do not lower SWEEP_THRESHOLD.
> - **Fidelity: judge FAILED certification** — Paul's 40 labels vs judge: κ≈-0.1, 9 disagreements (#4,7,8,9,
>   13,16,18,24,40) awaiting Paul's re-check at /admin/fidelity (judge-take toggle on). Paul's measured
>   extraction accuracy 37/40 (92.5%). The split is philosophical: judge enforces "never add true-but-unsourced
>   detail" (Paul's own July rule); Paul's labels were looser. Shadow mode stays. Judge DID catch a real 10x
>   unit error (ng/mL vs ng/dL) on live data — useful, not yet aligned.
> - **Admin overhaul:** /admin = live to-do dashboard (cleared queues collapse); /admin/topics IS the
>   drag-and-drop board (drop chooser replaces flaky Shift; ☐ approve stages sign-offs; audit list at
>   /admin/topics/audit); /admin/fidelity = DB-backed labeling worksheet (+ dashboard tile + verdict guide);
>   sources page shows per-source status; flag buttons de-ambiguated; login placeholder dots removed.
> - **Silent-truncation bug class:** 6 live instances fixed (sources page timeout+counts, insights-review
>   counts+topic filter, export chunk lookup). **3 latent remain — fix BEFORE the bulk tagging pass:**
>   flagClaims open-flag report, flagClaims member batch, topic-proposals claim lookup.
> - **CLI usage-window outage handled** (05:08–07:49 UTC): self-healed; supervisor now pauses fresh enqueues
>   while stalled (`1b32e50`).
> - **229 orphaned topic filings repaired; mergeClaims fixed** (topic-move + paged member read).
> - **tag_claims job still PARKED** (`f0e7998d`, run_after=2027-01-01) for the deliberate re-tag phase.
>
> **PAUL'S OPEN ITEMS:** (1) the 9 fidelity re-checks → then re-score κ; (2) merge reviews + ENRICH_MERGE
> (his articulated goal — "keep the new detail without repetition" — IS enrich; queue grows daily);
> (3) try the topics board on the 47 unreviewed.
>
> **NEXT BUILD STEPS:** (a) resume extraction toward ~90 sources; (b) `discover --dry-run` taxonomy-stability
> checkpoint (read-only) — proposals→0 means tag now, not at 249; (c) fix the 3 latent truncations; (d) bulk
> tag (un-park the job); (e) references/study-linking backfill pass; (f) speaker backfill; (g) synthesis last.

> **🌙 2026-08-14 — HANDOFF (superseded by the block above; kept as dated history).
> The mystery second writer is FOUND and REMOVED.**
>
> **🔴 THE SECOND WRITER WAS THE DAILY VERCEL CRON.** `vercel.json` carried
> `crons: [{ "path": "/api/worker/tick", "schedule": "0 8 * * *" }]`. It fired daily at ~08:40 UTC, ran one
> 300 s function, and was killed at the Vercel `maxDuration` limit — every single day from Aug 2 to Aug 13
> (the write window is a tight, unmistakable `08:40:1x → 08:44:5x`). **Removed in commit `6a1bdc7`, pushed.**
> Re-add it ONLY once `ANTHROPIC_API_KEY` is funded.
>
> **Why it was actively harmful:** cloud code cannot reach the local `claude` CLI, so the cron ran on the
> **API backend, whose key is out of credit** → every dedup adjudicator call failed. Over 12 days it added
> **~1,500 claims with ZERO deduplication** (`merged_into` frozen at 265 — *no merges at all* since Aug 2)
> and filed **159 junk `UNSURE` / 0.00-confidence rows** reading *"Automatic duplicate-check was unavailable
> (checker error)"* — all onto a DB already at 68 % of its cap.
>
> **⛔ CORRECTION — THE SUBSCRIPTION WAS NEVER EXHAUSTED.** The 08-01 block below blames the stalled 9 h run
> on "subscription usage-limit exhaustion" and tells the next window to stop CLI extraction. **That is wrong,
> and it cost this session a wrong plan.** Paul verified **99 % of the subscription remaining**. Local runs
> (`LLM_BACKEND=claude-code`) dedup correctly; only the *cloud* path was ever broken. The stalled run is
> better explained by the DB timeouts. **Do not repeat this misdiagnosis.**
>
> **LIVE STATE (verified vs DB `vgzcrihdxcoozgcqadbt`, 2026-08-14):**
> - **60 / 249 sources extracted** (189 pending). 11,221 raw insights → **9,925 active claims**, of which
>   **1,502 were cron-added without dedup**; **7,417 untagged**.
> - **342 pending `merge_reviews`, but 209 are junk crash rows** → only **~133 are real**.
> - **DB 339 MB / 500 MB.** Tables: claims 168 MB, raw_insights 99 MB, sources 42 MB.
> - **Headroom ≈ 20–25 more sources** (~5 MB/source against the `--max-mb 460` brake). **Supabase Pro is still
>   required to finish the 189** — Paul is buying it shortly.
>
> **RESOLVED / DEBUNKED from the 08-01 block:** `main` == `origin/main`, **0 unpushed** (the "25 unpushed
> commits" warning was stale). **No Cursor agent running.** The unaccounted
> `_admissionsacademy/scripts/reachability-monitor.mjs` **does not exist**.
>
> **⚠ VERIFY IN THE VERCEL DASHBOARD** that the `6a1bdc7` deployment is **Ready** — a cron is only dropped on
> a *successful* production deploy. `npm run build` passes locally; the Vercel CLI is logged out on this
> machine and the Vercel MCP is unauthorized, so it cannot be confirmed from the shell.
>
> **WORK COMPLETED THE NIGHT OF 2026-08-13/14 (all committed + pushed):**
> - **Junk queue cleared:** 209 crash rows **DELETED**, 40 dead-pair rows closed as rejected. Deletion (not
>   rejection) was required — `sweepClaims` skips any pair that already has a review row *regardless of status*
>   (`consolidation.ts`, the UNSURE branch), so rejecting would have permanently blocked re-adjudication. All
>   249 rows backed up to `scratchpad/merge-reviews-junk-backup-20260814.json` (committed). **Queue 342 → 93.**
> - **Scoped re-dedup done:** `scratchpad/sweepCronEra.ts` seeded the keyset cursor to just before the cron era
>   and swept the 1,547 un-deduped claims in **15 min → 51 merges** (first merges in 12 days). Scoping only
>   limits which claims are *iterated*; each is still matched corpus-wide via `match_claims`.
> - **`mergeClaims` fixed** (`61c0b0f`): it never moved `claim_topics` (filings stranded on the retired claim),
>   and the winner-members read was unpaginated (silent short read past 1000 → merge aborts on the PK).
> - **229 stranded topic filings repaired** (`c17aac9`): `scripts/repairOrphanedTopicLinks.ts` (dry-run by
>   default) resolved every one transitively through `merged_into_id` — 22 were chained through a second dead
>   claim. Orphans now **0**; topic counts recomputed.
> - **`/admin` is now a live to-do dashboard** (`911de90`): outstanding-decision counts (merge reviews, topic
>   proposals, accuracy flags, unreviewed topics) + pipeline status + a storage gauge vs the 500 MB cap.
> - **⚠ A `tag_claims` job (`f0e7998d`, enqueued by the cron on 08-04) is PARKED** via `run_after='2027-01-01'`
>   — still `queued`, nothing lost. It would have tagged all 7,414 claims unattended, eaten the night, and
>   raised topic proposals. **Un-park by resetting `run_after` to `now()` when the deliberate re-tag phase runs.**
>
> **⛔ DO NOT "fix" the low merge rate by lowering `SWEEP_THRESHOLD` (0.75). Measured 2026-08-14.**
> ~92% of claims are singletons, which reads like broken dedup. It is not. Nearest-neighbour analysis over
> a 150-claim sample: 35% of claims have a neighbour in the 0.75–0.85 band the sweep already checks, and the
> adjudicator calls them DIFFERENT — correctly. Inspected Zone 2 pairs at **0.82–0.87 similarity** are plainly
> distinct facts (a definition vs a lactate threshold vs a mitochondrial mechanism vs fibre-type recruitment).
> Embeddings cluster by TOPIC; a claim is an atomic FACT, and one topic supports dozens of true statements.
> A full-corpus sweep over the ~7,500 never-swept claims produced a **~0.2% merge rate**, independently
> confirming this. Lowering the floor would buy false merges and review-queue noise — the "wrong-SAME" risk.
> **Many related-but-distinct claims per topic is the raw material for article synthesis, not a dedup failure.**
>
> **SILENT-TRUNCATION BUG CLASS — 5 live instances fixed 2026-08-14, 3 latent ones remain.** PostgREST caps
> every read at 1000 rows and `.range(0, 49_999)` does NOT lift it (see `lib/pagination.ts`). Fixed:
> `/admin/sources` (timeout + counts), `/admin/insights/review` (per-source totals were showing ~1/12 of
> reality; topic filter), `/admin/insights/export` (chunk lookup — ~70% of rows lost transcript context).
> **Still latent, and they GO LIVE when the bulk tagging pass runs** (topics will pass 1000 claims):
> `flagClaims` open-flag report, `flagClaims` 200-claim member batch, topic-proposals claim lookup.
> **Fix these before tagging.** The hot path (`consolidation.ts`) was audited and is clean.
>
> **DO NOT delete the retired claim shells to reclaim storage.** It was on the list, and it is a bad trade:
> ~316 shells ≈ 5 MB (of 500), and deleting them destroys the `merged_into_id` chain that makes every merge
> reversible — the same chain `repairOrphanedTopicLinks.ts` needs to resolve targets. Storage must come from
> **Pro**, not from shredding merge provenance.

> **🌙 2026-08-01 — HANDOFF (SUPERSEDED by the block above; kept as dated history.
> ⚠ Its "subscription exhausted" diagnosis is WRONG — see the correction above).
> Written from a separate window.**
>
> **⚠️ OPEN THIS PROJECT DIRECTLY.** The last two extraction runs were driven from a *different* repo's
> window (`admissionsacademy`) operating on this tree — awkward and error-prone. Start the new window in
> `/Users/paulclancy/_lifestyleacademy`. **ONE pipeline/DB writer only.**
>
> **LIVE STATE (verified vs DB `vgzcrihdxcoozgcqadbt`, 2026-08-01):**
> - **60 / 249 sources extracted** (189 still pending). Corpus: **11,221 raw insights → 9,925 active claims**.
> - **7,417 active claims are UNTAGGED** (`needs_tagging=true`) — every new source ran with `SKIP_TAGGING=1`,
>   so a large re-tag/discover backlog is queued (was ~1,700; now ~7,400).
> - **342 pending `merge_reviews`** (was 167 two days ago; growing).
> - **DB is 339 MB of the 500 MB free-plan cap (~68%).** The storage brake (`--max-mb 460`) will halt
>   extraction before the remaining 189 sources finish → **the Supabase Pro decision is now the gating item.**
> - **⚠ POSSIBLE SECOND WRITER:** active-claim + review counts kept RISING after the extraction runs stopped
>   (8,376 → 9,925 claims). **Check the parked Cursor agent worker on this repo AND any Vercel cron BEFORE
>   starting a new writer** — do not create a two-writer race (the `ebe3697` corruption scenario).
>
> **TWO OVERNIGHT EXTRACTION RUNS THIS HANDOFF:**
> - Run 1 (~07-30): healthy — drained 122 jobs, +7 sources (53→60).
> - Run 2 (~07-31→08-01): **STALLED** — ran the full 9h but added **0 sources**, only +67 raw insights /
>   +3 claims / 21 jobs drained, and threw repeated DB **TimeoutErrors** (heartbeat + insert). Likely cause:
>   **subscription usage-limit exhaustion + DB strain** (timeouts track the 339 MB DB). Back-to-back 9h CLI
>   runs now hit diminishing returns → **stop bulk-extracting on the subscription CLI; either top up
>   `ANTHROPIC_API_KEY` (API/Batch backend) or move to Pro, then resume.**
>
> **MERGE-REVIEW QUEUE — reviewed read-only, NOTHING APPLIED.** Of the 167 pending at review time:
> **40 dead** (a claim already merged away — safe to clear), **35 crash rows** (UNSURE / 0.00-confidence,
> adjudicator call failed — junk, clear them), **92 live**. The 92 live `SAME` are **mostly NOT true
> duplicates** — the model's own reasoning says "adds a detail/mechanism/safety-caveat the other lacks", and
> several are outright different facts (APOE risk-multiplier vs baseline incidence; keto-compound liver-enzyme
> caveat vs its dosing; dwarf-mouse 40%-longer vs GH-reversal). **Do NOT bulk-accept** — blanket-merging would
> destroy distinct facts (the "wrong-SAME" risk the notes warn of). Resolution is ONE policy call, not 92
> chores: **ENRICH_MERGE OFF → reject all 92** (keep claims separate, nothing lost); **ON → route to the
> enrich path** (richer phrasing kept, but enrich over-flags ~71% so still spot-check). A handful of true dups
> (e.g. "cycling/swimming don't build bone") can merge. Run the clear/merge pass only when extraction is idle.
>
> **PAUL — DECISIONS PENDING (unchanged, now sharper):**
> 1. **Supabase Pro?** — now GATING: free-tier 339/500 MB + DB timeouts. Without it extraction can't finish 249.
> 2. **`ENRICH_MERGE` on/off** — the 92-row review above is the evidence; it drives the whole merge queue.
> 3. **Recency contradiction-path** — pick an option in `docs/recency-weighting.md`.
> 4. **Label the 40-pair fidelity worksheet** → judge↔human κ (artifact link in the 07-29 block).
> 5. **Verify `ANTHROPIC_API_KEY` credit** — needed to move bulk extraction off the tapped-out CLI.
>
> **NEXT WINDOW — build order:** (a) confirm no other writer is active; (b) decide Pro / API credit, then
> resume extraction for the 189 remaining; (c) once idle, clear the 75 dead+crash reviews + apply the
> `ENRICH_MERGE` decision to the 92; (d) plan the big **re-tag + `discover --dry-run`** pass for the 7,417
> untagged claims (new roots → Paul); (e) housekeeping: **push `main` to origin (25 commits live only on this
> laptop)**, prune the `stoic-blackburn` + `topic-curation` worktrees.

> **🌙 2026-07-29 (overnight) — STATE OF PLAY (single source of truth; keep this coherent with
> memory `v4-build-state`).**
>
> **DONE & merged to `main`:**
> - **Phase-1 extraction fidelity COMPLETE.** 1b validated (6% residual over-reach). 1c wired
>   (`scripts/extract_with_fidelity.sh`) + validated live (#310 → 7/59 shadow-mode flags). 1a
>   worksheet built ([artifact](https://claude.ai/code/artifact/4e9a442b-6d41-4be3-afcf-4941072823ff))
>   — **awaiting Paul's labels** for judge↔human κ (the only Phase-1 item still on Paul).
> - **Recency scoring shipped** (migration 015 + all sources dated). Contradiction/"same-author"
>   half designed + gated in `docs/recency-weighting.md` (needs Paul + a reprocess).
> - **Drive back-catalog ingested: 18 → 249 sources** (231 new non-AMA, dated, timestamped).
> - **Test harness exists** (`npm test`, node:test) — 16 checks on resolveQuote / splitIntoChunks /
>   youtube helpers. First automated tests in the project.
> - **Storage safety brake** (migration 016 + `overnightExtract.ts --max-mb`, default 460) so the
>   free-plan 500 MB read-only lock can't halt the pipeline unattended.
> - **`/admin/flags` review screen** — triage claim_flags (keep / dismiss). Read-only + resolve.
>
> **RUNNING NOW:** `overnightExtract.ts` extracting the pending sources on the subscription CLI
> (batched, limit-reset-resilient; tagging/synthesis/references deferred; idempotent — resume any
> time). ~31/249 processed. **⚠ ONE pipeline/DB writer at a time — do not start a second.**
>
> **⚠ STORAGE GATE:** org is on Supabase **free (500 MB)**; DB ~177 MB. Full catalog (~249) projects
> to ~0.7–1 GB → needs **Pro** or extraction stops ~120 sources in. Paul's decision.
>
> **PARALLEL WORK — DONE & MERGED to `main` (2026-07-29; verified tsc + `npm test` 49/49 + build):**
> ✅ **§2a visibility gate** (`lib/topicVisibility.ts`, thin topics hidden from public; migration 018
> `is_hidden` applied — wire read-side SELECTs to honor it later). ✅ **§3a stale_topics
> recursive-subtree** (migration 017 applied + verified: flags 12 stale topics / 2001 new claims).
> ✅ **§4 deferred-path bugs** (enrichClinician paging, recomputeTopicCounts active-filter,
> discoverTopics reflag persistence + tests). ✅ **§6 sentence-block plumbing** (`lib/blocks.ts` +
> `lib/blockRenderer.ts` + 19 tests; not wired into synthesis yet). Still DEFERRED to an
> extraction-idle window: the §4 HOT-PATH bugs in `consolidation.ts` (mergeClaims topic-move,
> member-read 1000-cap).
>
> **NEXT PHASE after extraction:** bulk re-tag + `discover --dry-run` (new roots → Paul) → Phase-3
> synthesis (the article build; the §2a gate + min-claims gate front it).
>
> **✅ 2026-07-28 — TOPIC CURATION + RE-TAG PHASE COMPLETE & MERGED to `main`.** Full reshape:
> 203 → 77 → **109 active topics**, **9 roots** (Healthy Aging folded), depth 3; re-tag converged
> in one round — **all 2,450 claims filed `good`, 0 unfiled, 0 root proposals**. Fixed a reversed
> cycle guard in `mergeTopics` (also fixes the drag-drop curate tool). **The forward plan is now
> "🔨 BUILD-NEXT PLAN — 2026-07-28" at the END of this file** (extraction fidelity → taxonomy
> maintenance → incremental-update fixes → 7 audited bugs → harness hardening → v4 synthesis).
> Still-open non-curation items from the v3 brief below remain valid: work the merge-reviews at
> `/admin/reviews`, decide `ENRICH_MERGE`, verify `ANTHROPIC_API_KEY` credit.
>
> **🪟 2026-07-27 WINDOW HANDOFF v3 — SUPERSEDED by the ✅ block above; kept as dated history
> (its curation + re-tag to-dos are DONE).**
> Verified against the live DB (`vgzcrihdxcoozgcqadbt`) 2026-07-27. **Pipeline is idle:
> no worker running, 0 open jobs — safe to curate.**
>
> **Done since v2 (dedup phase closed + corpus fully processed):**
> - Dedup phase **merged to `main`** (`03cb8ef`); `~/la-dedup` worktree/branch gone; tree clean.
> - **All 18 sources `succeeded`** (the 7 that were `pending` are now
>   extracted+consolidated). Corpus **2,979 raw insights → 2,450 active claims**, 0 retired shells.
> - **`claim_sweep` ran to completion** (resumable keyset cursor): 90 merges; dedup ~7% → **~18%**
>   (singletons 93% → 83%).
> - Merge-review crash rows cleared (34 stale UNSURE rejected).
>
> **Live state now: 203 active topics, 10 roots, 1,711 unfiled active claims** (unfiled grew from
> 930 as the 7 new sources added claims left untagged via `SKIP_TAGGING=1` during the freeze).
>
> **DECISIONS LOCKED (Paul) — unchanged:**
> - **Build model = staged change-plan**, not immediate-apply. Drag/rename/re-parent accrue a
>   pending plan; one **batch Apply** endpoint commits it (reuse the proven merge logic in
>   `app/api/admin/topics/[id]/route.ts` — M:N `claim_topics` batching + concurrent-tag race).
>   Tool is BUILT: **`/admin/topics/curate`** (commit `0614649`).
> - **Freeze the pipeline, curate now**; re-run discovery/re-tag AFTER the structure is locked.
> - **Target = 7 patient-facing pillars.** Fold **Healthy Aging** into the others; move
>   **Research & Evidence** + **Public Health & Policy** into a separate/later process. Remaining 7:
>   Exercise, Nutrition, Sleep, Medications & Supplements, Mental Health & Cognition, Reducing Risks,
>   Reproductive & Hormonal Health.
> - **Reference layout = peterattiamd.com/topics** — shallow (3-6 subtopics/pillar, "All X"
>   catch-alls), Hormones filed *under* Risks. Target shape for discovery + curation.
> - Taxonomy rule unchanged: fewer topics, **max 3 levels**, merge up later.
>
> **RUNNING TO-DO (next window; reply in `standard-report-format`):**
> - [ ] **Curate the tree to 7 pillars** at `/admin/topics/curate` (staged plan → Apply), keeping
>       the pipeline FROZEN: fold **Healthy Aging** in; move **Research & Evidence** +
>       **Public Health & Policy** to a later process; prune **Reproductive & Hormonal Health**'s
>       **26 children** (the sperm micro-topics); flatten remaining **L4 topics to max-3**.
> - [ ] **After the tree locks, unfreeze:** `discover --dry-run` → apply → re-tag the
>       **1,711 unfiled** claims. Do NOT run `pipeline work`/discovery while curating (`ebe3697`
>       claim-link race).
> - [ ] **Re-run the parked `discover_topics`** (job `052d93ef`, still `failed`/frozen) only after
>       curation locks.
> - [ ] **Work the 70 pending merge-reviews** at `/admin/reviews` (69 SAME + 1 UNSURE). Non-blocking.
> - [ ] **Decide `ENRICH_MERGE` on/off** — engine validated sound (κ=1.0, 0% false-merge, 100%
>       recall) but over-flags enrich ~71%; still OFF pending Paul. Dedup floor stays **0.75**.
> - [ ] **Verify `ANTHROPIC_API_KEY` credit** before relying on the `api` backend — it was OUT OF
>       CREDIT (API + deployed Vercel worker dead; local subscription CLI only).
> - [ ] **Deferred:** extract any newly-ingested sources (ingest does not auto-queue extraction).

**For the agent picking this up in a fresh conversation.** This file is the
work queue; work it top-down by stage. The rule of the project is in one line:
**the system is a de-duplication and assembly engine — it contributes syntax,
never substance. Every statement traces to a claim; every claim traces to a
source.**

Before writing code:

1. **Read [`docs/synthesis-v4-spec.md`](docs/synthesis-v4-spec.md) end to end.**
   It is the design for the central rewrite and it supersedes Stage 2 here.
2. **Read [`docs/v4-build-risks-and-cost.md`](docs/v4-build-risks-and-cost.md).**
   It is the **sequencing authority** — edge cases, cost levers, and a revised
   build order (§D) that resolves ordering traps the spec's §11 doesn't (chiefly:
   re-extract for `start_ms` *before* claim review, or the review is thrown away).
   Where §D and the spec's §11 differ, **§D wins on order**; the spec wins on
   what each step builds.
3. **Read `ARCHITECTURE.md`** for the enduring data model and invariants, and
   `CLAUDE.md` for commands and conventions.
4. **Follow `v4-build-risks-and-cost.md` §D** as the turn-by-turn sequence, using
   the spec for the detail of each step. The Stages below are the high-level map.

Ground rules for this codebase (from `CLAUDE.md`, repeated because they bite):

- Run `npm run build` before considering any step done.
- DB schema changes are numbered SQL in `supabase/migrations_v2/`, applied via
  the Supabase SQL Editor / MCP — there is no local psql.
- Anything touching `topics` or `claims` at scale: **dry-run first, verify
  counts before and after.** A concurrent seed once split the live spine.
- `raw_insights` are immutable. Long work goes through the `jobs` queue with
  checkpoints, never inline in a request handler.
- There is **no test harness and no spend cap yet** — the Phase 0 measurement
  harness (spec §6.1) addresses the first; treat every `generate_topic`-style
  run as real money until a cap exists.

### ⏱ CURRENT STATE — 2026-07-24 (fresh window: read this first)

**Position: Phase 0 complete; Phase 1 in progress.** Roadmap artifact:
`claude.ai/code/artifact/d9036a17-a8eb-4915-9229-4f9bae45f940`.

**Done this session (all type-checked; see recent git log):**
- **Phase 0 instrument** — dedup harness scored; gold set ruled by Paul (92 pairs,
  `eval/dedup-goldset.json`, all SAME/merge, 30 `enrich`); article baselines in
  `eval/article-*-baseline.json` (paragraph + sentence groundedness; sentence g is
  0.30–0.78 on current prose — the floor gets re-derived from this in Phase 3).
- **Enrich-merge + V3 adjudicator — BUILT & live.** `ADJUDICATION_V3`
  (`lib/adjudicationPrompts.ts`): merge liberally (same fact at any detail → SAME),
  emit an `enrich` flag, split ONLY on genuine contradiction. `lib/enrichMerge.ts`:
  rewrite a claim's canonical to carry every member's detail (Haiku, fidelity guard
  rejects invented numbers). Wired in `lib/consolidation.ts`. **Enrich execution is
  OFF by default** — set `ENRICH_MERGE=1` to enable. Tested 30/30 (0 invented).
- **Backbone hardening (the risk register).** `adjudicate()` retries JSON failures,
  then returns UNSURE (surfaced) not a silent DIFFERENT split. `attachMember` and
  `mergeClaims` are idempotent (no more duplicate-key aborts). `extractFromChunk`
  retries. **Spend cap:** `MAX_SYNTHESIS_JOBS_PER_TICK` (30) + `MAX_SYNTHESIS_JOBS`
  (50, in `pipeline work`) — a stray library build can't run unbounded.
  **`SKIP_SYNTHESIS_FANOUT=1`** re-consolidates WITHOUT regenerating articles.
- **Phase 1 timestamp demo — DONE for the YouTube source** (`e24fe6c5`, s-qapZuy0GY):
  timing backfilled (`sources.timed_transcript`, 672 segments), re-extracted under
  V3 with transcript hygiene, **110/110 insights carry `start_ms`**, Evidence
  deep-links to `…&t=<sec>`. Caught + fixed the API-shape bug (segments live at
  `tracks[0].transcript`, not `videoData.transcript`). Migrations **009 (enriched_at)
  and 010 (timed_transcript) APPLIED**. Stuck source `d32c0fc8` reset to `pending`.

### ✅ PHASE 1 COMPLETE — 2026-07-24. Read this block first.

**The corpus is uniform under V3, and two new timestamped episodes are in it.**
Eight sources processed end to end (six rebuilt, two newly ingested), verified on
every invariant:

| check | result |
|---|---|
| sources processed / registered | **8 / 18** |
| insights consolidated | **1310 / 1310** |
| v1-era claims surviving | **0** |
| insights belonging to two claims | **0** |
| `direct_quote`s located verbatim | **1169 / 1169 (100%)** |
| insights carrying `start_ms` | **493** |
| merge-fidelity flags (invented specificity) | **0** |
| active claims | 1199 |

The 141 insights with no quote at all are the resolver correctly declining to
store one it could not verify — the prompt permits null when no single span
supports the insight.

**V3 gold-set score (the live engine, 92 pairs).** `npx tsx
scripts/evalDedup.ts run v3 && … score`:

| prompt | merges | recall | false-merge |
|---|---|---|---|
| v1 — original | 87/92 | 94.6% | 0.0% |
| v2 — strict-split (withdrawn) | 55/92 | 59.8% | 0.0% |
| **v3 — enrich-merge (live)** | **92/92** | **100.0%** | **0.0%** |

**Read those numbers honestly.** All 92 gold labels are `SAME` — Paul ruled merge
on every pair and keep-separate on none. So the false-merge rate is **0 by
construction for all three prompts**: there are no `DIFFERENT` labels to falsely
merge against, and a prompt that merged everything would score identically. The
gold set measures *recall* (does the engine wrongly split — V3 is perfect) and
**cannot measure precision**. The reported `κ = 1.00` for v3 is likewise the
degenerate branch of the Cohen's κ formula, not evidence of agreement: with both
sides single-class the expected-agreement term is 1. This is the "SAME/DIFFERENT
is degenerate for ANN pairs" note above, now demonstrated rather than argued —
the eval must pivot to **merge-fidelity** to say anything about over-merging.

**The one genuinely new signal: V3 flags `enrich` on 59/92 merges (64%), against
Paul's 30/92 (33%).** It wants to rewrite canonicals about twice as often as his
standard calls for. Inert today (`ENRICH_MERGE` is off), but this is the number
to settle before it is ever switched on, since enrich rewrites canonical text.

**Corpus grew from 6 sources to 18** (see the ingest section below): 12 further
full Attia episodes registered with complete per-caption timing, all `pending`.

**Quote provenance is now clean corpus-wide: 1141/1141 quotes located, 0
unverified stored** (was 27% unverifiable-but-stored that morning). The two
old-resolver sources were re-extracted to close it.

#### 🧰 Built while Paul was away (2026-07-24 PM) — deliverables & their state

- **5th flag rule `extraction_fidelity`** (migration 014 applied, `lib/extractionFidelity.ts`,
  `scripts/flagClaims.ts fidelity`). Judges each claim's seed member against its
  chunk; shares the exact judge with the §6.2 eval so they can't drift. **Cost is
  the constraint: ~1 LLM call/claim at ~50s, so a full sweep is ~16h — not the
  design.** §7.2 wants it per new source: `flagClaims fidelity --source <id>`.
  Never run alongside a drain (two CLI consumers throttle). Validated on 12
  claims, 0 false flags; NOT swept corpus-wide.
- **Manual review lane**: `flagClaims flag <claim_id> "note"` /
  `flagClaims resolve <flag_id> <resolution>`. The surface for working the
  unsupported-assertion queue until the mobile inbox (§B4) exists.
- **Dedup gold-label review worksheet (interactive):**
  https://claude.ai/code/artifact/65be336b-8a3e-4642-b2c9-06ceb325fbae — the 57
  unconfirmed labels, each with both statements + the v3 verdict/enrich chip.
  Rule merge / enrich / keep-separate; rulings persist locally and **Export** gives
  JSON to paste back (merges into `eval/dedup-goldset.json` as `confirmed:true`).
  v3 flags enrich on 29 of the 57 — the concrete cases behind the 64%-vs-33%
  question.
- **#374 swapped to the timestamped YouTube upload.** The manual paste
  (`3ce3f8a0`, no timing) was deleted and reconciled (167 claims retired, 0
  memberless left); the YouTube version (`4a4425ae`, 3651 timed segments) is
  queued for extraction. #374's claims will now carry `start_ms` deep-links like
  the rest.
- **4 sources extracted + consolidated** (single worker, supervised): YT #374 +
  Building strength (Exercise), #380 Seed oils (Nutrition), #373 Thyroid
  (hormones). All clean.

**Corpus now: 11 sources processed, 1932 insights, 1792 active claims** — 0
unconsolidated, 0 insights in two claims, **0 unverified quotes**, 1296
timestamped. #374's swap verified: all 186 of its insights carry `start_ms` (the
manual paste had 0). Novelty over the whole corpus: **92% novel, 7% redundant,
1% refinement**; refinement is highest on #380 Seed oils (3%), which overlaps the
protein episodes — the near-duplicate capture working as intended. 7 sources
remain `pending` (breadth ingest — Phase 4 gate). Reference extraction +
`tag_claims` are deferred (the latter until the reshape).

#### ⛔ BLOCKER (2026-07-25): both AI backends are down — Paul must restore one

All AI work is stopped until this is fixed. Nothing else can extract, judge, or
re-tag. Two independent failures:
- **The local `claude` CLI login expired** — "401 OAuth access token has expired".
  Fix: run `claude` (or `/login`) in a terminal and sign in again. This restores
  the subscription-billed path (the default, free against the plan).
- **The API key has no credit** — "credit balance is too low". Fix: add credits at
  the Anthropic console, only needed if you'd rather bill API than re-auth the CLI.

**AUTO-RESUME IS ARMED (2026-07-25, Paul approved).** A background watcher polls
the `claude` CLI every 3 min; the moment Paul re-authenticates it will, with no
further action: (1) validate the extraction fix, (2) release the deferred re-tag +
reference jobs, (3) drain them — re-filing the ~700 claims into the reshaped tree.
It does NOT re-extract the corpus (a separate, larger call). If that watcher has
died (session ended, machine slept), run these by hand after logging in:
```bash
# 1. validate the extraction fix
npx tsx --env-file=.env.local scripts/testExtractionFix.ts
# 2. release the deferred re-tag + reference jobs, then drain
#    (releases anything with a future run_after, then processes it)
npm run pipeline -- work            # after releasing; see the release one-liner in scratchpad/auto-resume.sh
```

Restore EITHER, then the deferred/queued AI work runs. What is waiting on it:
- **Validate the extraction fix**: `npx tsx --env-file=.env.local
  scripts/testExtractionFix.ts` — re-runs the new prompt on the 6 chunks that
  over-reached; the fix is trusted only if invention drops toward 0. Until then
  the new prompt is UNVALIDATED and no re-extraction should use it.
- **Re-tag into the new tree**: release the deferred `tag_claims` (the reshape
  renamed the branches; ~700 untagged claims still need filing).
- Optional: re-extract the existing 11 sources under the validated prompt to clear
  the ~15% over-reach from already-stored facts.

#### ⏭ AFTER RE-TAG: 930 claims want new mid-level branches (topic discovery)

The auto-resume re-tagged the whole corpus into the reshaped tree (2026-07-25):
**862 claims filed `good`, 930 left `unfiled`** (0 `approximate` — the tagger is
binary here). The unfiled span both cohorts (521 new-episode, 413 re-consolidated
original), and 0 remain `needs_tagging`, so the tagger ran fully — it simply found
no existing branch above threshold for half the corpus. The new episodes brought
whole subjects the spine has no branch for yet (thyroid, endometriosis, breast
cancer screening, brain lipidology, seed oils, women's health). **Next step:
`npm run pipeline -- discover --dry-run`** to see the branches the corpus wants,
then apply (new ROOT topics land in the approval queue; children auto-create),
then re-tag. AI-gated (was blocked by the outage) and Paul-gated (approvals).

#### ✅ DECIDED 2026-07-25 (Paul, plain-language Q&A)
- **Extraction over-reach → fix the instructions.** Done in `lib/extraction.ts`
  (absolute FAITHFULNESS rule); UNVALIDATED pending the backend fix above.
- **Taxonomy → 6 pillars, chronic disease nested.** DONE — frontier tree live:
  Exercise, Nutrition, Sleep, Medications & Supplements, Mental Health & Cognition,
  Reducing Risks (diseases nested) + Reproductive & Hormonal Health, Healthy Aging,
  Research & Evidence, Public Health & Policy. Re-tag pending the backend fix.
- **Enrich 64% vs 33% → Paul reviews the worksheet first**, then we analyze his
  rulings and decide whether to change the setting. Worksheet:
  https://claude.ai/code/artifact/65be336b-8a3e-4642-b2c9-06ceb325fbae — export the
  rulings and hand them back.

#### 🔴 EXTRACTION INVENTS SUBSTANCE — measured 2026-07-24 (now being fixed, above)

**`npm run eval:extraction run` over a 40-insight stratified sample: a 15%
INVENTION RATE.** Six insights assert something their source chunk does not
support. Dropped qualifiers: 0. Unresolved references: 0. So the failure is not
omission — **it is addition**, which is the exact principle-1 violation the
product exists to prevent.

Two were verified by hand against the chunk text, and both hold up:

| the insight says | the chunk actually says |
|---|---|
| fibroids "…most remain asymptomatic **and require no intervention**" | *"Up to 70 or 80% of women will have one fibroid. Mostly asymptomatic."* — no management claim whatsoever |
| 2.2 g/kg/day, "with … as an **evidence-based practice target**" | the article presents 2.2 g/kg/day as **the authors' own practice aim** |

The first fabricates a clinical management directive. The second upgrades "what
we do" into "evidence-based", misstating evidence strength — the precise thing a
clinician reading a reference would act on differently. Others in the sample:
naming a specific "hypothalamic-pituitary-testicular axis" where the source said
only that sperm production is brain-driven; inferring "a common
pathophysiological pathway" where the source said risk factors overlap.

**Three things follow, and they matter for sequencing:**

1. **The dedup engine is not the problem.** Merge-fidelity flags: 0. V3 recall:
   100%. The corpus is leaking substance *upstream of consolidation*, exactly the
   "second, unmeasured axis" Paul named on 2026-07-23 — now measured.
2. **Neither implemented flag rule catches this.** `merge_fidelity` is
   numeric-only and these are mostly prose assertions; `standalone` won't fire
   because **these read perfectly clearly** — that is what makes them dangerous.
   §7.2's four rules may need a fifth: extraction fidelity, judged per insight
   against its chunk. That is ~1 LLM call per insight, so it is a real cost
   decision, not a free add.
3. **Ingesting more sources multiplies this.** 10 episodes sit `pending`; at 15%
   they would add roughly 400 unsupported assertions. **This is why they were left
   unextracted** — the gate should be Paul's call now that there is a number.

Caveat, stated plainly: this is the **judge's** rate, not yet certified against
Paul's own rulings (there is no extraction gold set). §7.2's discipline applies —
validate the rubric on a labelled sample before trusting the count. But the two
hand-verified cases suggest it is not merely over-flagging.

Artifacts: `eval/extraction-eval-pairs.json`, `eval/extraction-run.json`.

#### ⏸ Deferred jobs — release these when you pick the work back up

Three job types were pushed out (`run_after` +8–12h) so a finite window went to
extraction and consolidation rather than secondary passes. **They are not lost —
they are queued and will fire on their own once `run_after` passes.** To release
them deliberately:

```sql
-- release everything that was deferred
update jobs set run_after = now() where status='queued' and run_after > now();
```

- `tag_claims` — **keep deferred until the taxonomy reshape lands** (below), or
  ~450 claims get filed into a tree that is about to be replaced.
- `extract_references` / `resolve_references` — safe to release any time. Each
  runs a second full pass over every chunk, roughly doubling a source's cost,
  which is why they were not competing with consolidation.

### ⏱ PHASE 1 EXECUTION LOG — 2026-07-24 (supersedes the "NEXT STEPS 1" plan below)

**Step (a) — YouTube source: DONE.** `e24fe6c5` is **110/110 consolidated,
110/110 timestamped, 0 untagged**. Three defects were found and fixed on the way
(all in the commits after `41e529d`):

- **The 1000-row cap — the one that matters.** `consolidateSource` built its
  "already a member" set with an unpaginated
  `from('claim_members').select('raw_insight_id')`. **PostgREST caps that at 1000
  rows** (`db-max-rows`) and the table held 1023, so the tail was invisible:
  consolidated insights looked pending and were re-adjudicated (one judgment call
  each — the job reported `total: 267` against 35 genuinely-pending insights), and
  because `attachMember`'s upsert only no-ops on the *same* claim, a re-judgement
  landing on a different claim would have made one insight a member of **two**
  claims — provenance split, both counting it. Verified 0 dual memberships, so
  nothing was corrupted. Fixed: membership is looked up per-source in batches of
  200. **`sweepClaims` had the identical bug** (it loads all active claims
  unpaginated) — now paged; at 1000+ active claims it would have swept only the
  oldest and never the newest, i.e. exactly what a fresh source just created.
- **Cascade orphans.** `claim_members.raw_insight_id` is `ON DELETE CASCADE`, so
  `pipeline extract` (which deletes the source's `raw_insights` first) silently
  strips members off every claim seeded from it. Nothing recomputed them: **129
  such claims were already live** from the earlier YouTube re-extractions —
  `status='active'`, `member_count: 1`, still ANN candidates, so V3 insights were
  merging back into ghosts of a *discarded* extraction. Migration **012**
  (`reconcile_claim_membership()`, supersedes 011) recounts partly-emptied claims
  and retires fully-emptied ones; `scripts/pipeline.ts extract` now calls it right
  after the delete. Retire, never delete — ids survive, so published articles
  still resolve, and it is reversible.
- **The harness could not measure the live engine.** `evalDedup` only knew
  `v1`/`v2`; the consolidator runs **V3**. Added `run v3` (+ the `enrich` flag and
  an enrich-rate line in `score`). Also: `extract` now **refuses** to overwrite the
  pairs file while a gold set exists — pair ids are `merge:<raw_insight_id>`, so
  re-extracting after a corpus rebuild would have written pairs no label matches,
  silently discarding Paul's 92 rulings. `eval/README.md` still documented the
  *withdrawn* strict-split labelling rule; corrected to the enrich-merge rule.

**Step (b) — the other 5 sources: IN FLIGHT.** All 5 extractions were queued
**back-to-back before draining**, rather than the per-source `extract` → `work`
loop written below. Reason: consolidation is seeded in order, so with the loop
each source's fresh V3 insights would merge into *v1-era claims* of the sources
not yet re-extracted, and those claims then survive retirement carrying a v1
canonical. Measured, not assumed: after step (a) **28 of the 104 surviving claims
(27%) held a v1-era canonical** backed only by new YouTube insights. Those 28 had
their members detached and were retired, and a `consolidate_source` for the
YouTube source was re-queued so the 30 freed insights get re-adjudicated in-band
(no hand-written canonicals — the engine decides). Starting state for the run:
**76 active claims, 0 v1-era survivors, 110 raw insights.**

Same commands as below, same flags (`SKIP_SYNTHESIS_FANOUT=1`, enrich OFF), just
batched: 5× `npm run pipeline -- extract <id>`, then one
`SKIP_SYNTHESIS_FANOUT=1 npm run pipeline -- work`. The queue is durable — if the
drain dies, re-running `work` resumes from the checkpoints.

**Three more defects, found by the parallel track (spec §6.2 extraction eval).**
Building `scripts/evalExtraction.ts` paid for itself before it ran a single LLM
call — its zero-cost `verify` command, plus the failure it led to:

- **27% of stored `direct_quote`s did not appear in their chunk**, and the old
  code stored them anyway with null offsets. The Evidence panel shows that field
  to a clinician as the source's own words, so this was the system presenting
  unverifiable text as a citation. Not fabrications: 89% *started* in the chunk
  and 41% carried ellipses — the model stitching two non-contiguous spans, which
  the extraction prompt explicitly forbids. `resolveQuote()` now keeps only what
  is verbatim (exact → normalised → all-fragments-verbatim → longest verbatim
  prefix ≥40 chars → drop). Measured before landing: 0 regressions on 152 located
  quotes; of 58 unlocated, 34 recovered whole, 8 as a prefix, 16 dropped.
  Newly-extracted sources now locate **100%**.
- **The CLI was loading this repo's own `CLAUDE.md` into every pipeline call.**
  `claude` discovers `CLAUDE.md` by walking up from its cwd, and the pipeline
  shelled out from inside the repo — so the model answered as a *project
  assistant*: a chunk opening "Hey everyone, welcome to the podcast…" came back
  as *"What would you like me to do with this podcast transcript? Given the
  project context (v4 phase 1 is re-extracting older sources)…"*. It surfaced
  now because the Phase 1 BACKLOG edits above made that auto-loaded context
  richer — the model quoted the plan back. **This is the "CLI intermittently
  returns prose" the retry comments blame; the retries were treating the
  symptom.** `--append-system-prompt` appends and never outranked it; only `cwd`
  does, so `claudeCodeText` now runs from `tmpdir()`. Consequence to respect:
  pipeline prompts must be fully self-contained.
- **That failure was SILENT, which is the worse bug.** `extractFromChunk`
  returned `[]` after exhausting retries — indistinguishable from a chunk with
  nothing in it — so the loop advanced its checkpoint and would have completed
  the source as `succeeded` and empty. 26 of 54 chunks of the Protein Debate
  were burned this way. It now **throws**, so the job fails loudly and the queue
  retries with the checkpoint intact (the rule `adjudicate()` already follows).
  Related: a fresh `extractSource` run now clears the source's prior insights and
  reconciles claims — `pipeline extract` does that before enqueuing, but a job
  restarted from a *reset* checkpoint never goes through that path and would
  append a second copy of every insight.

**Watching the run:** `npm run pipeline -- progress [--watch]` — per-source
chunks / insights / consolidated, observed throughput, and an ETA. Reads only
tables, so polling it costs nothing and never competes with the drain for the
CLI.

### 📥 Source ingestion — built 2026-07-24 (Paul's request, Phase 4 work pulled forward)

```
npm run pipeline -- sources [--limit N]   what is available vs already ingested
npx tsx --env-file=.env.local scripts/pipeline.ts ingest <videoId|url> …
```

(Use `tsx` directly for multi-argument ingest — npm's `--` passthrough collapses
the arguments into one. And note zsh does **not** word-split `$VAR`; use `${=VAR}`.)

`ingest` registers a source with its per-caption timing and deliberately **does
NOT queue extraction** — breadth ingest is Phase 4, gated on the cost checkpoint,
so adding sources must never silently start spending. `extract` stays separate.

**12 full episodes ingested, all `pending`**, 574–3853 timed segments each:
#399 Alzheimer's (Gayatri Devi), #397 Endometriosis (Renato Tomioka), #396 Breast
cancer screening, #395 Brain lipidology, #380 Seed oils (Layne Norton), #378
Women's health, #377 Happiness, #375 Ketogenic diet, #373 Thyroid, Building
strength & muscle, Cardiorespiratory training, Dietary fiber.

Four things worth knowing before ingesting more:
- **Reach is limited by a paywall.** Most episode *pages* on peterattiamd.com are
  members-only and expose no video. The 12 above are all public YouTube uploads.
  Nothing attempts to reach gated content.
- **Clips vs episodes.** The channel is mostly 2-minute promo cuts; `--min-chars`
  (default 20 000) rejects them. It skipped 14 clips (4.7k–18k chars) and kept 12
  episodes (45k–143k) with no manual triage.
- **The transcript API rate-limits** — honoured via Retry-After with a growing
  floor, after a 30-video batch failed everything past the sixth call.
- **One duplicate was caught and dropped**: the YouTube upload of #374 is the same
  episode as an existing manual source. Two rows would inflate `source_count`,
  which still feeds `topic_claims` scoring. Worth noting the YouTube version is
  strictly better provenance (it has timing; the manual paste never will) —
  **upgrading #374 to it is a deliberate re-extract, not something to do silently.**

### 🧱 Phase 2 groundwork — landed 2026-07-24 (migration 013 APPLIED)

Strictly additive: widens the `claims.status` CHECK to admit the v4 vocabulary
(`approved | flagged | archived | merged`) alongside the existing values, and adds
`claim_links` + `claim_flags` (spec §7.2, §6). **Migrates no rows and changes
nothing about what synthesis reads.** The switchover — `active` → `approved` and
teaching `topic_claims()`/`match_claims()` to serve only approved claims — is
deliberately separate: it changes what every reader sees, and §7.4's ordering trap
says bulk-approval runs on the re-consolidated set or the approvals are discarded.

**Near-duplicate capture is now wired** (`linkNearDuplicate` in
`lib/consolidation.ts`): when adjudication keeps a close pair separate — which
under V3 happens only on genuine contradiction or a material difference — the
relationship is recorded instead of discarded. Without it the §9 novelty metric
can only see exact merges and reports refinements as novel ground.

**Open for Paul (raised, not decided):**
- **Phase 0.5 taxonomy reshape is BLOCKED on a doc conflict — this is the main
  thing waiting on you.** §D says **10 branches** (6 pillars + 4); the "Decisions
  already made" list above says **12** (7 pillars + 5, with Chronic Disease as its
  own branch); [[proposed-taxonomy]] says chronic disease **nests under** Reducing
  Risks. The 7th pillar is not derivable from any of them. A reshape rewrites live
  topic structure and forces a re-tag, so it was not guessed at. **`tag_claims` is
  deferred (`run_after` +12h, job `dc11c9d6`) so the ~450 untagged claims are NOT
  filed into the pre-reshape tree** — release it after the reshape, or it wastes a
  tagging pass.
- **`enrich` over-flagging: V3 says 64%, Paul said 33%.** Settle before enabling
  `ENRICH_MERGE=1`.
- **Extracting the 12 new sources is ~17h of unbudgeted compute.** Left `pending`
  on purpose — this is exactly the Phase 4 gate.
- **Two sources still carry old-resolver quotes**: the YouTube video (86.4%
  located) and the protein article (59.4%). They extracted cleanly, so they were
  not reset. `raw_insights` are immutable, so the only fix is re-extraction
  (37 chunks, ~30 min + re-consolidation). Worth it for uniformity on the
  provenance axis, but it is churn on work already reported done — Paul's call.
- **Claim ids changed corpus-wide.** Re-extraction mints new `raw_insights` and
  therefore new claims, so the `claim_ids` stored in existing `topic_articles`
  blocks now dangle. The articles' prose is unaffected (it is stored text) and
  Phase 3 regenerates them, but any Evidence panel that resolves those ids will
  come up empty until then. Inherent to the agreed re-extract decision — flagging
  it because it is reader-visible on a live site, not to reopen it.
- **The tagger created a new topic during step (a).** Phase 0.5's taxonomy
  reshape has not run yet, so this pass files claims into the pre-reshape tree and
  will need re-tagging after. Expected per the ordering below; just don't be
  surprised by drift in the topic list.
- Latent, NOT fixed (Phase 3 territory, `lib/synthesis.ts`): the same 1000-row cap
  applies to the `topic_claims` RPC (called with `p_limit: 2000`) and to
  `enrichClinician`'s `.in('claim_id', …)`. Harmless today — the largest topic has
  **91** claims — but §B3 projects 300–600/topic, and members exceed claims.

**NEXT STEPS (the forward plan):**
1. **Finish Phase 1 — make the corpus uniform under V3.** Everything below runs
   with `SKIP_SYNTHESIS_FANOUT=1` (consolidate + tag, NO article regen) and enrich
   OFF; watch the harness false-merge rate; do NOT generate articles yet. Two parts:
   - **a. Finish the YouTube source** (`e24fe6c5`, 75/110 consolidated — a
     `consolidate_source` job is already **queued**; I stopped the old-code drain
     mid-run to avoid the silent-split adjudicator + premature regen):
     `SKIP_SYNTHESIS_FANOUT=1 npm run pipeline -- work`
   - **b. Re-process the 4 older sources under V3.** ⚠ They are **already 100%
     consolidated under v1**, so `consolidateSource` (which only touches
     un-consolidated insights) skips them — there is **no "re-consolidate only"
     command**. The existing path is to **re-extract**: `npm run pipeline -- extract
     <id>` deletes that source's insights and rebuilds → re-consolidates under V3.
     This is now a mild *improvement*, not waste — re-extraction applies transcript
     hygiene + the JSON-retry. **(Supersedes the earlier "do not re-extract" note,
     which predated those fixes.)** Building a non-destructive re-consolidate path
     is optional. The four: `1ae3e21b` (Longevity 101), `d82e9534` (Protein Debate),
     `debd5a41` (Male fertility), `3ce3f8a0` (Testosterone). `d32c0fc8` (Protein
     quantity) has **0 insights** — it was never extracted; give it a first
     extraction too. For each: `npm run pipeline -- extract <id>`, then
     `SKIP_SYNTHESIS_FANOUT=1 npm run pipeline -- work`.
   *(Optional after: an enrich sweep with `ENRICH_MERGE=1` as a separate pass.)*
2. **Phase 0.5 check** — verify/finish the frontier taxonomy reshape + tagger
   generality bias before any re-tagging (`lib/taxonomy.ts` has partial generality
   logic; confirm against [[proposed-taxonomy]]).
3. **Phase 2 — claim gate** (spec §7): status lifecycle, bulk-approve the
   re-consolidated claims, flag rules, ONE unified review inbox (mobile-first,
   three-way verdict — see below).
4. **Phase 3 — synthesis rewrite** (spec §5, §8): sentence-block schema + renderer,
   per-section audit, re-derive the floor from the sentence baseline, protocol-led,
   experts layer, min-claims gate.
5. **Checkpoint** — cost infra (two-tier adjudication §C3, Batch API §C1, prompt
   caching §C4; spend cap partly done) + Paul reviews the first v4 articles.
6. **Phase 4 — scale** (Vercel Pro, breadth ingest, full build, consensus labelling).

**Framework:** a **sequential backbone** (DB-mutating, one step at a time, Paul-gated:
steps 1→6) plus **parallel tracks** (code-only background agents, no DB mutation):
extraction-fidelity eval (spec §6.2), sentence-block schema+renderer (Phase 3
plumbing), review inbox UI (after the Phase 2 schema). Rule: agents build tools; the
backbone runs the pipeline one step at a time.

**Decisions already made** (do not re-litigate; rationale in the spec / guiding
doc): the seven principles (`ARCHITECTURE.md` top); **audience = physicians
practicing frontier medicine, new to the domain — teach the domain** (spec §2);
**protocol-led — the protocol is the front door, reference is depth-on-demand**
(spec §2, §10); **experts (the guests) are a first-class credibility layer, not
narrated in prose; `source_count` retired as the authority signal** (spec §5.5,
E3); **taxonomy reshaped to 12 frontier branches — 7 pillars + Chronic Disease,
Reproductive & Hormonal Health, Healthy Aging, Research & Evidence, Public Health
& Policy** ([[proposed-taxonomy]], §D Phase 0.5); merge only when materially
identical, near-duplicates linked not fused; claims gated before synthesis;
hold-below-floor with manual approval (floor 0.85 + cap 2, **to be re-derived on
sentence scores — spec §F5**); one unified review inbox, not four queues (§B4);
fix reference resolution, include what resolves; delete the queued `update_topic`
jobs; images in / licensing later; **existing articles left live until
regenerated**; novelty % internal-only, reported as redundant/refinement/novel
buckets; thin topics hidden from readers; **full-breadth launch**; manual editor
edits **prose**; measured dedup accuracy from the start; transcript hygiene strips
ads/intros/outros before extraction; **content-rights (E1) shelved — internal/
educational for now**; **build cost infrastructure before the Phase 4 token
spend** (§D checkpoint).

**Open items that still need Paul** (flag, don't guess — most earlier ones are
now decided above):
- The **final** groundedness floor + cap numbers, once the harness produces
  sentence-level baselines (the 0.85/cap-2 are paragraph-era placeholders).
- Validate the standalone-flag rubric on ~30 claims (spec §F6) — a hands-on
  review task at Phase 2, not a blocker before it.
- Which specific sources to ingest for breadth (Phase 4) — Paul wants the
  existing corpus configured first regardless.
- **Re-judge the 81 provisional-SAME dedup gold labels to Paul's standard**
  (2026-07-23). Paul ruled the 11 contested pairs; the other 81 are still
  `labeled_by:claude`/`confirmed:false` and are **too lenient by his rule** —
  the v2 flip list shows "wrong splits" using the exact "adds a specific → keep
  separate" reasoning Paul endorsed. So v2's 66.7% recall is an artefact of the
  lenient gold, not a weakness. Next labelling pass: re-adjudicate the 81 (or at
  least the ~27 v2 split) to the enrich/keep-separate rule, then the recall
  number is trustworthy and the auto-accept threshold can be set for real.

**Dedup calibration — decided 2026-07-23 (Paul ruled the gold set).**
- **Enrich-merge is the deliverable — NOT v2 (reversed 2026-07-23).** Paul ruled
  the full 92-pair set and confirmed: ENRICH = one merged claim whose canonical is
  updated to carry both sides' detail, even when "basically the same". He ruled
  MERGE on all 92 (30 enrich + 62 plain), keep-separate on none. The eval sampled
  v1's own auto-merges, so this says **v1's merge decisions are sound** (false-merge
  ~0 vs his standard); the failure is **lossy execution** (`attachMember` buries
  the non-seed side). **v2's strict-split fix targeted the wrong failure** (it
  splits pairs Paul wants merged; recall 59.8%) — withdrawn. Build **enrich-merge**
  + a v3 adjudicator (merge liberally, flag enrich, keep-separate only on genuine
  contradiction). SAME/DIFFERENT metric is degenerate for ANN pairs; pivot the eval
  to **merge-fidelity** (does the merged canonical preserve every detail). **Do not
  re-consolidate on v1 or v2 — wait for enrich-merge.** Gold: 92 `label:SAME`, 35
  Paul-confirmed, 57 provisional.
- **Enrich-merge is a required new operation** (spec §6, added). SAME/DIFFERENT
  is too coarse; nested specificity (general + same-principle-with-numbers) must
  become one claim carrying the precise member's phrasing, and today's
  `attachMember` buries it (keeps the seed, not the precise member).
- **Extraction fidelity is a second, unmeasured axis** (spec §6.2, added): the
  paraphrase can drop conceptual qualifiers, and extraction is per-chunk so
  cross-chunk references are lost. Build an extraction-fidelity eval alongside
  the dedup one; do not add missing-but-true detail (principle 1) — that is the
  reference layer's job.
- **Mobile ruling artifact** (throwaway; graduates into the §B4 review inbox):
  https://claude.ai/code/artifact/eef06e6d-9045-4ab3-9000-2edc6f3b8fde — the
  review inbox must be **mobile-first** and support the **three-way verdict**
  (different / same / enrich), not the current binary accept/reject.

---

## Before starting — preconditions, decisions, and what is missing

Audited 2026-07-22 before beginning the plan below. Three gaps were **not
represented anywhere in this file**, and one piece of good news materially
de-risks the largest change.

### Decisions — answered 2026-07-22

1. **Groundedness: hold and require manual approval.** Below the floor an
   article is not published; it waits for Paul. See the section below for what
   the number means and what the floor should be — the policy has a
   prerequisite bug that must be fixed first.
2. **References: fix, and include what resolves.** Partial resolution is
   accepted — some citations are conversational and have nothing linkable.
   Show the ones that resolve; never present an unresolved mention as verified.
   This retires the "or stop presenting it as a feature" branch.
3. **Queued `update_topic` jobs: delete them.** Reasoning below — it is safe,
   and it avoids paying for output that Stage 2 will discard.
4. **Images: include them now, licensing later.** Recorded as a deliberate
   deferral, not an oversight. Revisit before the product is sold, since
   re-used third-party images in a paid product is a rights exposure that grows
   with every article.

---

## Understanding groundedness (the number, not the concept)

Paul asked what the levels actually mean. This is what the code computes, and
what the live numbers say.

### The formula

`lib/synthesis.ts:332` sends every paragraph to Claude with the claims it cites
and asks which paragraphs contain a factual assertion **not** supported by those
claims. Then:

```
groundedness = 1 − (ungrounded paragraphs ÷ total paragraphs)
```

Three consequences follow, and each matters for setting a floor.

**It is a paragraph ratio, not a fact ratio.** A paragraph with one loose clause
counts exactly the same as a paragraph that is wholly invented. So the score is
coarse, and at the margin pessimistic — 0.67 may be three paragraphs each with
one unsupported sentence rather than a third of the article being fiction.

**It is quantized by paragraph count, which makes short articles volatile.**
AMPK Signaling has **5 paragraphs**, so its score can only ever be 0, 0.2, 0.4,
0.6, 0.8 or 1.0. A floor of 0.7 on a 5-paragraph article means, exactly, "at
most one bad paragraph". The same floor on a 29-paragraph article permits eight.

**It measures support, not truth.** A claim can be wrong and the article
perfectly grounded in it. Groundedness says the prose traces to the corpus; it
says nothing about whether the corpus is right.

### What the live numbers say

| Topic | Score | Claims | Paragraphs | Ungrounded |
|---|---|---|---|---|
| AMPK Signaling | 0.40 | 5 | 5 | 3 |
| Cognitive Aging | 0.60 | 8 | 15 | 6 |
| Sleep & Cognition | 0.67 | 8 | 12 | 4 |
| Resistance Training | 0.67 | 16 | 12 | 4 |
| Rough-and-Tumble Play | 0.69 | 9 | 16 | 5 |
| Sleep | 0.70 | 16 | 10 | 3 |
| Mental Health & Psychology | 0.79 | 5 | 24 | 5 |
| Functional Aging | 0.86 | — | 21 | 3 |

**The dominant pattern is thin evidence, not bad writing.** The two worst
articles have the two thinnest claim pools (5 and 8 claims). The prompt tells
the model this is an *"EXHAUSTIVE reference"* with *"no word limit"*
(`lib/synthesis.ts:161`) — so when a topic has five claims, the model writes to
the ambition of the instruction and fills the gap with outside knowledge. That
is precisely what an ungrounded paragraph is.

Note the honest exception: Mental Health & Psychology has 5 claims and 24
paragraphs yet scores 0.79. The correlation is real but not clean, so treat
"thin claims → low groundedness" as the leading explanation, not a law.

**Compare AMPK and Functional Aging: both have 3 ungrounded paragraphs.** One
scores 0.40, the other 0.86. A pure ratio lets a long article carry far more
unsupported assertions than a short one — which for a clinician product is
arguably backwards.

### What the floor should be

**Prerequisite bug — fix this before any hold policy ships.**
`scoreGroundedness` ends with `catch { return 1 }` (`lib/synthesis.ts:355`). A
checker failure returns a **perfect** score. Under "publish everything" that was
merely sloppy; under "hold below the floor" it becomes an auto-approve on error
— the exact inversion of what the gate is for. Make the failure return `null`
and treat null as "hold, unscored".

**Recommendation — three gates rather than one number:**

1. **Ratio floor ≈ 0.85.** Above the current 0.7 (which was never chosen), and
   it holds everything in the table above except Functional Aging.
2. **Absolute cap of ~2 ungrounded paragraphs**, so a long article cannot
   accumulate unsupported assertions while passing on ratio.
3. **A minimum claim count to attempt an article at all** — likely 10–15. This
   attacks the cause rather than the symptom: a 5-claim topic should not be
   generating a physician reference. It should stay a stub until the corpus
   supports it, which also answers the P3.6 "thin branches are reader-visible"
   item.

Gate 3 is the high-value one. Gates 1 and 2 catch bad articles; gate 3 stops
them being written, and stops paying for them.

**This also implies a review queue** — "hold for manual approval" needs
somewhere for held articles to sit, and a UI to approve or reject them. That
work does not exist yet and is not costed anywhere else in this file.

### Why deleting the queued jobs is safe

`stale_topics()` (migration 005.2) is a `stable` SQL function that derives
staleness by comparing `claim_topics.created_at` against the article's
`claims_snapshot_at`. **Staleness is computed, never stored.** Deleting a queued
`update_topic` row therefore discards nothing permanent — the next sweep
recomputes the identical set.

And deleting is the better choice right now: Stage 2 rewrites the prose rules
and the article schema, so every article those jobs would patch is due for full
regeneration anyway. Running them means paying to patch output that is about to
be replaced.

### Still open — the questions that shape the work

Not urgent the way Stage 1 is, but each one changes what gets built, so leaving
them unanswered means guessing.

1. **Which article is the flagship — clinician or patient?** The product is sold
   to physicians, yet the engagement feedback (P1.5 A3) was mostly about the
   patient view. These pull in different directions: the clinician article
   optimizes for exhaustiveness, the patient one for being readable enough to
   finish. Stage 2 effort splits according to the answer.
2. **Where do held articles go, and who approves them?** Implied by decision 1
   above. Needs a review queue and an approve/reject UI that does not exist.
   Does approval publish as-is, or is editing (P1.5 E) part of approving?
3. **Which sources come next?** Stage 3 says "ingest breadth — Exercise, Sleep,
   Nutrition" without naming anything. A concrete list is needed, and it
   determines whether the thin branches fill in.
4. **How big is the library at launch?** Ten strong topics or a hundred thin
   ones is a positioning decision, and it sets the build budget.
5. **Is per-source novelty reader-facing or admin-only?** It is the clearest
   proof the dedup engine works, which argues for showing it to prospects — but
   it also advertises how much of a source was redundant.
6. **Does the manual editor edit prose, or the underlying claims?** Editing prose
   fixes one article; editing a claim fixes everywhere it appears. The second is
   more powerful and much harder.

### Missing infrastructure

#### There are no tests and no CI
No test runner, no `test` script, no `.github/workflows`. Every change so far
has been verified by `npm run build`, type-check, and eye. That was tolerable
while the work was schema and plumbing; it is **not** tolerable for Stage 2,
which rewrites the prompts and the article schema — the highest-value and least
verifiable code in the project.

LLM prose can't be unit-tested, but the parts Stage 2 actually breaks are pure
functions: `splitIntoChunks`, `outlineToMarkdown`, `stripInlineClaimIds`,
`slugify`, and whatever block renderer A2 introduces. Those deserve tests before
they are rewritten, not after.

**Done when:** a test runner exists and covers the pure helpers in
`lib/synthesis.ts` and `lib/extraction.ts`. Small — one afternoon — and it is
the difference between "the build passed" and "the output is still correct".

#### There is no regression check for article quality
The real question for Stage 2 is *"did the articles get better or worse?"*, and
nothing answers it today. Usefully, the metrics already exist: every article
stores `groundedness_score` and `coverage_score`.

**Recommendation:** before changing any prompt, pick ~5 topics as a fixed eval
set, record their current scores and lengths, and re-measure after each prompt
change. This turns a subjective "reads better" into a number, and costs about
$5 per run. Do this **first** in Stage 2 — it is the instrument for everything
else in that stage.

#### Everything runs against production
One Supabase project, one `.env.local`, no staging or branch database. Every
migration, seed, and pipeline run so far has executed against live data — which
is how a concurrent seed managed to split the live spine.

Not necessarily worth fixing (Supabase branching exists but adds cost and
friction for a solo project), but it should be a **conscious** choice rather than
an unexamined default. The practical mitigation already in use — dry-run first,
verify counts before and after — should stay mandatory for anything touching
`topics` or `claims`.

#### There is no spend cap
`lib/worker.ts` enforces a **time** budget (300s, Vercel's `maxDuration`) — not
a cost budget. Nothing stops a queue from spending unboundedly; the 51 stray
`generate_topic` jobs were caught by inspection, not by a guardrail, and would
have cost ~$50 unasked. The full build is $400–600 through the same path.

**Done when:** a job-count or estimated-spend ceiling per tick, and a
`generate_topic` enqueue path that refuses to queue a library-wide run without
an explicit flag.

### Good news: the article schema change is safer than it looks

`app/topics/[slug]/page.tsx` renders **`body_markdown`**, not `outline`. So the
55 existing articles keep rendering unchanged no matter what happens to the
block schema, and `outlineToMarkdown` is the single choke point where new block
types become reader-facing. A2 does not need a data migration or a
dual-rendering path — it needs one function extended and one prompt schema
widened.

### Gaps I looked for and did not find

Recorded so the audit isn't repeated: no orphaned references to dropped tables,
no untracked files, working tree clean, `ARCHITECTURE.md` current as of
`c0b42c0`. The taxonomy is settled and guarded at three layers. Nothing in
`docs/archive/` is load-bearing.

---

## The plan — what to work on, in order

The sections below are a catalogue, ordered by severity. This section is the
*sequence*, ordered by dependency. Four stages, and the ordering is not
preference: each one is cheaper or safer because the one before it happened.

### Stage 1 — Stop shipping untrustworthy articles (do first, blocks the build)

Everything here must land **before** the full library build, because the build
would otherwise mass-produce the same defects at ~$400–600.

1. **Make the groundedness gate block.** Pick a floor; hold or flag articles
   below it instead of logging. Live articles sit at 0.40. → P1
2. **Capture `start_ms` at extraction.** Retroactive-hostile: fixing it later
   means re-extracting everything. Must precede the next ingest, not follow it.
   → P2
3. **Diagnose reference resolution** (4 of 76). Either fix it or stop
   presenting verified references as a feature — the build bakes whichever is
   true into every article. → P2
4. **Clear the two operational stragglers**: source `d32c0fc8` stuck in
   `processing`, and the 5 queued `update_topic` jobs (decide: run or drop).
   → P2

### Stage 2 — The de-duplication engine rewrite → see the spec

**This stage is fully specced in [`docs/synthesis-v4-spec.md`](docs/synthesis-v4-spec.md).**
Build it in that document's §11 order. The summary of *why* it is here and ahead
of corpus work: every item is a property of **each generated article**, so the
full build multiplies any defect by ~50 topics. Regenerating afterwards means
paying the build cost ($2–5k at target scale) twice.

What the spec covers, so this map stays honest:

- The measurement harness — dedup accuracy + article eval set — **built first**
  (spec §6.1). Paul's requirement: prove the engine, don't trust it.
- The no-new-information rewrite: length follows evidence, not a word target;
  sentence-level attribution; glossary-only definitions; no source narration
  (spec §5). Absorbs walkthrough items A1 (source narration) and A2 (block
  schema).
- Consolidation fidelity — merge only when materially identical (spec §6).
- Claims gated **before** synthesis via a flag/quarantine/approve lifecycle
  (spec §7). This is the architectural inversion that makes the rest tractable.
- The gates: min-claims, groundedness floor + absolute cap, the
  `catch{return 1}` bug fix, thin topics hidden (spec §8).

Deferred out of this stage (spec §10): the patient article (walkthrough A3) —
rebuilt only after no-new-information is proven on the clinician article.

### Stage 3 — Make the corpus worth building from

8. **Ingest breadth** — Exercise, Sleep, Nutrition sources. The skew is an
   ingestion artefact, not a defect, but building now yields one deep branch
   and nine thin ones. → P3.6
9. **Regenerate the 45 pre-coverage-gate articles.** Cheap relative to the full
   build, and it makes "comprehensive" true of the library rather than ten
   articles. Do it *after* stages 1–2 so the regeneration is not itself
   wasted. → P1

### Stage 4 — The full library build (one budgeted run)

10. **Batch API path** first if the discount is wanted — it is a 50% lever on
    the single most expensive action in the project. → P3.5
11. **Run the build.** Preconditions: taxonomy settled (✅ done), gate blocking
    (1), provenance captured (2), article shape fixed (5–7), corpus balanced
    (8). → P3.6

### Stage 5 — The B2B differentiators (what makes it sellable)

Sequenced by dependency, not by appeal:

12. **Per-source novelty %** — inputs already exist (consolidation decides
    SAME/DIFFERENT); this is recording and surfacing, not new inference. The
    single clearest proof the dedup engine is real. Build it together with the
    admin per-source stats dropdown (P1.5 D3) — same query, two views. → P3.5
13. **Consensus vs contested labelling** — needs a structured field before any
    UI or override can exist. → P3.5
14. **Claim relations → contradiction queue** — depends on 13 for its verdict
    vocabulary. → P3.5 / Phase 8
15. **"What's new since last visit"** — versioned sections are the hard
    prerequisite and already exist. → P3.5

**Running alongside, unblocked by any of the above.** None of these touch the
pipeline, and all are user-facing today:

- The public-site P1s — legal pages, lever copy.
- The admin/UX cluster from the walkthrough: evidence grouping (P1.5 B), the
  jobs/run-history merge (C), insight badge labels and sorting (D), the
  default-empty Insight Review (D2), UI polish (F), and library navigation (G).
- **Manual article editing (P1.5 E)** is the exception — it looks like UI work
  but collides with regeneration, so treat it as pipeline work and settle the
  edit-survives-regen question before building the editor.

---

## P1 — Broken for users right now

### Legal pages 404 on every page of the site
`/privacy-policy` and `/terms-of-use` are linked from the global footer but no
routes exist. A sweep of every static internal `href` in `app/` and
`components/` against the route tree found these are the only two dead links
left. Most consequential item here, especially with a membership offering
planned.

**Done when:** both routes exist with real policy text. Needs actual legal
copy — scaffolding empty pages is not a fix.

### Articles ship below the groundedness gate — live, on a clinician product
`lib/synthesis.ts:427` scores groundedness, logs `[synthesis] low groundedness`
when it falls under 0.7, and then **saves the article anyway**. Nothing blocks,
quarantines, or retries. Measured across the 28 live clinician articles
(2026-07-22):

| Article | Groundedness |
|---|---|
| AMPK Signaling | **0.40** |
| Cognitive Aging | **0.60** |
| Sleep & Cognition / Resistance Training | 0.67 |
| Rough-and-Tumble Play | 0.69 |
| Sleep | 0.70 |
| Lifespan / Cold Exposure Protocols | 0.75 |

Groundedness is the share of paragraphs whose assertions are actually supported
by their cited claims. At 0.40, most of the AMPK article's assertions trace to
nothing in the corpus. The whole pitch is that a physician can trust every
statement, so this outranks every cosmetic item in this file.

**Done when:** an article below a chosen floor is not published — held for
review, regenerated, or saved with a visible flag. Decide the floor
deliberately (0.7 is currently only a log threshold, not a considered value).

### Most of the library predates the coverage gate
45 of 55 `topic_articles` rows have `coverage_score = null`: they were generated
before sectioned, claim-complete synthesis existed. Only the ten regenerated
since carry `coverage_score = 1`. The size gap is stark — Testosterone went
5,385 → 46,001 characters when regenerated; Male Fertility Assessment 3,803 →
45,214.

So "comprehensive, nothing dropped" is currently true of ten articles, not the
library. Because the read side renders `order by version desc limit 1`, the
newest row wins and regeneration is safe — old versions stay as history.

**Done when:** every clinician article has a non-null `coverage_score`. These
topics are small, so this is far cheaper than the full build.

### Lever copy on `/start` is unreviewed placeholder
See `TODO(copy)` in `lib/levers.ts`. The `tagline`, `description`, and
`primaryBenefits` for all five levers were drafted to get the grid rendering
after the v1 `concepts` table was dropped and the originals lost. This is
public marketing copy on a primary landing page.

**Done when:** all five levers carry copy you've written. Single file, no
schema involved.

### "Popular protocols" cards mismatch their destinations
`components/PopularProtocolsStrip.tsx` — a hardcoded list of six protocol cards
("Zone 2 Cardio Protocol", "Sleep Hygiene Protocol") that link to broad topic
pages (`/topics/exercise`). The links work; the specificity does not match.

Was six guaranteed 404s (pointing at `/admin/topics/{v1-slug}`, a route that
never existed); the stopgap remapped them to real v2 topic slugs.

**Done when:** sourced from the `topic_protocols` table instead of a hardcoded
array. Blocked on protocols actually being generated for these topics.

---

## P1.5 — Site walkthrough, 2026-07-21 (reader & operator experience)

Paul used the live site and recorded feedback. Grouped by **root cause** rather
than by screen, because a dozen of the observations trace back to four causes —
each was traced into the code or the database, and the finding is recorded next
to the symptom so nobody re-derives it.

**Sequencing consequence, and it is the important one:** items A1–A4 below must
land *before* the full library build, for exactly the reason the groundedness
gate must. The build is a single budgeted run producing 100+ articles; if it
runs against the current prose rules and the current article schema, every one
of those articles is written in a voice Paul has rejected and a structure that
cannot hold a bullet list. Fixing it afterwards means regenerating the entire
library — paying the $400–600 twice.

### A. The reader-facing article (product-defining)

#### A1. Articles say "as the source said" — the prompt explicitly asks for it
Not a model quirk. `CLINICIAN_SECTION_PROMPT` (`lib/synthesis.ts:169`) instructs:
*"QUOTES: when a claim carries a verbatim quote, you MAY include it verbatim in
quotation marks **with attribution** when especially illustrative."*

This is the Phase 6 trust foundation behaving exactly as designed — verbatim
anchoring was built to make claims auditable. The conflict is that it was wired
into **reader-facing prose** rather than kept as backend provenance. A reader
should never have to wonder who "the source" is; the whole point of the
consolidation engine is that many sources became one coherent statement.

**Done when:** verbatim quotes are provenance only — visible in the Evidence
drill-down, never narrated in article prose. The `direct_quote` data stays; it
stops being quoted at the reader. Keep the reference markers `[R1]`, which are
citations to primary literature, not to our ingested sources — those are a
different thing and belong in a clinician article.

#### A2. Articles cannot be "broken up" — the data model has no way to express it
The blocker is structural, not stylistic. The article shape is
`Outline → Section → Paragraph { id, text, claim_ids }` (`lib/synthesis.ts:206`),
and `outlineToMarkdown` emits `## Title` followed by raw paragraph text. **There
is no representation for a bullet list, sub-heading, callout, table, key-takeaway
box, or image.** No amount of prompt tuning produces them, because the JSON
schema the model must return has nowhere to put them.

**Done when:** paragraphs become typed blocks (`prose | bullets | callout |
table | figure | key_takeaways`), the section prompts may emit them, and the
markdown renderer handles each. This also unblocks A4 (images) and varied
sentence structure, since the model is currently instructed to return a flat
list of prose paragraphs and is doing so faithfully.

#### A3. The patient article is a paragraph-for-paragraph mirror of the clinician one
`PATIENT_SECTION_PROMPT` (`lib/synthesis.ts:177`) translates **one clinician
section at a time** and is told to *"base it ENTIRELY on the provided section
text."* The generation loop (`lib/synthesis.ts:439`) walks the clinician sections
and emits one patient section per clinician section.

So the patient article structurally cannot differ from the clinician article: it
inherits the same section count, the same order, and the same paragraph count.
Paul wants it *engaging* — something a layperson keeps reading — and that is
unreachable while it is a translation layer rather than its own document.

**Done when:** the patient article gets its own outline pass over the claims —
free to re-order, merge, lead with what matters to a patient, and use the block
types from A2. Comparable in spirit to how the clinician outline is generated,
not derived from it.

#### A4. No image support anywhere
No field exists on `topic_articles`, in the `Outline` type, or in the renderer.
Paul plans to ingest images from existing articles and re-create them as needed.

**Done when:** a `figure` block type (A2) carries an image reference, alt text,
and a caption, with provenance for where the image came from and its licence.
**Licence provenance is not optional** — re-using images from ingested articles
in a product sold to physicians is a rights question, not just a technical one.

### B. Evidence looks duplicated — but dedup is working correctly

Paul saw "Longevity 101, segment 10, segment 11" under COPD looking identical.
**Checked against the live database.** Both segments are `claim_members` of a
*single* claim (`2991c6f3`), and their underlying statements are genuinely
different sentences ("COPD is largely preventable…" vs "COPD remains a major
cause of…"). Consolidation did its job.

Two real findings behind the appearance:

1. **`CHUNK_OVERLAP = 200` on `CHUNK_SIZE = 2400`** (`lib/extraction.ts:21`) means
   adjacent chunks share 200 characters, so a passage on a chunk boundary is
   extracted twice by design. That overlap exists to avoid losing
   boundary-spanning content, and consolidation is what cleans up after it. Working
   as intended.
2. **The Evidence panel renders `claim_members` — the raw, pre-dedup layer.** So
   the UI displays precisely the duplication the engine already resolved, which
   makes a working system look broken.

**Done when:** the Evidence drill-down groups members by claim and collapses
same-source segments, showing "Longevity 101 (2 segments)" expandable rather
than two near-identical rows. Presentational only — **do not "fix" the dedup,
there is nothing wrong with it.**

### C. Admin: jobs vs. run history are the same work at two altitudes

`jobs` is the **queue** (intended work, with checkpoints); `pipeline_runs` is the
**execution record** (attempts, including resumed and failed ones —
`lib/pipelineRuns.ts` documents why a run row can legitimately stay `running`
across ticks). `app/sources/[id]/page.tsx:193` renders them as two flat,
unlabelled lists, so the same processing appears twice with no stated relation.

The "three different jobs" on one source are separate *stages*
(`extract_source`, then downstream) of a single logical processing episode.
Nothing in the schema groups them, so nothing in the UI can.

**Done when:** one collapsible entry per processing episode, labelled with date
and time, with its stages nested underneath and their run attempts inside those;
sorted newest-first. Needs a grouping key — likely the run/checkpoint id already
threaded through `startOrResumeRun`. Explaining the two tables in the UI copy is
the cheap half; grouping is the half that actually answers the confusion.

### D. Insight metadata is unlabelled and unsortable

- **"Peripheral" and "Useful" are not evidence types — they are `importance`.**
  `components/SourceRawInsightsClient.tsx:48` maps `1 → Core, 2 → Useful,
  3 → Peripheral` and renders the badge next to `evidence_type` with no label,
  so it reads as a competing evidence taxonomy. The distinct axes are
  `evidence_type` (RCT/Cohort/Mechanistic/…), `importance`, `actionability`,
  `confidence`, and `insight_type`. **Done when:** each badge says what axis it
  is on.
- **Sorting was specced and typed but never built.** `InsightSortOption`
  (`importance | recency | evidence_strength | actionability`) and
  `InsightGroupOption` (`source | evidence_type | date | none`) exist in
  `lib/types.ts:235-236` and are imported by **nothing**. The vocabulary Paul is
  asking for is already designed; only the UI and query are missing.

#### D1. Insight → article traceability (Paul: "where is each insight used?")
**The data already exists.** Every article paragraph stores `claim_ids`
(`lib/synthesis.ts:206`), so the chain `raw_insight → claim_members → claim →
paragraph → article` is fully traversable today. This is a read-side feature, not
a pipeline change — considerably cheaper than it sounds.

**Done when:** an insight shows the articles and sections it landed in, linked;
ideally the reverse too (a paragraph reveals its supporting insights).

#### D2. Insight Review shows nothing until you search
`app/admin/insights/review/page.tsx:83` computes `hasSearchOrFilters` and skips
the query entirely when no search or filter is set — so the page reports "1,072
raw insights" and then lists none. The guard looks like it was meant to avoid
loading everything, but **the query is already paginated** (`PAGE_SIZE`, `.range(offset, …)`),
so it is guarding against a cost that isn't there.

**Done when:** the unfiltered first page renders by default.

#### D3. Per-source stats dropdown
Paul wants the stats card to break down by source: insights, claims, and
consolidation ratio each. The consolidation ratio is the interesting one — it is
the same number as the **per-source novelty %** in P3.5, viewed from the admin
side. Build them together; they share a query.

### E. Manual article editing — with a collision to resolve first
Paul wants to edit clinician/patient/protocol articles by hand while reading.

**The hard part is not the editor.** Articles are regenerated by `update_topic`
jobs and `stale_topics()`, and the read side renders `version desc limit 1` — so
a hand-edit is silently discarded the next time the topic goes stale. Any editor
must answer: does a manual edit pin the article against regeneration, merge with
it, or feed back as a corrected claim?

**Recommended:** edits become a new version marked `human`, and regeneration
preserves human-edited sections the way `updateTopicContent()` already preserves
untouched ones — the mechanism exists. **Done when:** an edit survives a
subsequent `update_topic` run. Test that explicitly; it is the whole risk.

### F. UI polish (small, independent, safe to batch)
- `app/admin/topics` — no vertical spacing under major headings.
- Back button from Topics → Sources, and from Insight Review → Sources, reads
  wrong. Use a plain **"Back to Sources"**.
- Card-shaped buttons (Sources, Topics on Insight Review) need a visible border /
  hover state so they read as clickable.

### G. Taxonomy navigation
Admin `/admin/topics` and the Medical Library present the same tree with no
stated difference, which is confusing. Paul wants **hovering "Medical Library"
to open a dropdown of the topic tree** so the scope of the library is visible
without drilling in.

Worth deciding deliberately: with 10 roots and ~130 topics, a hover menu must
show branches (and probably only two levels), not everything. Related to the
P3.6 item about thin branches being reader-visible — the nav is where a
17-claim branch is most conspicuous.

---

## P2 — Data & pipeline

### Subtopics over-fragment — bias the tagger to GENERAL topics + a review queue
`lib/taxonomy.ts:156` (`placeTopic`) mints a child for any new subject the tagger
names under a valid parent — one claim is enough, and the prompt doesn't push
toward *general* names. Result: 26 children under Reproductive Health, several
single-claim micro-topics (Sperm Chemotaxis, Blood-Testis Barrier, Bicycle Saddle
Ergonomics). A one-claim subtopic can't pass the 10-claim article gate and just
fragments the tree.

**Paul's model (2026-07-23): auto-create, don't block — then audit.** Ingestion
must not stall waiting for approval (new sources bring new subjects). So:
- **Roots stay human-only** (propose → approve). **Subtopics auto-create**, land
  `reviewed_by_human = false`, and surface in a **review queue where Paul
  approves or denies** (deny = fold claims into the parent, archive +
  `merged_into_id`).
- **The fix that makes this work is in the PROMPT, not a gate:** instruct the
  tagger to propose **broad topics that hold many related claims** (e.g. "Male
  Reproductive Physiology", never a single finding). With the generality bias,
  auto-creation mostly yields good topics and the queue stays short. *Without it,
  auto-create just moves the sprawl into a review backlog.* Fine distinctions
  below a subtopic live as article bullets (B3 / F4).

**Done when:** the tagger prompt biases hard toward general topics; auto-created
subtopics carry `reviewed_by_human = false` and appear in an approve/deny queue;
deny folds into the parent. Relates to `discover_topics` (splits-not-consolidates)
and the taxonomy-maintenance job. **Do the prompt bias before the Phase 0.5
re-tag**, or re-tagging re-creates the sprawl.

### Transcript hygiene — strip ads / intros / outros before extraction (trust filter)
YouTube captions (and some pasted transcripts) carry cold-open hype clips,
**sponsor reads / ad breaks**, and subscribe/outro segments. Extraction cannot
distinguish a sponsor read ("brought to you by AG1, which supports gut health")
from a clinical statement, so an ad becomes an extracted **claim** and is
deduplicated into the one source of truth as if it were medical guidance — a
direct violation of principle 1 (the machine adds no substance; here the *source*
smuggles in non-substance). Raised by Paul 2026-07-22 re: future direct uploads.

**Done when:** every ingested transcript passes a hygiene pass (likely a cheap
Haiku call) that removes intro/outro/sponsor/ad spans before chunking —
conservative (when unsure, keep and surface, never silently delete). Applies to
all future uploads, not just YouTube. Build it with the timestamp work (both
touch ingestion). See `docs/v4-build-risks-and-cost.md` §D Phase 1.

### Timestamp capture — the YouTube timing is fetched, then discarded
`app/api/admin/sources/fetch-youtube-transcript/route.ts:109-111` receives each
caption segment as `{ text, start, duration }` and maps to `segment.text`,
throwing the timing away. So `raw_insights.start_ms` is null everywhere and the
one-click "jump to the moment in the video" deep-link has nothing behind it.
Getting timestamps is *stopping* a discard, not new integration.

**Done when:** timed segments are preserved → chunk `start_ms`/`end_ms` set →
`raw_insights.start_ms` set → Evidence citation deep-links `url + &t=<sec>`.
First proof on `youtube.com/watch?v=s-qapZuy0GY` (the one seed source that can get
timestamps — the other four are manual plain-text transcripts). See
`docs/v4-build-risks-and-cost.md` §D Phase 1.

### Verify the topic-merge fix against real data
`ebe3697` changed the `merge` action in `app/api/admin/topics/[id]/route.ts` to
drain claim links in batches and delete only the ids it just moved. Previously
a blanket `delete().eq("topic_id", id)` destroyed any link a concurrent
`tag_claims` job inserted mid-merge, silently dropping the claim's topic
assignment.

It was verified by type-check and build only — exercising it means running real
merges on production data.

**Done when:** a merge has been run with the worker active and claim counts
reconcile on both sides.

### ~~Reshape the taxonomy toward the curated top-level tree~~ — DONE 2026-07-22
Completed in `d0d4e83`..`89f4034`. The live tree is now 10 curated spine
branches with **zero** legacy roots, all 1,013 claims still tagged. The six
original headings were widened to ten because the corpus demanded it — most
of the library is reproductive/hormonal health and research methodology, which
had no home among the original six.

Three mechanisms now hold the line, in increasing order of reliability:
prompt (prefer existing topics) → code (`createChildTopic` requires a parent,
so no call site can mint a root) → database (unique index on
`(lower(name), parent)` for active topics, migration 008).

**Note still live:** `lib/levers.ts` pins lever cards to specific topic slugs.
If a lever's topic is archived or merged, that card silently disappears from
`/start`. Re-check the grid after any future reshaping.

### Reference resolution succeeds 5% of the time
`reference_mentions` holds 76 extracted citations. **72 are `not_found`; 4
resolved**, yielding 3 canonical rows in `references_` and 21 `claim_references`
links. Verified references are a headline trust feature for the physician
product — at this rate the References section is effectively empty, and the v3
evidence layer's whole point is unmet.

Extraction is working (76 mentions found across 6 sources); **resolution** is
where it fails. Likely causes, in order: podcast speech names studies loosely
("the Danish twin study"), so there is no title to match; query construction
against CrossRef/PubMed may not be falling back from title → author+year.

**Done when:** a spot-check of ten real mentions shows most resolving, or a
documented finding that conversational citations are inherently unresolvable —
in which case stop presenting resolution as a feature.

### No timestamped provenance — 0 of 1,072 insights
`raw_insights.start_ms` is populated on **zero** rows. You asked for this
directly: an insight should deep-link to its exact moment in the source video
so a manual review is one click. Nothing is captured.

This is retroactive-hostile: fixing it later means re-extracting every source.
**Do it before the next YouTube batch**, not after.

**Done when:** extraction records `start_ms`/`end_ms` from chunk timing, and a
topic-page citation links to `youtube.com/watch?v=…&t=…`.

### Source stuck in `processing` with no job
`d32c0fc8` ("Optimizing protein quantity, distribution, and quality", 16,186
chars) has `processing_status = 'processing'`, 0 raw insights, and no queued
job — its `extract_source` job was deleted at your request on 2026-07-22 so you
could reprocess manually. The status was never reset, so admin shows it as
permanently in-flight.

**Done when:** the source is either reprocessed or its status reset to
`pending`. Worth a general guard: a source in `processing` with no live job is
by definition stale.

### 5 `update_topic` jobs sitting queued
Queued 2026-07-22 10:39 by the taxonomy reshape — re-tagging claims made those
articles genuinely stale, so `stale_topics()` did its job. They are incremental
section patches, not full rebuilds, so the cost is small but non-zero and they
will run on the next worker tick.

Left queued deliberately rather than deleted: unlike the 51 stray
`generate_topic` jobs, these represent real work. **Decide** whether to let them
run.

### `claims.topic_fit` is not discriminating
Added in migration 007 to flag placements the tagger wasn't confident about, so
a human could review approximate filings. In the first real run all 77 claims
came back `good` — zero `approximate`, zero `unfiled`. The value is the model's
own self-report, and it does not currently separate a confident placement from
a resigned one, so it cannot be trusted to surface bad filings.

**Done when:** the signal is grounded in something measurable — e.g. derive it
from the ANN similarity to the chosen topic rather than asking the model — and
a spot-check shows `approximate` actually correlating with weak placements.

### `discover_topics` splits rather than consolidates
The stage samples claims **one existing topic at a time** and asks what finer
topics live inside. Two consequences: every proposal is a split (a dry run
produced 63 new topics against a 133-topic tree), and cross-cutting themes are
structurally invisible — supplement claims sat 1–2 apiece across eleven topics,
so no single batch ever saw enough of them to cluster. It never proposed
"Supplements" for exactly this reason.

Less urgent now that the spine constrains where anything can land, and that
`placeTopic` routes new roots to the approval queue rather than creating them.

**Reconciled 2026-07-22 against the Attia crawl (see spec §4):** the target
taxonomy is now known to be *bounded and curated* — ~40–60 leaf topics matching
Attia's own site structure, which the spine already mirrors. So topic
*discovery* is no longer a growth engine; it is at most an occasional
"did we miss a cross-cutting theme like Supplements?" audit. The real scale
pressure moved **inside** the topic: ~300–600 claims per leaf, which is a
sectioning-and-synthesis problem (spec §5), not a discovery problem. Downgrade
accordingly — this is a periodic audit, not a pipeline stage that runs on every
ingest.

**Done when:** clustering runs corpus-wide over `claims.embedding`, ignoring
current topic membership, so thin cross-cutting themes surface — run as a manual
audit, not automatically. Costs no new embedding spend — every claim is already
embedded; only creating a topic embeds anything new.

### Taxonomy maintenance job (task #8)
A scheduled pass that proposes split / merge / re-parent moves from claim
centroids, so the tree self-corrects as the corpus grows instead of drifting
until someone notices. Also the natural owner of periodic count reconciliation
(`recomputeTopicCounts` currently full-scans every topic).

Deliberately **deferred, not dropped.** The spine plus the three-layer root
guard now hold the shape by construction, so drift is slow; and with 10 curated
roots and ~1,000 claims there is not yet enough signal for centroid moves to
beat human judgement. Revisit once the corpus is several times larger.

### `topic_protocols` generation
Most topics have no generated protocol yet (all zero as of the cleanup). Gates
the P1 protocols-strip item above.

---

## P3 — Specced; partly built

The "agreed, not yet built" labels on the `ARCHITECTURE.md` v3.1/v3.2 sections
are **stale** — the mechanics of both shipped on 2026-07-21/22. What is missing
is not the machinery but the *product promises* layered on top. Corrected here
because the old wording would send the next person to rebuild working code.

**Built** (verify in `lib/synthesis.ts`, `lib/worker.ts`):

- v3 evidence layer — `references_`, `reference_mentions`, `claim_references`
  exist and are populated; `direct_quote` is set on **all 1,072** raw insights.
- v3.1 core — claim cap removed (`CLINICIAN_CLAIM_CAP = 2000`), sectioned
  generation, coverage gate + mop-up, `coverage_score`, groundedness scoring.
- v3.2 core — `updateTopicContent()` with its three tiers and
  `FULL_REGEN_THRESHOLD = 0.25`, wired through `stale_topics()` →
  `update_topic` jobs (migration 005.2). One has already run successfully.

**Not built — these are the B2B promises, and each is separately listed below:**
per-source novelty %, consensus/contested labelling, timestamped provenance,
contradiction review queue, topic-split flow, "what's new since last visit",
and the Batch API discount path.

---

## P3.5 — The B2B promises (agreed in conversation, nothing built)

These are what makes the library sellable rather than merely large. Each was
agreed explicitly; none exists in code.

### Per-source novelty ("N% of this source was new")
The core differentiator. The pitch is that a clinician never re-reads overlap:
ingest a source, and the system reports how much of it was genuinely new versus
already known. Every input exists — consolidation already decides SAME vs
DIFFERENT per raw insight — so this is a matter of recording and surfacing the
ratio per source, not new inference.

**Done when:** a source page shows "N% new" and the claims contributed.

### Consensus vs contested labelling
Agreed: **classify automatically, Paul overrides contested calls.** Contested
material must read as "thought for discussion", never as settled fact. Today
this exists only as a line in the synthesis prompt
(`lib/synthesis.ts:169`) asking the model to hedge — there is no structured
field, so nothing can be filtered, badged, or overridden.

**Done when:** claims carry a consensus state, articles render it visibly, and
an admin control flips a contested call.

### Contradiction review queue
`CONTRADICTS` was specced as a human-confirmed verdict. When a new source
disputes an existing claim, that must surface for a decision rather than being
silently merged or duplicated.

### Topic split flow
A topic that grows too broad should be splittable with its claims redistributed
and its article re-sectioned. Specced in v3.2, not built. Related to the
`discover_topics` item above, which currently only ever splits.

### "What's new since last visit"
The living-document delta. Readers who return should see what changed rather
than re-reading. `topic_articles` is already versioned per section, which is the
hard prerequisite.

### Batch API path (50% discount)
For the one budgeted full build. Ranked first among cost levers in
`ARCHITECTURE.md` "Cost model".

### Article-profile registry (task #10 / Phase 7)
Today's clinician / patient / protocol variants are hardcoded. Specced as a
**code registry**, not a table: `{ key, audience, depth, claim_cap, prompt,
requires_quotes, requires_references }`, with a `profile` column on
`topic_articles`. Adding a depth level — a CME monograph, a patient handout —
then costs one registry entry rather than a schema change.

Lower priority than it looks: one profile done well beats three done thinly,
and the clinician profile is the product.

### Computed evidence grading (task #10 / Phase 7)
A derived grade per claim from evidence_type + confidence + source_count +
best-reference tier + recency, surfaced in Evidence and in articles.
**Depends on reference resolution working** — the best-reference-tier input is
currently near-empty (4 resolved of 76), so building this now would grade
almost everything on missing data.

### Physician Q&A (task #11 / Phase 8)
RAG over claims + verified references. Last in the sequence deliberately: it
inherits every trust property of the layers under it, so it is only as
trustworthy as the groundedness gate and reference resolution make it.

---

## P3.6 — Corpus strategy

### The library is lopsided, and it is an ingestion artefact
As of 2026-07-22, 5 processed sources produced 1,072 raw insights → 1,013
claims. Two sources (Attia #351 male fertility, #374 testosterone) account for
**594 insights — 55% of everything**. Hence Sexual & Reproductive Health holds
426 claims against Exercise's 51, Sleep's 24 and Medications & Supplements' 17.

The skew is *not* a taxonomy problem and needs no correction: it is exactly what
five sources should look like. It matters only for sequencing — a full library
build now would produce one deep branch and several hollow ones.

**Recommendation:** ingest a few Exercise / Sleep / Nutrition sources *before*
the single budgeted full build, so that build produces a balanced product.

### Thin branches are reader-visible
Medications & Supplements (17 claims) and Sleep (24) render as full branches
alongside Sexual & Reproductive Health (426). To a physician evaluating the
product, a near-empty branch reads as abandoned rather than early.

**Done when:** the reader tree hides or de-emphasises branches under a claim
threshold. Display-only; the taxonomy itself is correct.

### Keep spine branch names specific
Not a task — a rule to hold to. `tag_claims` pulls candidate topics by embedding
similarity (`match_topics`, `TOPIC_MATCH_THRESHOLD = 0.28`) and hands the names
to the LLM as hints. A topic competes for claims **whether or not it has any**,
so declaring branches early is cheap and safe, but a broad, vague name
("Health Optimization", "Wellness") will siphon claims from every direction.
Narrow empty branches are harmless; vague ones are not.

This is why `Risks › Hormones` had to be collapsed into
`Sexual & Reproductive Health › Endocrinology` — two plausible homes guaranteed
inconsistent filing.

### The full library build has not been run
The taxonomy is now settled (10 curated roots, 0 legacy), which was the
precondition. Nothing triggers it automatically — `stale_topics()` deliberately
returns only topics that *already* have an article, so an ingest can never kick
off a library-wide build.

**Cost, corrected 2026-07-22 (spec §4).** The ~$1/topic, ~$400–600 figure was
for today's 133 topics on the *current* synthesis. At target scale (~200
podcasts, ~20k claims, ~40–60 dense leaf topics) the full build is more like
**$2,000–5,000**, and the Batch API discount (P3.5) stops being optional. But
**do not run the full build before the v4 rewrite ships** — building on the
current padding-prone synthesis produces $2–5k of articles that must then be
regenerated. Sequence is: v4 rewrite (spec) → ingest breadth → one budgeted
build. This supersedes any earlier "$400–600" figure in this file.

---

## P4 — Documentation

### ~~`ARCHITECTURE.md` status was stale~~ — DONE 2026-07-22
Three separate stale labels, not one: line 3 claimed *"v2 rebuild in progress
(branch `v2-rebuild`)"*, and the **v3.1 and v3.2 section headers both read
"(agreed, not yet built)"** for machinery that shipped 2026-07-21. Since
`CLAUDE.md` designates this file as authoritative, those headers would have sent
the next reader to rebuild working code — the same error this file's P3 section
was written to correct.

All three now state shipped status and point here for outstanding work.

### `docs/archive/` is intentionally stale
v1 documentation kept for history. Not a to-do — listed so nobody "fixes" it.
`docs/archive/ARCHITECTURE-REPORT.md` still describes deleted components.

---

## P5 — Code hygiene

### 15 lint warnings (0 errors)
All pre-existing, all unused vars/imports except one hook-dependency warning.

| File | Warnings |
|---|---|
| `app/admin/sources/new/page.tsx` | `useEffect`, `isValidYouTubeUrl`, `data` unused |
| `lib/fileExtraction.ts` | `importError`, `error` unused (swallowed catches) |
| `components/TranscriptEditor.tsx` | `CardDescription`, `sourceId` unused |
| `app/admin/sources/page.tsx` | `CardHeader`, `CardTitle` unused |
| `components/WhatMattersMost.tsx` | `highlightedLevers` unused — see below |
| `components/TopicsAuditClient.tsx` | `byId` unused |
| `components/SourceEditorClient.tsx` | `useState` unused |
| `components/membership/PaidFeatureGate.tsx` | `MembershipTier` unused |
| `app/api/admin/sources/fetch-youtube-transcript/route.ts` | `e` unused |
| `components/InsightReviewFilters.tsx` | `useEffect` missing dep `searchQuery` |

Two are worth more than a lint pass:

- **`WhatMattersMost` ignores `highlightedLevers`.** The prop is declared,
  documented, and passed from `app/start/page.tsx`, but never read in the
  component body. The intended visual feedback on the priority selector was
  never wired up. `LeverGrid` does use it, so the feature half-works.
- **`lib/fileExtraction.ts` swallows two caught errors** without logging, which
  can hide ingestion failures.

### Membership is stubbed
`lib/membership.ts` has two TODOs standing in for database lookups until auth
exists. Expected, not rot.

### `eslint.config.*` doesn't scope out nested worktrees
Its `ignores` list (`.next/**`, `node_modules/**`, `dist/**`, `coverage/**`,
`src/**`) only matches those directories at the top level. Claude Code worktrees
live inside the repo at `.claude/worktrees/<name>/` — a full nested checkout,
each with its own `.next`, and potentially its own `dist/`/`src/`. None of the
current patterns match a `.next` (or `dist`, `src`) three levels down, so
`npm run lint` run from the real repo root while any such worktree exists
sweeps up that worktree's build output and duplicate source tree as if it were
part of the project.

Hit this directly merging `claude/stoic-blackburn-91d7db` into `main`
(2026-07-22): `npm run lint` from the repo root reported 24,599 problems.
Excluding `.claude/**` brought it back to the true baseline (0 errors, 15
warnings, matching a lint run from inside the worktree itself). Not a real
regression — a scope gap that will misfire the same way for anyone who lints
from the repo root while a worktree is present.

**Done when:** `ignores` in `eslint.config.*` excludes `.claude/**` (or uses
`**/.next/**`, `**/dist/**`, `**/src/**` so nested copies at any depth are
caught, not just top-level).

---

## Verified — do not re-investigate

Recorded to save the next person the trip:

- **There are no duplicate active topics *now* — but `medications-supplements-2`
  and `risks-2` were a real bug, not transient noise.** Two concurrent
  `seedSpine` runs each read the topic list before either had written, both
  found no `Risks`, and both created it — splitting the spine in half across
  duplicate roots. They were merged by hand (children re-parented onto the
  survivor, then deleted); they held no claims or articles, so nothing was lost.

  The cause is structural: the seeder reads once and inserts what's missing, and
  slug collisions resolve by appending `-2`, so concurrent duplicate inserts
  *succeed silently*. No application-level find-or-create can close that window.
  Migration 008 adds a unique index on `(lower(name), parent)` for active
  topics, turning it into a loud unique violation.

  Unrelated: the remaining `-2` slugs (`reproductive-biology-2`,
  `child-development-2`) are the *live* topics — their same-named predecessors
  are correctly `archived` with `merged_into_id` set. Slugs are frozen and never
  reused, so `-2` there is normal collision handling.
- **Duplicate `topic_articles` rows per topic are versions, not a bug.**
  Testosterone, Male Fertility Assessment, Protein Intake, Functional Aging and
  Longevity Definitions each have two clinician rows. `app/topics/[slug]/page.tsx`
  selects `order("version", desc).limit(1)`, so the newest always renders and the
  older row is retained history. Checked because a 5,385-char and a 46,001-char
  Testosterone article coexist — the long one is what readers get.
- **`seedSpine` reads only ACTIVE topics, so an archived branch left in its
  `SPINE` list is silently recreated.** This is how a collapsed branch comes
  back from the dead. When retiring a branch, remove it from `scripts/seedSpine.ts`
  *and* archive the row — either alone is insufficient. Learned collapsing
  `Risks › Hormones`.
- **The `references` table is named `references_`** (trailing underscore) —
  `references` is a SQL reserved word. Queries against `references` fail with a
  syntax error that looks like a missing table.
- **Two migrations both numbered 005.** The later by commit order is now
  `005.2_update_topic_job_and_stale_topics.sql`. Both are applied; naming only.
- **`components/SourceEditor.tsx` and `components/TranscriptEditor.tsx` are
  live**, not orphans. They
  are the presentational halves behind `SourceEditorClient` /
  `TranscriptEditorClient`, rendered by `app/sources/[id]/page.tsx`. An import
  scan that only matched single-quoted relative imports missed this.
- **No code references any dropped v1 table.** `insights`, `insight_sources`,
  `insight_concepts`, `concepts`, `concept_connections`, `concept_parents`,
  `source_processing_runs` — all clear as of `ebe3697`.
- **`openai` is imported only by `lib/embeddings.ts`**, matching the claim in
  `CLAUDE.md`. The inert v1 OpenAI cluster (`autotag`, `conceptDiscovery`,
  `pipeline`, `topicNarrative`, `topicProtocols`) is **already deleted** — `lib/`
  holds 18 modules and none of them is one of these. An earlier note listing
  this as pending work was stale.
- **The scale-durability refactor shipped.** Migration `003_evidence_layer.sql`
  creates HNSW (`vector_cosine_ops`) indexes on `claims`, `topics` and
  `references_`, superseding the baseline ivfflat `lists = 100` index that would
  have degraded past ~100k rows. The `topic_claims` RPC replaced the unbounded
  `IN (...)` of claim ids. Both were open cliffs in the v3 plan; neither needs
  re-doing.

---

## 🔨 BUILD-NEXT PLAN — 2026-07-28 (post curation+retag; verified by audit)

The topic-curation + re-tag phase is **complete** (203→77→109 active topics, 9
pillars, all 2,450 claims filed; branch `topic-curation` — **merge it**, it also
carries the `mergeTopics` reversed-cycle-guard fix). Strategy locked with Paul
this session:
1. **The taxonomy is expected to drift and grow** (UpToDate-scale) — the goal is
   *automated maintenance*, not a frozen tree.
2. **Use the local subscription CLI now** for all quota-cheap verification /
   maintenance work (fixed cost already paid); reserve the paid **API + Batch**
   for the one-time synthesis build later.
3. **Don't build articles per-source now** — finish the corpus, build the v4
   synthesis engine, generate once for mature topics, then rely on incremental
   section-updates. (Incremental section-update is verified BUILT — see §3.)

Ordered by dependency.

### 1. Extraction fidelity — the trust axis. Do FIRST (all CLI-cheap)

> **STATUS 2026-07-28 PM (overnight window):**
> - **1b ✅ VALIDATED.** `testExtractionFix.ts`: the shipped faithfulness prompt
>   produced 32 insights over the 6 previously-inventing chunks with **2 residual
>   over-reaches (6%)** (was 100% of those chunks inventing). Real improvement,
>   uncertified (judge's call) — the 2 residuals are why 1a + 1c matter.
> - **1a ⏳ HARNESS BUILT, AWAITING PAUL.** The 40-pair sample is now a mobile
>   gold-label worksheet: **artifact
>   `claude.ai/code/artifact/4e9a442b-6d41-4be3-afcf-4941072823ff`**
>   (`scripts/buildFidelityWorksheet.ts`). Paul rules each → Export →
>   `eval/extraction-goldset.json` → `evalExtraction.ts score` prints judge↔human
>   κ. (Sample is the 8-source 07-24 set that produced the "15%" headline — the
>   right certification target. A fresh 18-source sample is a later broader pass.)
> - **1c ✅ WIRED.** `scripts/extract_with_fidelity.sh` = extract → drain →
>   `extraction_fidelity` flag, per source, serialized (judge never overlaps the
>   drain). Flags → `claim_flags` in **shadow mode** (no `status='flagged'` until κ
>   certified). Validated live on ≥1 newly-ingested source this window.
> - **Do NOT auto-quarantine on the judge until κ is acceptable** (unchanged).

- **1a. Certify the judge.** Build the missing `eval/extraction-goldset.json`:
  `evalExtraction.ts sample` (~40 stratified insights) → Paul labels → compute
  judge↔human κ (`scripts/evalExtraction.ts:318`). Near-zero LLM. Until κ is
  acceptable, the "15% invention" and any auto-flag are the JUDGE's opinion —
  auto-quarantine on it could bury faithful claims.
- **1b. Validate the shipped prompt fix.** Run `scripts/testExtractionFix.ts`
  (6 chunks, trivial) — confirm invention drops toward 0. The prompt hardening in
  `lib/extraction.ts:58-66` is live but UNVALIDATED (blocked by the old outage).
- **1c. Wire per-source fidelity flagging** as a standing post-extraction stage:
  `flagClaims fidelity --source <id>` (~1 call/claim, one source at a time — NOT
  the 16h corpus sweep). Writes `extraction_fidelity` flags into the §7 claim
  lifecycle so suspect claims stay `flagged`/invisible to synthesis by
  construction. Sequence after the drain so it never competes for the CLI.

### 2. Taxonomy maintenance — build the "living tree" (DESIGNED, NOT BUILT)
- **2a. Visibility gate.** Add `topics.is_hidden` (or a `min_claims` threshold) +
  make the public read side hide sub-threshold topics. Resolves the thin-subject
  problem (e.g. Hormonal Contraception): keep the node, hide until mature — no
  fold/unfold churn. Fold decision becomes SUBJECT vs DETAIL, not big vs small
  (ARCHITECTURE "existence vs visibility").
- **2b. `taxonomy_maintenance` job** (cadence 2): topic **centroid embeddings**
  (mean of member-claim vectors); propose split when claims form ≥2 clusters,
  merge near-duplicate topics, re-home drifted claims. Safe proposals on
  unreviewed AI topics auto-apply; the rest → review queue. Replaces the manual
  curation done by hand on 2026-07-28.
- Together these let the tree absorb hundreds of sources without hand-curation.

### 3. Incremental-update gaps (VERIFIED built core; fix these before the article build)
`update_topic`→`updateTopicContent` (`lib/synthesis.ts:517`) genuinely does
section-level regen (reuses unchanged sections byte-for-byte, 3 tiers, patient
re-translation). Gaps:
- **3a. `stale_topics()` subtree bug (HIGH).** Flags a topic only on DIRECT new
  links, but articles are built from the recursive subtree (`topic_claims`) — a
  claim under a child never restales the parent, whose article then silently
  omits it. Fix: mirror `topic_claims`' `WITH RECURSIVE` subtree in
  `stale_topics` (`005.2_...sql`).
- **3b. Protocol propagation.** `updateTopicContent` never touches
  `topic_protocols` → protocol goes stale until a full regen. Add an actionability
  check + protocol regen in the incremental path.
- **3c. Per-section versioning.** Persist the changed-section set + timestamps so
  the "what's new since last visit" delta has a source.
- **3d. Coherence-valve baseline.** Measure growth since the last FULL build (not
  last version) and add the "every N updates" counter (`synthesis.ts:488`).

### 4. Bug-audit findings — 2026-07-28 (mergeTopics-class latent bugs)
A read-only audit (prompted by the now-fixed `mergeTopics` cycle-guard bug) found
7 more. **Verify each with a quick repro before fixing;** several are the
silent-truncation / checkpoint class that already corrupted state twice.
- **HIGH — `stale_topics` subtree** — same as §3a.
- **MED/HIGH — `enrichClinician` unpaginated `.in()`** (`synthesis.ts:86-89,101`):
  member-quote read (one row/member) truncates at 1000 → large-topic articles
  render with missing quotes / `[R#]` citations. Route through `selectAllPaged`.
- **MED — `recomputeTopicCounts` counts retired/merged claims** (`taxonomy.ts:639`):
  no `claims.status='active'` filter (unlike `topic_claim_count`) → `claim_count`
  overcounts → discovery keeps splitting topics that aren't over-broad.
- **MED — `discoverTopics` loses its reflag set on a budget yield**
  (`taxonomy.ts:611`): a topic created just before the time cutoff is never
  reflagged on resume → new topic stays empty, claims never re-filed.
- **MED — sweep auto-merge drops the loser's distinct topics + can't re-tag the
  winner under `SKIP_TAGGING`** (`consolidation.ts:352,459`; `worker.ts:180`):
  `mergeClaims` doesn't move the loser's `claim_topics` and no `tag_claims` is
  enqueued → a claim can vanish from a topic during a freeze. Move `claim_topics`
  in `mergeClaims`, or enqueue tag on merge.
- **MED/LOW — `recomputeAggregates`/`enrichClaimCanonical` cap member reads at
  1000** (`consolidation.ts:281,250`): undercounts corroboration for a
  >1000-member claim (scale-dependent).
- **LOW — `extractReferences` non-idempotent resume** (`references.ts:119`): crash
  between insert and heartbeat re-inserts mentions (downstream dedups; only wastes
  work).
- Verified **SAFE** (not bugs): reparent/mergeTopics guards (post-fix),
  `consolidateSource` resume, `sweepClaims` keyset cursor, `scoreGroundedness`→null
  on error, `discoverTopics` orphan paging.

### 5. Harness hardening — before scaling to hundreds of sources
- **Tests / CI** on the pure functions (`splitIntoChunks`, `outlineToMarkdown`,
  `slugify`) AND the curation/pipeline ops (topicOps, pagination discipline,
  checkpoint/resume). The 7 bugs above are the argument for this.
- **Deployed worker + budget**: move the drain off the laptop to the Vercel worker
  (needs Vercel Pro for sub-daily cron + 300s) and top up API credit / wire the
  Batch API for the synthesis build. Local CLI stays the tool for quota-cheap
  maintenance; API/Batch is for the one-time big build.
- **Spend cap** wired into the `generate_topic` enqueue path.

### 6. THEN: the v4 synthesis engine + first article build (Phase 3)
Only after 1–5: build the v4 synthesizer (spec §5/§8 — sentence-block schema,
per-section audit, min-claims + groundedness gates; the gates ARE the §2a
visibility gate), generate articles once for topics past the gate, validate
quality, then run in incremental mode.
