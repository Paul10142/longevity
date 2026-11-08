# Extraction Reproducibility Plan

**Status:** plan only, nothing built. Written 2026-11-08 on branch
`claude/extraction-reproducibility-plan-f7ad7a` from read-only queries against the
LifestyleAcademy database and a read of the pipeline code. No pipeline code was changed
and no extraction was run.

**Paul's requirement (2026-11-08):** one extraction pass must capture every fact in a
transcript, and a second pass over the same or a near-identical transcript must yield
nothing new. "Having over 30 facts different from the almost exact transcript means that
something we're doing is incorrect."

**Measured today:** 16–44% of each copy's facts are pass-specific on the three Drive
episodes that exist twice (section 1). The target this plan proposes is **under 5%**
pass-specific facts per pass, with a stretch goal of 2%.

---

## 0. Summary

1. **Most likely single cause.** Extraction is written as a *selective* step. The
   production prompt says "Your job is NOT to capture everything that was said … Prefer
   FEWER, HIGHER-VALUE, GENERALIZABLE insights" (`lib/extraction.ts:70`), and PR #59's v2
   prompt keeps "Prefer FEWER, FAITHFUL insights over many loose ones". A model told to
   pick the best few from each chunk, at the provider's default sampling, picks a
   *different* few each time. That is the ~40% of pass-specific facts that sit on a
   passage the other pass never quoted, and most of the ~25% that quote overlapping but
   differently-scoped text. No consolidation change can recover a fact that was never
   extracted.
2. **Second cause, independent and fully measured.** When both passes *did* extract the
   same sentence (identical direct quotes), 21 of 84 such pairs across the three episodes
   still ended in different claims. **None of the 21 ever reached the judge**: there is no
   `claim_links` row between them, which the code writes for every judged pair. They were
   lost at candidate retrieval, which is embedding-only. Seven of the 21 have statement
   similarity below today's 0.70 floor (minimum 0.54), so lowering the floor cannot
   reach them; only a gate on quote overlap can. The judge prompt is not implicated.
3. **Third cause, structural.** Transcripts stored from Deepgram or Drive have no blank
   lines, so chunking takes the character-count path: 2,400-character windows cut
   wherever a space falls, with a 200-character overlap. Zero or one of 68 chunks per
   copy starts on a speaker turn. A small upstream difference (a hygiene edit, a
   transcription difference) moves every later boundary, and the overlap makes the same
   sentence extractable twice.
4. **Temperature 0 is not a lever here.** The subscription backend shells out to the
   `claude` CLI, which exposes no sampling flag; the API backend sends none and the
   current API version rejects `temperature` on every model; the judgment models always
   think. Reproducibility must come from the prompt, the chunk boundaries and the merge
   gate, and be *measured*, not assumed.
5. **First experiment:** E1 in section 5. Extract one copy of episode #183 twice with the
   current production settings, file-only, and score the two passes against each other
   with the harness in section 3. Two passes, about 20 minutes, about 0.5M content tokens
   (roughly 3.6M including the CLI's fixed per-call context, mostly cache reads). It
   establishes the noise floor every fix is judged against and proves the harness before
   any fix is spent on.
6. **Recommended order:** E1 noise floor → E3 exhaustive prompt → E4 speaker-turn
   chunking → E5 completeness pass → E6 quote-gate replay, stopping as soon as both the
   same-copy and cross-copy pass-specific rates are under 5%. Whole programme ≈ 21 passes
   of #183, ≈ 3.5 hours of wall-clock, ≈ 5M content tokens (≈ $60 at API list prices
   if it were billed that way; on the subscription it is plan usage governed by the
   usage guard). Cost table in section 5.

---

## 1. What Was Measured (Read-Only, 2026-11-08)

### 1.1 The Three Doubled Episodes

| Episode | Copy | Source id | Words | Chunks | Chunks starting on a speaker turn | Insights | Model | Extracted |
|---|---|---|---|---|---|---|---|---|
| #183 James Clear | A | `291281d6` | 28,507 | 68 | 1 | 217 | Haiku 4.5 | 2026-08-25 |
| #183 James Clear | B | `3d6c7c5f` | 28,511 | 68 | 0 | 217 | Haiku 4.5 | 2026-08-28 |
| #349 AMA 71 | A | `4dc340cb` | 18,927 | 46 | 0 | 176 | Haiku 4.5 | 2026-08-25 |
| #349 AMA 71 | B | `a6b68b62` | 18,828 | 46 | 1 | 169 | Haiku 4.5 | 2026-08-26 |
| #311 Longevity 101 | A | `e3e168c4` | 13,570 | 32 | 1 | 111 | Haiku 4.5 | 2026-10-19 |
| #311 Longevity 101 | B | `016c8308` | 13,429 | 33 | 0 | 103 | Haiku 4.5 | 2026-08-25 |

