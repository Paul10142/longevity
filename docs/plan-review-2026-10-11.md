# Plan and design review — 2026-10-11

Written for Paul's return after six idle weeks. Everything below was re-measured
today against the live database (`vgzcrihdxcoozgcqadbt`), the code on `main`
(`1e432e7`), and the `claude` command-line tool. Nothing was changed: no code,
no data, no pipeline run. Numbers in this file are today's, not carried from
notes. Phone-readable version: https://claude.ai/artifact/EJBPiNJZHaM5RiZrtYFhw6

## 1. The short answer

The data model is sound and worth keeping. Three things are not designed
properly, and they explain why the project stalled:

1. **The duplicate check misses about half of real duplicates.** On nine
   episodes the library holds twice (once from YouTube captions, once from a
   Deepgram transcript), only 50% of the second copy's facts were merged into
   the first. 42% of the misses sit just under the 0.80 similarity gate, in the
   0.75–0.80 band the engine never examines.
2. **Every AI call carries 13× the context it needs.** The pipeline runs each
   call as a full Claude Code session: hooks, plugins, tool definitions and
   settings load every time. One dedup judgement costs 52,000 tokens and 8.6 s;
   the same judgement with that stripped costs 4,000 tokens and 3.3 s, same
   verdict. This is why subscription usage limits kept stalling overnight runs.
3. **The plan ingests everything before producing a single new-style article.**
   The product (the physician reference and protocols) has never been generated
   by the engine the whole plan is built around. Every step added since July
   pushes that first output further out.

The August "consolidation timeout" was not a database failure. The database never
recorded a pipeline statement over 8 seconds. The run was starved by the AI-call
path, and the two timeouts at the end were the last symptom, not the cause.

Recommendation, in one sentence: fix the call path and the vector storage this
week (small, no spend), reorder the plan so the caption redo comes before any
re-sweep and before the review push, pull the new synthesis forward onto the 92
clean sources, and decide whether to fund the API for the bulk work (about
$120–370 all-in) or keep the laptop as the only engine.

## 2. Where things stand (verified today)