All six transcripts have speaker labels (`Name:`) and per-utterance timing, and none has a
blank line, so every one was chunked by `forceSplit` (character windows). Average chunk
2,350–2,394 characters, average chunk span 143–167 seconds. The #183 copies differ by 30
characters in 152k, yet their chunk start times differ by 100–144 s for 67 of 68 chunks:
a timing offset between the two recordings' timestamps, which means **time windows
cannot be used to match facts across copies**; quotes located in the transcript text can.

### 1.2 Pass-Specific Facts After Consolidation

A fact is *pass-specific* when its claim holds members from only one copy of the episode.

| Episode | Side | Insights | Pass-specific | Rate | Judged against the twin and kept separate | Linked to some other claim only | Never reached the judge |
|---|---|---|---|---|---|---|---|
| #183 | A | 217 | 49 | 23% | 0 | 0 | 49 |
| #183 | B | 217 | 34 | 16% | 0 | 1 | 33 |
| #349 | A | 176 | 78 | 44% | 1 (no verdict note) | 11 | 66 |
| #349 | B | 169 | 72 | 43% | 0 | 10 | 62 |
| #311 | A | 111 | 40 | 36% | 1 (`judge:SAME`, low confidence) | 5 | 34 |
| #311 | B | 103 | 36 | 35% | 0 | 5 | 31 |

"Never reached the judge" = the claim has no `claim_links` row at all. `consolidateSource`
writes a `near_duplicate` link with a `judge:…` note for every candidate pair the judge
sees, so no link means no candidate cleared the embedding floor when the insight arrived.

### 1.3 Identical Quotes That Still Split

Pairs of insights, one per copy, whose direct quotes are character-identical after
whitespace folding (quotes of 40+ characters):

| Episode | Identical-quote pairs | Merged into one claim | Split into two claims | Split pairs with statement similarity < 0.70 | 0.70–0.80 | ≥ 0.80 |
|---|---|---|---|---|---|---|
| #183 | 38 | 31 | 7 | 5 (min 0.54) | 1 | 1 |
| #349 | 32 | 23 | 9 | 1 | 5 | 3 |
| #311 | 14 | 9 | 5 | 1 | 3 | 1 |

Every one of the 21 split pairs shows "no link" between the two claims: they were never
judged against each other. The #183 and #349 copies were consolidated in August at the
0.80 floor; at today's 0.70 floor 14 of the 21 would now reach the judge, 7 would still
not. Example from #183 (similarity 0.54, same quote): "Building a behavioral identity
occurs through repeated small consistent actions" versus "Beginning a meditation practice
with two minutes daily establishes both the identity of being a meditator and…". Same
sentence, two scopings, embeddings far apart.

### 1.4 What the Parent Session Measured (Quote Overlap, Pre-Consolidation)

Of the pass-specific facts: about one third quote the same passage as a fact in the
other copy (overlap ≥ 0.5, often identical) yet never merged; about a quarter partly
overlap adjacent text (0.2–0.5, different scoping); about 40% sit on a passage the other
copy never quoted at all (per-pass recall gap). Insight time windows are chunk-sized, so
only quotes are usable for this.

### 1.5 Where Sampling Is Decided in the Code

- `lib/extraction.ts:70` — the selectivity instruction quoted above; `:99` repeats it
  ("Produce an insight ONLY if it is: conceptually important; generalizable…").
- `lib/extraction.ts:340–390` — `splitIntoChunks`: paragraph path only when `\n\n` is
  present, otherwise `forceSplit` on 2,400-character windows with a 200-character
  overlap, boundary chosen at the last space, period, `!`, `?` or newline in the final
  300 characters.
- `lib/extraction.ts` `extractSource` — order for a fresh run is
  `normalizeYouTubeSegments` → `buildTranscriptFromSegments` (single-space join, no
  paragraphs) → `stripNonContent` (a Haiku LLM pass, itself non-deterministic) →
  `splitIntoChunks` → `computeChunkTimings` (40-character anchor search) → 16-way
  concurrent `extractFromChunk`. Insights inherit the chunk's time window.
- `lib/llm.ts` — `spawnClaudeCli` passes `-p --model <id> [--effort]` and nothing about
  sampling; `apiText` sends model, max_tokens, system, messages, adaptive thinking and
  effort. No `temperature`, `top_p` or `top_k` anywhere.
- `lib/consolidation.ts` — `CANDIDATE_THRESHOLD` 0.70, `CANDIDATE_COUNT` 8,
  `AUTO_MERGE_CONFIDENCE` 0.80; `adjudicate` shows the judge only the new statement and
  the candidates' canonical statements, never a quote or chunk; an insight with no
  candidate above the floor seeds a new claim with no link.
- `lib/deepgramSegments.ts` — every utterance is its own segment (median ~3 s) with the
  speaker label once per turn: the deterministic boundary material already exists.

---

## 2. Diagnosis

Ranked by share of the problem and by confidence.

| # | Cause | Evidence | Share of pass-specific facts it explains |
|---|---|---|---|
| 1 | **Selective prompt at default sampling.** The model is asked to choose the best few per chunk; each pass chooses differently. | Prompt text (1.5); 40% of pass-specific facts have no counterpart passage; 25% overlap but with different scope; identical transcripts give 217 vs 217 insights with only ~165 shared. | ~60–65% |
| 2 | **Embedding-only candidate retrieval.** Same-passage facts phrased differently never meet in the judge. | 0 of 21 identical-quote splits reached the judge; 7 of 21 below any defensible floor; judge never sees quotes. | ~30% (the "same passage, never merged" third) |
| 3 | **Character-window chunking with overlap.** Boundaries move with any upstream change; sentences are cut; overlap double-extracts. | 0–1 of 68 chunks start on a turn; `forceSplit` path confirmed for all six copies; 200-char overlap. | Amplifies 1 and 2 across near-identical transcripts; small on its own for byte-identical input |
| 4 | **LLM hygiene before chunking.** `stripNonContent` is a Haiku call whose removals differ run to run, shifting every boundary. | Code path; not separately measured (same-copy noise floor E1 will include it). | Part of 3 |
| 5 | **Model tier.** Haiku 4.5 follows "exhaustive" instructions less reliably than Sonnet/Opus. | PR #59 measured fidelity gains moving to Opus 5.5; reproducibility not yet measured. | Unknown; E7 measures it |

Not a cause: the judge prompt. It was never given the chance on the identical-quote
splits. Not a lever: temperature (section 4, fix H).

---

## 3. The Metric and the Harness

### 3.1 Definitions

- **Pass.** One complete extraction of one transcript copy: chunk → extract every chunk →
  resolve quotes. Output is a JSON file of insights `{chunk, statement, direct_quote,
  context_note, quote_start, quote_end}` where `quote_start/end` are character offsets of
  the resolved quote in the copy's transcript text (not time: see 1.1).
- **Match.** Two insights from different passes match when either tier holds:
  - *Tier 1, quote:* fold both quotes (lower-case, strip punctuation, collapse spaces,
    split ellipsis quotes into fragments); word-token containment
    `|A∩B| / min(|A|,|B|) ≥ 0.5` with at least 6 shared tokens.
  - *Tier 2, same passage + same meaning:* the two quote spans overlap or lie within 600
    characters of each other in their transcripts (for two copies, offsets are mapped
    through a line-up of the two texts, e.g. a diff anchored on 40-character windows),
    **and** statement embedding cosine ≥ 0.70 (OpenAI `text-embedding-3-small`, same as
    production, negligible cost) or, without network, a lexical similarity ≥ 0.5.
  - *Tier 3, judge (optional, costed separately):* remaining unmatched same-passage pairs
    go to the production adjudicator with both quotes shown; SAME at confidence ≥ 0.80
    counts as a match. Off by default so the headline number has no LLM in the loop.
- **Pass-specific rate.** `unmatched / total` for each pass, reported in both directions
  (A→B and B→A) and as the mean. This is the headline.
- **Passage coverage disagreement.** Split the transcript into speaker turns (or 500-
  character windows when there are no labels). A turn is covered by a pass if any quote
  of that pass lands in it. Disagreement = turns covered by exactly one pass ÷ turns
  covered by either. This is the recall metric and is independent of phrasing.
- **Same-passage miss rate.** Unmatched insights whose passage the other pass *did* quote
  (tier 2 passage test true, meaning test false) ÷ total. These are the consolidation
  misses; the quote gate (fix E) targets them.
- **Secondary:** insights per chunk; share of insights whose quote failed to resolve;
  within-pass duplicates (tier-1 matches inside one pass, the overlap artefact); fidelity
  flag rate from the PR #59 judge on a sample, so an exhaustive prompt cannot pass by
  inventing.

### 3.2 Targets