| | Count |
|---|---|
| Sources | 567 (199 extracted: 102 YouTube-caption, 75 Deepgram, 17 FoundMyFitness, 5 manual) |
| Raw insights | 36,375 (caption 19,887 = 55%; Deepgram 12,179; FMF 3,573; manual 736) |
| Active claims | 31,574 (89.1% single-member; 8.6% two members; 2.3% three or more) |
| Claims by transcript quality | caption-only 16,850 (53%); mixed 1,318 (4%); good-transcript-only 13,406 (42%) |
| Speaker named | caption 30%, Deepgram 73%, FMF 79% of insights |
| Pending merge reviews | 213 (all "same" verdicts below the auto-merge bar); 117 involve a caption-era claim |
| Claims needing tagging | 29,841 (tag job parked since Aug 4); 89 active topics; 55 old-engine articles |
| Unconsolidated insights | 178 (one source's tail) |
| Database | 958 MB, Postgres 17.6, Micro compute (1 GB RAM, 224 MB buffer cache) |
| Last write | 2026-08-28 13:56. Nothing has run since. |
| Code | `tsc` clean, 95/95 tests pass, `claude` CLI logged in and working |

Open jobs are unchanged: 4 extract, 1 consolidate (the one that failed), 1 parked tag job.

## 3. The August blocker, diagnosed

**What was recorded.** Two errors, both on 2026-08-28: "enrich: failed to update
claim … TimeoutError: The operation was aborted due to timeout" at 12:15, and
"Failed to reconcile claims … TimeoutError" at 13:56, plus one "fetch failed".
Those are the application's own 30-second abort (`lib/supabaseServer.ts`) and a
network failure. A Postgres statement timeout reads differently ("canceling
statement due to statement timeout") and none was recorded.

**What the database shows.** It has run continuously since 2026-07-30. Statement
statistics since then, pipeline paths only:

| Statement | Calls | Mean | Max |
|---|---|---|---|
| `match_claims` (vector search) | 44,897 | 173 ms | 7.9 s |
| insert claim | 28,002 | 126 ms | 5.4 s |
| update claim (enrich rewrite) | 2,918 | 326 ms | 2.5 s |
| update claim (aggregates) | 4,021 | 75 ms | 2.7 s |
| `reconcile_claim_membership()` | 511 | 1.2 s | 7.8 s |

The tail is bad, and the reason is size: the claims vector index is 251 MB and the
vectors in `claims` and `raw_insights` another ~550 MB, on an instance with a
224 MB buffer cache. Every search and every insert walks that index from disk
part of the time. It will get worse linearly with the corpus: at 100k claims the
index alone would be ~800 MB on a 1 GB machine.

Write amplification adds to it. Three of the columns the pipeline updates on
every attach (`enriched_at`, `max_importance`, `needs_tagging`) are indexed, so
76% of claim updates are not in-place updates: each one writes a new row version
and a new entry into the vector index for a vector that did not change.

**What the throughput shows.** Consolidation jobs on 2026-08-27 ran at 8–56
insights per minute (median ~15) at the same corpus size. From 21:00 that
evening the rate collapsed: 13, 11, 15, 4, 2, 1, 2 new claims per hour, then
nothing from 04:00 to 10:00. Extraction produced zero insights between 21:00 and
10:00, and the extraction job for one source restarted from scratch three times
(21:52, 23:47, 00:35; a restart happens when the job fails before its first
checkpoint). A database that answers in under 8 seconds cannot produce two claims
an hour. Only the AI-call path can: the `claude` CLI being rate-limited,
throttled, or slow. The supervisor's log was not captured, so the exact failure
mode that night is unrecorded.

**Two code behaviours made it worse.** A failed vector search is silently treated
as "no candidates", so the insight becomes a new claim with no duplicate check
at all (`consolidateSource` and `sweepClaims` ignore the RPC error). And
extraction runs 16 chunks at a time as one all-or-nothing batch: one failed call
discards fifteen successful ones and redoes them, so intermittent CLI failures
collapse progress super-linearly.

**Conclusion.** Restarting extraction without fixing the call path would repeat
August. Lowering the duplicate gate without fixing the vector storage would send
3× more candidates through a search that already spikes to 8 seconds.

## 4. New finding: each AI call carries 13× the context it needs

Measured today with the real dedup prompt and five candidate claims:

| How the CLI was called | Context tokens | Wall / API time | API-equivalent cost | Verdict |
|---|---|---|---|---|
| As the pipeline does today | 52,000 | 8.6 s / 5.3 s | $0.34 | SAME, enrich |
| No MCP servers, no settings/hooks | 17,000 | 3.0 s / 2.1 s | $0.061 | SAME, enrich |
| Also no built-in tools | 4,000 | 3.3 s / 2.2 s | $0.031 | SAME, enrich |

The pipeline spawns `claude -p` with Paul's full setup: every session-start hook
(the Vercel plugin, chrome-devtools, the GitHub helper, lavish), the plugin
catalogue, all built-in tool definitions, and the user-level instructions. The
prompt the call actually needs is about 1,100 tokens. Over the ~45,000 dedup
calls made so far that is on the order of 2 billion tokens of overhead against
the subscription's usage windows. It is a four-flag change in `lib/llm.ts`
(`--strict-mcp-config --mcp-config <empty> --setting-sources "" --tools ""`),
and it also removes the hook scripts' network calls from the spawn path.

## 5. The duplicate check: how much it misses

Three independent measurements, all today.

**Nearest neighbours (200 random active claims).** For each claim, how similar
is the closest other active claim?

| Band | Claims | Already examined |
|---|---|---|
| ≥ 0.86 | 0 | |
| 0.80–0.86 | 9 (4.5%) | 6 have a near-duplicate link |
| 0.75–0.80 | 54 (27%) | none |
| 0.70–0.75 | 64 (32%) | none |
| < 0.70 | 73 (36%) | |

**Twin episodes (a natural experiment).** Nine episodes exist twice: a YouTube
caption transcript extracted in July/August, then the same episode's Deepgram
transcript extracted later. The second copy's facts should mostly merge into the
first.

| | Count |
|---|---|
| Deepgram insights on the 9 twin episodes | 1,569 |
| Merged into a claim holding the caption twin's fact | 782 (50%) |
| Not merged, best caption-twin match ≥ 0.80 | 28 |
| Not merged, best match 0.75–0.80 | 327 (42% of the misses) |
| Not merged, best match 0.70–0.75 | 196 |
| Not merged, best match < 0.70 | 236 |

Two transcripts of one episode do not yield identical facts, so 100% is not the
ceiling. But a gate at 0.75 would have put 327 more known duplicates in front of
the adjudicator; the 28 above 0.80 were seen and judged different or fell
outside the five candidates it is shown.

**Adjudicating the excluded band (read-only, run today).** The sampler found 31
pairs whose nearest neighbour sits in 0.75–0.80 (it ran out of fresh pairs before
40) and the production adjudicator judged all 31. **26 of 31 (84%) are the same
fact**, 5 are different, none unsure. The result is flat across the band: 15 of
17 at 0.750–0.775, 11 of 14 at 0.775–0.800. The five "different" verdicts read
correctly (one is a 10-year versus 5-year colonoscopy interval, a contradiction
to surface, not a merge). Combined with the 27% of claims whose nearest
neighbour sits in this band, roughly a fifth of the library is un-merged
duplicates that the gate alone keeps apart. This reverses the August verdict
"do not lower the threshold": that verdict rested on inspected pairs at
0.82–0.87 and on a sweep at 0.86, a different band. Output:
`scratchpad/gated-pairs-eval-20261011.txt`.

**What to change.**

- Lower the ingestion gate to 0.75 (as approved on 10-03), and set the corpus
  sweep to the same gate. Today the sweep runs at 0.86, stricter than ingestion,
  which is why the August sweep found 14 merges in 11,502 claims: at 0.86 nothing
  is left.
- Raise the candidate count from 5 to 8–10 so a true match is not pushed out by
  near-topic neighbours.
- Treat a failed vector search as a failure, never as "no candidates".
- Refresh a claim's vector after an enrich rewrite. Today a claim with six
  members is still found by the vector of its first member.
- Move the vectors out of the hot `claims` row into a side table (or store them
  as half-precision / 512-dimension vectors, which the OpenAI model supports by
  truncation). This stops every attach rewriting the index and shrinks it to fit
  in cache. Measure `match_claims` before and after; upgrade the compute tier
  ($15/month for 2 GB) only if still needed.

## 6. The caption redo is bigger and simpler than the notes say

The notes describe "redo the 107 YouTube-caption sources via Deepgram". The data
says:

- 243 caption sources exist: 121 are linked to a feed episode, 122 are not.
- Of the 122 unlinked, 118 carry an episode number in the title and **102 have a
  pending feed row with the same number**. They are duplicate rows for the same
  episode, created because the linking step keyed on a column these rows never
  had. The "YouTube-only" set is really 4 videos (three AMA previews and one
  early-format episode).
- 20 caption sources already have a Deepgram row for the same episode; 9 of
  those are extracted twice today (the twin episodes above). Their caption
  claims are already superseded.

So the redo is: transcribe the remaining 329 feed episodes (208 pending feed
rows + 121 linked caption rows), extract them, and retire the caption rows'
claims. There is no separate YouTube-audio path to build.

**Retirement needs rules the notes do not have yet.** "Remove the caption
members, never delete claims" is right but incomplete:

- 16,850 claims are caption-only: removing their members retires them (the
  existing reconcile function does this).
- 1,318 claims mix caption and good-transcript members. Their canonical text was
  rewritten by enrich-merge to carry every member's detail, including the
  caption member's, so after removal the text may assert something no surviving
  member says (and caption transcripts carry transcription errors). Those claims
  must be re-enriched from the surviving members, or reset to the surviving
  seed, as part of retirement.
- A claim's vector is its first member's vector. Where that member is removed,
  re-seed the vector from a survivor.
- 117 of the 213 pending merge reviews involve a caption-era claim. Reviewing
  them now is work that the redo throws away. Hold the queue until after.

Cost: 329 episodes at roughly 1.5–1.8 hours each is 490–590 hours of audio.
Deepgram at $0.34/hour is $165–200. The ledger shows $59 spent of the $200
credit, so about $141 remains: the redo runs $25–60 short.

## 7. Sequencing

The order agreed on 10-03 was: fix the timeout → lower the gate and re-sweep the
whole corpus → redo the caption sources → Huberman. Two problems:

- The re-sweep would adjudicate 16,850 claims that the next step retires, and
  Paul would review pairs that the next step retires.
- Nothing produces a new-style article until all of it is done. Principle 4 of
  the architecture ("prove it on a little, then pour in the ocean") is being
  applied to the engine but not to the product. The 92 good-transcript sources
  already hold 13,406 clean claims, more than enough to build and judge the
  synthesis on.

Proposed order:

**A. Make the engine safe to run (this week, no spend).** The CLI call fix;
supervisor logs written to disk; failed searches fail loudly; per-chunk rather
than per-batch retry; the vector storage change; gate 0.75 on both paths and a
larger candidate list. Verify on the 18 Deepgram sources already transcribed and
waiting (free on the CLI).

**B. Ingestion (unattended, in the background).** Transcribe and extract the 329
feed episodes; retire the caption claims under the rules in §6; then re-sweep
once, at the new gate, over a corpus that is all good transcripts. Harness
choice in §8.

**C. The product, in parallel with B.** Un-park tagging for clean claims only;
build the v4 sentence-level synthesis per the spec on the 92 good sources; get
3–5 clinician articles plus protocols through the gate; Paul reads them as the
reviewing physician. This is the checkpoint the risks document calls E2, and it
has never happened.

**D. Only after C passes:** Huberman and further feeds, the full build.

## 8. Costs, derived from today's numbers

**Remaining work:** ~350 sources (329 feed + 18 Deepgram-ready + a few others),
about 16,000 transcript chunks and roughly 58,000 new insights. At a 0.75 gate
about 40% of insights reach the adjudicator (today ~14% at 0.80): ~23,000
judgements, plus ~6,600 if the existing 16,500 good-transcript insights are
re-consolidated at the new gate.

**On the API** (list prices; Batch halves everything and is fine for this work):

| | Current models (Haiku 4.5 / Opus 4.8) | Same, with Batch | Newest models (Haiku 5.5 / Sonnet 5.5), Batch |
|---|---|---|---|
| Extraction, ~16k chunk calls | ~$110 | ~$45 | ~$6 |
| Dedup, ~30k judgements | ~$240 | ~$120 | ~$50 |
| Enrich rewrites, ~5k | ~$15 | ~$8 | ~$1 |
| **Total** | **~$370** | **~$175** | **~$60** |

Two-tier adjudication (a cheap model screens, Opus only on borderline pairs) lands
between the second and third columns with no quality change on the hard cases.
The Batch path is not built yet; it is one to two days of work and the natural
home for bulk runs because nothing here is latency-sensitive.

**On the laptop CLI** (after the call fix): roughly 13 minutes extraction plus
10–15 minutes consolidation per source, so 8–10 days of continuous uptime for
350 sources, assuming no sleep, no network drop and no usage-limit stall. August
lost about a third of its nights to those. The default CLI configuration spends
about $0.34 of usage-equivalent per judgement; the fixed one about $0.03.

**Deepgram:** $165–200 for the 329 episodes against ~$141 of credit.

## 9. Design verdict

**Keep.** The layered model (immutable insights, re-derivable claims, reversible
merges, member-level provenance); the checkpointed job queue; enrich-merge with
the fidelity guard; speaker-attributed Deepgram transcripts; the human-owned
taxonomy spine with the root gate; the 1000-row paging discipline; shadow-mode
fidelity flags; the visibility gate on thin topics.

**Change.** The six items in §5; the retirement rules in §6; the call path in
§4; batch-level retry in extraction; supervisor logging; the sweep gate.

**Defer, stated so nobody builds them early.** Corroboration counting (needs
per-episode speaker ids first; unnamed co-hosts still collapse to null); the
experts table; consensus labelling; Huberman and other feeds; the mobile review
inbox; the taxonomy maintenance job.

**Still unmeasured, and it matters.** The extraction-fidelity judge failed its
certification (κ = −0.11) and the 9 re-checks are still Paul's. Until a judge is
certified, no claim can be quarantined automatically, and the synthesis gate in
C is the only check between an invented detail and a physician.

## 10. Decisions for Paul

1. **Engine for the bulk work.** Fund the API (~$60–370 depending on model and
   Batch; runs unattended in a day or two) or keep the laptop CLI only (free,
   8–10 days of uptime, fragile). Recommendation: fix the CLI regardless (it is
   needed for evaluation work), and fund the API for the bulk runs.
2. **Deepgram budget.** Top up roughly $60, or stop 50–70 episodes short of the
   full catalogue. Recommendation: top up.
3. **Order of work.** Accept the A → B ∥ C → D order above, with the caption redo
   before any re-sweep. Recommendation: yes.
4. **Duplicate gate.** 0.75 on both ingestion and sweep, candidate list 8–10.
   Recommendation: yes, given §5.
5. **Merge reviews.** Hold the 213 until after the caption redo. Recommendation:
   hold.

## Appendix: how the numbers were obtained

- Counts: direct SQL against the live project, 2026-10-11 20:30–21:30 UTC.
- Statement statistics: `pg_stat_statements` (reset 2026-07-30, i.e. the whole
  v4 era); instance settings from `pg_settings`; the vector index size from
  `pg_indexes`.
- Throughput: `jobs.progress` and `pipeline_runs` for 2026-08-26/27/28; claims
  and insights created per hour from `created_at`.
- CLI measurements: `claude -p --output-format json` with the production V3
  adjudication prompt and a five-candidate protein-intake example; usage fields
  are the CLI's own.
- Nearest-neighbour sample: 200 random active claims, lateral search on the
  HNSW index. Twin episodes: caption rows whose title number matches an
  extracted Deepgram row's `episode_number`; "merged" means both copies' insights
  are members of one claim; best-match similarity computed over the caption
  twin's claims.
- 40-pair adjudication: `scripts/evalCandidateThreshold.ts --n 40 --lo 0.75
  --hi 0.80 --full`, output in `scratchpad/gated-pairs-eval-20261011.txt`.
- Prices: Anthropic list prices as of 2026-10-06 (Opus 4.8 $5/$25, Opus 5.5
  $4/$20, Sonnet 5.5 $2/$10, Haiku 4.5 $1/$5, Haiku 5.5 $0.10/$0.50 per million
  tokens in/out; Batch −50%; cache reads at 10%).