| Metric | Baseline today | Release target | Stretch |
|---|---|---|---|
| Pass-specific rate, same copy twice | not yet measured (E1) | < 5% each direction | < 2% |
| Pass-specific rate, near-identical copies | 16–44% (post-consolidation, 1.2) | < 5% | < 2% |
| Passage coverage disagreement | ~40% of pass-specific facts have no counterpart | < 5% | < 2% |
| Same-passage misses surviving consolidation | 21 identical-quote splits / 84 pairs | 0 identical-quote splits; same-passage misses < 2% | 0 |
| Within-pass duplicates | not measured | < 3% | < 1% |
| Fidelity flag rate (PR #59 judge) | PR #59's figure for the chosen model | not worse than that figure | — |

### 3.3 The Script

`scripts/evalReproducibility.ts`, modelled on PR #59's `scripts/evalExtractionPrompt.ts`
(same conventions: file-only, resumable per chunk, usage-guard check per pass,
`trackCliCost`, output under `scratchpad/extraction-compare/reproducibility/`).

```
npx tsx --env-file=.env.local scripts/evalReproducibility.ts <command>

fetch <id8> [<id8>…]       Read-only: the copies' transcript, timed_transcript, stored
                           chunks, stored insights and participant line → JSON.
chunk <id8> --mode chars|turns [--hygiene live|cached|off]
                           Chunk locally; writes chunks.json with char offsets and
                           segment-derived timing. Zero LLM cost unless hygiene=live.
extract <id8> --pass <n> [--prompt v1|v2|exhaustive] [--model …]
        [--completeness] [--conc N]
                           One pass over the chunk file → pass-<n>.json. Resumable.
match <id8>:<pass> <id8>:<pass> [--judge]
                           Tiers 1–2 (and 3 with --judge) → match-….json.
report                     REPORT.md + summary.json: every metric in 3.1 for every
                           pass pair, plus cost and wall-clock per pass.
baseline                   Read-only SQL (appendix A) → the numbers in section 1, so the
                           report always shows "before" next to "after".
```

Rules the script enforces: refuses to run `extract` unless `~/.claude/usage-guard/check.sh`
exits 0; never imports `supabaseServer` write helpers (fetch is the only DB access);
concurrency default 8 and refuses 16 while a lane lock from `lib/writerLock.ts` is held
(a live run owns the CLI); every pass records model, prompt version, chunk mode, hygiene
mode, effort, start/end time and CLI cost in its header.

Variant switches reuse PR #59's `extractionConfig()` (`EXTRACTION_PROMPT_VERSION`,
`EXTRACTION_GATE`, `EXTRACTION_REPAIR`, `EXTRACTION_MODEL`) and add
`EXTRACTION_CHUNKING=chars|turns`, `EXTRACTION_HYGIENE=live|cached|off`,
`EXTRACTION_COMPLETENESS=0|1`. The harness should land as a PR on top of PR #59's branch
so the two do not diverge; building it is roughly half a day and costs no LLM calls
until `extract` runs.

### 3.4 Baseline Without Re-Running

The `baseline` command re-issues the appendix A queries. The three doubled Drive pairs
stay the free test bed; the numbers in section 1 are the "before" column for every
report. They measure the *post-consolidation* view; E1/E2 add the pre-consolidation view
for the same episode.

---

## 4. Candidate Fixes

| Fix | What changes | Expected effect | Cost | Risk |
|---|---|---|---|---|
| **A. Exhaustive extraction prompt** | Replace the selectivity paragraph with: list every distinct substantive claim in the chunk, one insight per claim, in the order spoken; completeness over brevity; still "faithful to this chunk only", still one direct quote each; skip only pleasantries, logistics and ads. Keep PR #59's gate and repair. | Largest. Removes the sampling that causes the 40% recall gap and most scoping differences. Insights per chunk likely rise from ~3 to 6–9. | No extra extraction calls. Consolidation (the expensive half, ≈ $3/episode of judge time) scales with insight count: expect 2–3× judge calls per episode unless fix E's within-source dedup trims them. | More low-value facts reach claims (mitigate: keep the kind/importance fields and let synthesis rank, not extraction drop); fidelity drift (mitigate: PR #59 gate + fidelity judge, flag rate is a release criterion). |
| **B. Speaker-turn chunking, deterministic** | Build chunks from whole utterances in `timed_transcript`: group into turns, pack whole turns up to ~2,400 characters, split an over-long turn at sentence ends, **no overlap**. Chunk timing = first/last segment, exact. Fallback to today's splitter when a source has no segments. | Boundaries land on conversational joints and depend only on who spoke when, so near-identical transcripts chunk alike; no sentence is cut in half; the double-extraction artefact disappears. Medium effect across copies, small on byte-identical input. | Code only (`splitIntoChunks` gains a segment-aware path; `computeChunkTimings` becomes unnecessary for it). Zero LLM cost. Chunk counts change, so runbook timing estimates change. | Chunk size variance (a long monologue → several ~2,400 chunks; many short turns → one chunk of many turns, fine). A claim that straddles two turns loses its first half's context: optional 1-turn "context" preamble the model is told not to extract from. |
| **C. Hygiene made stable** | Cache `stripNonContent`'s removals per transcript hash (file or a `sources.hygiene_spans` column), or skip it for feeds whose ads are already cut. | Removes a hidden source of boundary drift and content loss between runs. Small–medium. | Cache: one column + one write per source, cheap. Skip: zero. | Skipping lets ads through on feeds that still carry them: decide per show. |
| **D. Completeness second look (two-pass union)** | After extracting a chunk, a second call sees the chunk and the list already extracted and returns only claims not yet covered; union the two. | Turns a one-shot sample into a near-exhaustive set; directly attacks the recall gap even if fix A under-delivers. Medium–high. | Doubles extraction calls (the cheap half): +68 calls per #183 pass, ≈ +$0.9 Haiku / +$1.9 Sonnet / +$3.4 Opus at list price, +5–10 min wall-clock per episode. | Second call may invent or re-add near-duplicates (mitigate: quote must resolve in the chunk, tier-1 dedup against the first list before union). |
| **E. Consolidation quote gate + quotes shown to the judge** | Beside `match_claims` (embedding), retrieve claims whose members' direct quotes overlap the new insight's quote (word 4-gram shingles or `pg_trgm` similarity on folded quotes, GIN-indexed) and send them to the judge regardless of embedding similarity, including same-source pairs. Show the judge both quotes. Note links as `quote-gate:judge:…`. | Fixes the one-third "same passage, never merged": 21 of 21 identical-quote splits would have reached the judge. Also catches within-pass duplicates from overlap. | Migration (shingle column or trgm index) + ~60 lines in `consolidateSource`; a handful of extra judge calls per episode (≈ 4 s each). Backfill sweep over existing claims is a dry-run-then-apply, no re-extraction. | The judge may still say DIFFERENT when one passage genuinely holds two facts; that is correct behaviour, the point is that the pair is judged. Must coordinate with the dedup lane (88 groups, migration 038 not yet applied). |
| **F. Model tier** | Run extraction on Sonnet 5.5 or Opus 5.5 (PR #59 default) instead of Haiku 4.5. | Better instruction-following for "exhaustive"; PR #59 already showed fidelity gains. Effect on reproducibility unknown until E7. | PR #59 measured per 55-chunk episode: Sonnet 5.5 $1.52 extract / 16 min total; Opus 5.5 $2.72 / 16.5 min; Haiku 4.5 slowest at 89 min. | Opus always thinks, so run-to-run variance may not fall; measure, do not assume. |
| **G. Smaller chunks** | ~1,200 characters (one or two turns). | "Everything in this chunk" is easier to honour in a small chunk. | Doubles call count; each CLI call carries ~26k tokens of fixed context, so this is the most expensive knob per fact. | Loses cross-sentence context. Try only if A+B+D fall short. |
| **H. Temperature 0** | — | **Not available.** The `claude` CLI has no sampling flag; the API backend sends none and the current API version returns 400 for `temperature`/`top_p`/`top_k` on every model; Opus/Sonnet 5.5 and Haiku 5.5 reject non-default values regardless. Even where it existed it would not help the near-identical-copy case, where the inputs differ. | — | Rejected. A one-off diagnostic on Haiku 4.5 through the API backend with an older API version is possible but spends API credits to learn a number E1 learns for free. |
| **I. Within-source twin check** | During consolidation, insights from the same source whose quotes overlap are judged against each other first. | Removes the overlap artefact and gives fix A's longer lists a cheap first dedup. | Part of E. | None beyond E. |

---

## 5. Experiment Sequence on Episode #183

Episode #183 (68 chunks per copy, 28.5k words, copies differ by 30 characters) is the
cleanest pair. Everything below is **file-only** through the harness: no `raw_insights`,
`chunks`, `claims` or `jobs` writes. Nothing runs until the parent session relays Paul's
go, and nothing runs while the Batch 3 extraction is live (it owns the CLI's 16 in-flight
slots and the subscription budget).

**Unit costs per pass of one #183 copy (68 chunks):**

| | Calls | Content tokens | Billed context incl. CLI fixed ~26k/call (mostly cache reads) | Wall-clock at concurrency 8–16 | API list-price equivalent |
|---|---|---|---|---|---|
| Haiku 4.5 (today) | 68 | ≈ 0.25M | ≈ 1.8M | ≈ 10 min | ≈ $0.9 |
| Sonnet 5.5 | 68 | ≈ 0.25M | ≈ 1.8M | ≈ 5–10 min | ≈ $1.9 |
| Opus 5.5 | 68 | ≈ 0.25M | ≈ 1.8M | ≈ 5–10 min | ≈ $3.4 |
| + completeness pass (fix D) | +68 | +0.25M | +1.8M | +5–10 min | + same again |
| Judge replay (E6) | 60–120 | ≈ 0.1M | ≈ 3M | ≈ 5–8 min | ≈ $0.5–1 |

Content tokens ≈ 68 × (1.4k prompt + 0.7k chunk + 1.2k output). Opus/Sonnet figures scale
PR #59's measured $2.72 / $1.52 per 55-chunk episode by 68/55. The parent's "about half a
million tokens per pass" sits between the content and billed-context columns; the usage
guard (`sh ~/.claude/usage-guard/check.sh`) is the real governor on the subscription.

| # | Experiment | Isolates | Passes | Decision rule | Tokens (content / billed) | Wall-clock | List-price equiv. |
|---|---|---|---|---|---|---|---|
| **E1a** | Copy A twice, current production (Haiku 4.5, v1 prompt, char chunks, live hygiene) | Noise floor of today's pipeline; proves the harness | 2 | Always run first. Expect 15–25% pass-specific. | 0.5M / 3.6M | 20 min | $1.7 |
| **E1b** | Copy A twice, PR #59 default (Opus 5.5, v2 prompt, gate+repair, char chunks) | Noise floor of the planned production config; whether PR #59 alone moves the number | 2 | If already < 5%, skip to E4/E5 for the cross-copy case. | 0.5M / 3.6M | 15 min | $6.8 |
| **E2** | Copy B once, PR #59 default; match against E1b's passes | Cross-copy (near-identical) baseline before consolidation | 1 | Gives the pre-consolidation cross-copy number next to 1.2's post-consolidation one. | 0.25M / 1.8M | 8 min | $3.4 |
| **E3** | Exhaustive prompt (fix A), Opus 5.5, char chunks: A×2 + B×1 | The prompt | 3 | Proceed to E4 if same-copy or cross-copy still ≥ 5%, or if fidelity flag rate rose > 2 points vs E1b. | 0.75M / 5.4M | 25 min | $10 |
| **E4** | E3 + speaker-turn chunking, no overlap, cached hygiene (fixes B, C): A×2 + B×1 | Chunk boundaries | 3 | Proceed to E5 if still ≥ 5%. Even if E3 passed, run A×1 + B×1 here (2 passes) because B+C are free in production and should ship. | 0.75M / 5.4M | 25 min | $10 |
| **E5** | E4 + completeness second look (fix D): A×2 + B×1, 2 calls per chunk | Recall top-up | 3 (6 pass-equivalents) | Stop if < 5%; otherwise E7 and consider fix G. | 1.5M / 10.8M | 50 min | $20 |
| **E6** | Quote-gate replay (fix E): take the best configuration's unmatched same-passage pairs and run the production judge with quotes shown, offline | Consolidation gate | 0 (60–120 judge calls) | Report how many surviving pass-specific facts the gate would merge; expect it to clear most of the "same passage" third. | 0.1M / 3M | 8 min | $1 |
| **E7** (optional) | Winning configuration on Sonnet 5.5: A×2 + B×1 | Cheaper production model | 3 | Adopt Sonnet if within 1 point of Opus on every metric. | 0.75M / 5.4M | 25 min | $5.6 |
| | **Total if everything runs** | | 17 passes + 6 completeness pass-equivalents | | **≈ 5M / ≈ 39M** | **≈ 3 h** | **≈ $60** |

Each experiment is approved and run separately; the table is the menu, the "decision
rule" column says when to stop. A likely path (E1a, E1b, E2, E3, E4, E6) is ≈ 2.75M
content tokens, ≈ 1.7 hours and ≈ $33 list-price equivalent.

Preconditions for every run: Batch 3 finished or paused (check `pipeline_runs` and the
lane locks); usage guard green; AC power and `caffeinate`; concurrency 8; output under
`scratchpad/extraction-compare/reproducibility/`; the report posted as an artifact for
Paul with the before/after table, per his review rule.

---

## 6. Already-Extracted Episodes

- **No retroactive re-extraction.** The ~100+ extracted episodes keep their insights.
  Re-extracting them would cost a full pass each (section 5 unit costs) and rewrite the
  provenance Paul has already reviewed.
- **Cheap and safe: the quote-gate sweep (fix E as a backfill).** A sweep over existing
  claims whose members' quotes overlap (within a source, and across twin copies) sends
  only those pairs to the judge; merges only, no `raw_insights` writes. Measure the pair
  count first with one read-only query; expect the 21 identical-quote splits in the
  twins plus a modest number corpus-wide. Dry-run → counts and examples for Paul →
  apply. This belongs with the dedup lane (88 duplicate groups, migration 038) so the two
  do not fight over the same claims.
- **Later, if fix D proves out and Paul approves the spend: a completeness top-up.** The
  second-look call can run against an *existing* episode's chunks with its stored
  insights as the "already covered" list, adding only what is missing. That is one call
  per chunk (half a pass) rather than a full re-extraction, and it is additive, so
  nothing reviewed changes. Cost per 55-chunk episode ≈ 55 calls, ≈ 5–8 min, ≈ $1.5–2.7
  list-price equivalent on Sonnet/Opus; decide per show after seeing E5.
- **Twin copies.** Once the quote gate exists, the three Drive pairs should merge to a
  single set of claims; the caption-retirement plan (`docs/caption-retirement-plan.md`)
  already covers deleting the superseded copy.

---

## 7. Changes to `docs/EXTRACTION_RUNBOOK.md`

To be written when the fixes ship, not now:

1. **§2 "What proceed with extraction runs".** Document the new switches
   (`EXTRACTION_PROMPT_VERSION`, `EXTRACTION_CHUNKING`, `EXTRACTION_HYGIENE`,
   `EXTRACTION_COMPLETENESS`, `EXTRACTION_MODEL`) and their production defaults, and
   state that the runner never changes them mid-batch (a batch is one configuration).
2. **§8 "How long an episode takes".** Chunk counts change with speaker-turn chunking,
   insights per chunk roughly double or triple with the exhaustive prompt, and the
   completeness pass doubles extraction calls: re-measure and replace the 8 min / 17–30
   min figures. Consolidation time grows with insight count; the quote gate adds a few
   judge calls per episode.
3. **§9 lanes.** The consolidate lane gains the quote gate; note the new
   `quote-gate:judge:…` link notes so a reader of `claim_links` knows why a pair was
   judged.
4. **New §15 "Reproducibility gate".** After any change to prompt, model, chunking or
   hygiene, and before a batch: run the harness on one episode per show (E1-style, same
   copy twice) and attach the report; the batch does not start if the pass-specific rate
   is ≥ 5% or the fidelity flag rate rose. Keep the three Drive pairs as the standing
   cross-copy check.
5. **§1 pre-flight.** Add "usage guard green and no harness run in progress" (the harness
   and a live run share the CLI's 16 slots).
6. **§5 reporting.** Add insights-per-chunk and the per-episode reproducibility figure
   (when a twin exists) to the end-of-run report, so drift is seen early.

---

## 8. Recommended Order and the Decisions Paul Owns

1. Approve E1a (the cheapest experiment, ≈ $1.7 list-price equivalent, 20 minutes) and
   the half-day to build the harness on top of PR #59. Nothing else is spent until E1a
   reports.
2. Ship fixes B and C (speaker-turn chunking, stable hygiene) regardless: they cost no
   LLM calls and remove drift. They ride with the next extraction PR.
3. Run E1b/E2/E3; approve E4 and E5 only if the decision rules call for them.
4. Build fix E (quote gate) once E6 shows what it recovers; run its backfill sweep as a
   dry run with the dedup lane.
5. Adopt the production configuration that meets section 3.2; update the runbook per
   section 7; add the reproducibility gate to every future batch.

Open questions for Paul: the release threshold (5% proposed; 2% stretch), whether
"exhaustive" should also keep conversational or anecdotal facts (the prompt change can
keep them as kind `Anecdote` for synthesis to rank, or still drop them), and which
model tier he wants to pay for in production (E7 answers the cost side).

---

## Appendix A. Read-Only SQL Used for Section 1

All queries SELECT only. Replace the six ids with any twin pair.

```sql
-- A1: per-copy facts (table 1.1)
with ids(id) as (values ('291281d6-1ede-41dc-becd-deba77333d7c'::uuid), ('3d6c7c5f-ba1b-4587-8b7d-30cc8e74cd2c'))
select left(s.id::text,8) src, length(s.transcript) chars,
  position(E'\n\n' in s.transcript) > 0 has_blank_lines,
  (select count(*) from chunks c where c.source_id=s.id) chunk_rows,
  (select count(*) from chunks c where c.source_id=s.id and c.content ~ '^[A-Z][a-z]+( [A-Z][a-z]+)*: ') starts_on_turn,
  (select count(*) from raw_insights r where r.source_id=s.id) insights,
  (select min(r.extraction_model) from raw_insights r where r.source_id=s.id) model
from sources s join ids on ids.id=s.id;

-- A2: pass-specific facts and whether they ever reached the judge (table 1.2)
with pairs(a,b) as (values ('291281d6-1ede-41dc-becd-deba77333d7c'::uuid,'3d6c7c5f-ba1b-4587-8b7d-30cc8e74cd2c'::uuid)),
mem as (select ri.id ins_id, cm.claim_id, case when ri.source_id=p.a then 'A' else 'B' end side
        from pairs p join raw_insights ri on ri.source_id in (p.a,p.b)
        join claim_members cm on cm.raw_insight_id=ri.id),
cl as (select claim_id, bool_or(side='A') has_a, bool_or(side='B') has_b from mem group by 1),
spec as (select m.* from mem m join cl using (claim_id) where not (cl.has_a and cl.has_b)),
lk as (select s.*, l.note,
         case when l.claim_id=s.claim_id then l.related_claim_id else l.claim_id end other_claim
       from spec s left join claim_links l
         on l.kind='near_duplicate' and (l.claim_id=s.claim_id or l.related_claim_id=s.claim_id)),
lk2 as (select lk.*, (oc.claim_id is not null) other_is_twin
        from lk left join cl oc on oc.claim_id=lk.other_claim
          and (case when lk.side='A' then oc.has_b else oc.has_a end)),
per as (select side, ins_id, bool_or(coalesce(other_is_twin,false)) judged_vs_twin, bool_or(note is not null) any_link
        from lk2 group by 1,2)
select side, count(*) pass_specific,
  count(*) filter (where judged_vs_twin) judged_vs_twin_kept_separate,
  count(*) filter (where any_link and not judged_vs_twin) linked_elsewhere_only,
  count(*) filter (where not any_link) never_reached_judge
from per group by 1 order by 1;

-- A3: identical quotes that split (table 1.3)
with pairs(a,b) as (values ('291281d6-1ede-41dc-becd-deba77333d7c'::uuid,'3d6c7c5f-ba1b-4587-8b7d-30cc8e74cd2c'::uuid)),
q as (select ca.claim_id cla, cb.claim_id clb, 1 - (ra.embedding <=> rb.embedding) sim
      from pairs p
      join raw_insights ra on ra.source_id=p.a and length(ra.direct_quote) >= 40
      join raw_insights rb on rb.source_id=p.b
        and lower(regexp_replace(rb.direct_quote,'\s+',' ','g')) = lower(regexp_replace(ra.direct_quote,'\s+',' ','g'))
      join claim_members ca on ca.raw_insight_id=ra.id
      join claim_members cb on cb.raw_insight_id=rb.id)
select count(*) identical_quote_pairs,
  count(*) filter (where cla=clb) merged,
  count(*) filter (where cla<>clb) split,
  count(*) filter (where cla<>clb and sim < 0.70) split_below_floor,
  round(min(sim) filter (where cla<>clb)::numeric,3) min_sim_when_split
from q;

-- A4: chunk timing offset between copies (section 1.1)
with a as (select row_number() over (order by start_ms,id) i, start_ms from chunks where source_id='291281d6-1ede-41dc-becd-deba77333d7c'),
     b as (select row_number() over (order by start_ms,id) i, start_ms from chunks where source_id='3d6c7c5f-ba1b-4587-8b7d-30cc8e74cd2c')
select count(*) chunks, round(avg(abs(a.start_ms-b.start_ms))/1000.0,1) avg_drift_s,
       round(max(abs(a.start_ms-b.start_ms))/1000.0,1) max_drift_s
from a join b using (i);
```

## Appendix B. Matching Pseudo-Code

```
fold(q)      = lower(q) → strip punctuation → collapse spaces → split on ' … ' / '...'
tokens(q)    = set of word tokens over all fragments of fold(q)
contain(a,b) = |tokens(a) ∩ tokens(b)| / min(|tokens(a)|, |tokens(b)|)

for each insight x in pass P, y in pass Q:
  tier1 = contain(x.quote, y.quote) >= 0.5 and shared >= 6
  samePassage = spans overlap, or |x.quote_start - map(y.quote_start)| <= 600
  tier2 = samePassage and cosine(embed(x.statement), embed(y.statement)) >= 0.70
  matched(x) |= tier1 or tier2
  (tier3, only with --judge: samePassage and not matched → adjudicate(x, [y], quotes shown))

map()        = char offset in Q's transcript → offset in P's transcript via a
               diff of the two texts anchored on 40-character windows (both copies
               are available to the harness; time is not used, see 1.1)

pass_specific(P→Q) = |{x in P : not matched(x)}| / |P|
coverage(P)        = set of speaker turns containing any x.quote_start, x in P
disagreement       = |coverage(P) Δ coverage(Q)| / |coverage(P) ∪ coverage(Q)|
same_passage_miss  = |{x : not matched(x) and exists y with samePassage}| / |P|
```
