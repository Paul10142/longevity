# Extraction Reproducibility Plan

**Status:** plan only, nothing built. Written 2026-11-08 on branch
`claude/extraction-reproducibility-plan-f7ad7a` from read-only queries against the
LifestyleAcademy database and a read of the pipeline code. Revised the same evening after
Paul set the bar (3:55 PM EST), and again after PR #59 merged to `main` (squash `45d017a`):
Opus 5.5 is Paul's decided extraction model, the v2 prompt, gate and repair round are live,
and the comparison harness `scripts/evalExtractionPrompt.ts` is on `main`. Paul approved the
experiment spend the same evening ("Let's do the experiment spend"). No pipeline code was
changed by this plan, no extraction was run, and nothing was written to the database.

**Paul's bar (2026-11-08):**

> "Why would extraction pass skip some passages? They shouldn't skip anything."
> "Is there a way that, within the processing of a chunk, we can see the context before and
> after to make sure this doesn't happen? These arbitrary things shouldn't affect the
> information that's being included."
> "Having over 30 facts different from the almost exact transcript means that something
> we're doing is incorrect. Running a second pass on material should not yield anything else."

**Design principle that follows:** *recall first.* Extraction captures everything a speaker
asserted; the fidelity judge (already live, κ 0.89 against Paul's gold set) is the safety
net that quarantines anything unfaithful. Omission is the failure we design against; a
doubtful fact goes to the judge, never to the floor.

**Operational state:** Paul has stopped the extraction and consolidation lanes until the fix
lands. Transcription continues. Section 7 gives the criteria for resuming each lane;
section 8 answers whether the 440 episodes already extracted need a second pass (yes, a
targeted one).

---

## 0. Summary

**Why extraction skips passages today (four reasons, all measured):**

1. **We tell it to.** The production prompt says "Your job is NOT to capture everything that
   was said … Prefer FEWER, HIGHER-VALUE, GENERALIZABLE insights" (`lib/extraction.ts:78`),
   and again "Produce an insight ONLY if it is: conceptually important; generalizable…"
   (`:107`). PR #59's v2 prompt, now live on `main`, keeps "Prefer FEWER, FAITHFUL insights
   over many loose ones" (`lib/extractionPromptV2.ts:19`). A model told to choose the best
   few from each slice chooses a different few each time.
   This is the largest cause.
2. **It cannot see across the cut.** A transcript is sliced into 2,400-character windows;
   91% of the cuts land mid-sentence and only 1.4% start where a speaker starts talking.
   The prompt then says every insight must be "FULLY SUPPORTED by THIS chunk". A fact that
   runs across the cut is half-present in each slice, so both slices may drop it. A quarter
   of quoted facts are longer than the 200-character overlap that was meant to cover this,
   and facts only one pass found sit in a slice's edge zones 37% of the time against 29% for
   facts both passes found. This is Paul's "context before and after" question, and
   section 4 answers it with a concrete design.
3. **Randomness.** Explained in one paragraph below. We cannot turn it down on the backend
   we run on; we make the instructions leave it nothing to decide, then measure.
4. **The merge step loses a third of what both passes did find.** When both copies pulled
   out the same sentence word for word, 21 of 84 such pairs still became separate facts, and
   not one of the 21 was ever shown to the judge: they were lost one step earlier, where
   candidates are found by meaning-similarity alone. Seven of the 21 are phrased so
   differently that no similarity bar reaches them; only a "same quoted words" check does.

**Randomness and temperature, in plain words.** Every time the model writes a word it
chooses among several likely next words. "Temperature" is the dial for how adventurous that
choice is: 0 means always take the single most likely word, 1 means pick among the likely
ones in proportion to how likely they are. Our code sets nothing, so the provider's default
applies, which is 1 for the models we use. We run extraction through the subscription's
`claude` command line, which has no such dial at all. The alternative route, the API billed
in credits, lets us set 0 only on the old model we use today (Haiku 4.5) and only under an
older API version; the current API version rejects the dial on every model, and the newer
models always reason before answering, which is itself a source of variation. Even at 0,
two transcripts that differ by a few words would still produce different output, and two
runs over identical words are not guaranteed identical either. So the fix is not to stop
the dice: it is to write the instructions so that the dice have nothing to decide ("list
every fact" leaves no "which few?" choice), to make the slicing deterministic, and to
measure the result.

**Which model extraction runs under:** Haiku 4.5 built everything in the library today: the
lane's workers showed as `claude -p --model claude-haiku-4-5`, and all 69,417 insights carry
`extraction_model = claude-haiku-4-5`. Since PR #59 merged to `main` (`45d017a`, 2026-11-08)
the default is **Opus 5.5** with the v2 prompt, gate and repair round, and Paul confirmed Opus
5.5 as the extraction model. The judge is Opus 5.5 as before. The v2 prompt still says "Prefer
FEWER, FAITHFUL insights", so the recall gap is expected to persist on `main`; E1b measures
how much the model change alone closed.

**First experiments (E1a, E1b):** extract one copy of episode #183 twice, file-only, and
score the two passes with the harness in section 3. E1a uses the configuration that built
the library (Haiku 4.5, v1 prompt): two passes, about 20 minutes, about 0.5M content tokens,
about $1.80 of plan usage. E1b uses what `main` runs today (Opus 5.5, v2 prompt, gate and
repair): two passes, about 40 minutes, about 0.5M content tokens, about $6.70. Together they
show how much of the gap PR #59 already closed and set the noise floor every fix is judged
against. Approved by Paul on 2026-11-08 through the parent window; the lanes stay stopped.

**Resume criteria (section 7):** the extraction lane restarts when, on episode #183, fewer
than 5% of facts are pass-specific (same copy twice and across the twin copies), fewer than
5% of speaker turns are covered by one pass but not the other, and the fidelity flag rate
has not risen more than 2 points. The consolidation lane restarts when the quote gate has
merged the 21 identical-quote splits in a dry run Paul has looked at.

**Already-extracted episodes (section 8):** yes, they need a second pass, because every one
of the 440 was extracted under the "prefer fewer" instruction. The plan proposes a
*completeness top-up* (one extra call per chunk that adds only what is missing, keeping
every existing fact) rather than re-extraction. Cost for the whole library on the decided
model, Opus 5.5: about $1,100 at API prices, or about 49 hours of lane time on the
subscription. A cheaper model (Haiku 5.5 ≈ $25, Sonnet 5.5 ≈ $550) only if E4 shows it
matches Opus on the bar.

**Two billing routes (section 5):** the subscription route (today's `claude` command line,
plan usage, no temperature control) and the API route (credits, temperature 0 available only
on Haiku 4.5, stronger models available). Costed side by side so Paul can choose with
numbers.

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

### 1.5 The Chunk Boundary Effect (Paul's Question)

Over the six copies (925 insights with resolved quote offsets; `quote_char_start/end` are
chunk-relative):

| | Facts both passes found | Facts only one pass found |
|---|---|---|
| Quote lies in the chunk's first or last 300 characters | 29.0% | **36.6%** |
| Quote lies in the 200-character overlap zone | 19.7% | **26.6%** |

The edge zones are 25% of a chunk, so facts both passes found are spread evenly and facts
only one pass found are over-represented at the cuts by about a quarter. Library-wide:
median quoted fact 140 characters, 90th percentile 282, **26% of quotes are longer than the
200-character overlap**; **8.6% of the 21,952 chunks end at a sentence end**, 1.4% start on
a speaker turn. A fact that spans a cut has part of its words in each slice; the prompt's
"FULLY SUPPORTED by THIS chunk" rule then makes it unsupported in both.

### 1.6 Where the Library Stands

440 episodes extracted (69,417 insights, every one Haiku 4.5), 21,952 chunks (≈ 50 per
episode), 237 transcribed sources waiting to be extracted. The waiting 237 will be extracted
under the new configuration and need no top-up.

### 1.7 Where Sampling Is Decided in the Code

- `lib/extraction.ts:78` and `:107` — the v1 selectivity instructions quoted above; `:81` —
  the "FULLY SUPPORTED by THIS chunk" rule. `lib/extractionPromptV2.ts:19` — v2 "Prefer
  FEWER, FAITHFUL"; `:22` — "fully supported by THIS chunk" (the same boundary rule).
- `lib/extraction.ts:47–48` — `DEFAULT_EXTRACTION_MODEL = 'claude-opus-5-5'` (v2, the default
  since PR #59) and `V1_EXTRACTION_MODEL = CLAUDE_BULK_MODEL` (`lib/llm.ts:141`,
  `'claude-haiku-4-5'`, which built the library); `:167` — `extractionConfig()` reads
  `EXTRACTION_PROMPT_VERSION`, `EXTRACTION_GATE`, `EXTRACTION_REPAIR`, `EXTRACTION_MODEL`.
- `lib/extraction.ts:49–50, 283–320` — `CHUNK_SIZE = 2400`, `CHUNK_OVERLAP = 200`, `splitIntoChunks`: paragraph path only when `\n\n` is
  present, otherwise `forceSplit` on 2,400-character windows; the cut is the *last* space,
  period, `!`, `?` or newline in the final 300 characters, which is almost always a space,
  hence 91% mid-sentence cuts; `start = end - 200` gives the overlap.
- `lib/extraction.ts` `extractSource` — fresh run: `normalizeYouTubeSegments` →
  `buildTranscriptFromSegments` (single-space join, no paragraphs) → `stripNonContent` (a
  Haiku LLM pass, itself non-deterministic) → `splitIntoChunks` → `computeChunkTimings`
  (40-character anchor search) → 16-way concurrent `extractFromChunk` (`claudeJson`, 8,000
  output tokens, 3 retries; since PR #59 the v2 path also runs the deterministic gate in
  `lib/extractionGate.ts` and one repair call per chunk). Insights inherit the chunk's time window.
- `lib/llm.ts` — `spawnClaudeCli` passes `-p --model <id> [--effort]` and nothing about
  sampling; `apiText` sends model, max_tokens, system, messages, adaptive thinking and
  effort. No `temperature`, `top_p` or `top_k` anywhere.
- `lib/consolidation.ts` — `CANDIDATE_THRESHOLD` 0.70, `CANDIDATE_COUNT` 8,
  `AUTO_MERGE_CONFIDENCE` 0.80; `adjudicate` shows the judge only the new statement and the
  candidates' canonical statements, never a quote or chunk; an insight with no candidate
  above the floor seeds a new claim with no link.
- `lib/deepgramSegments.ts` — every utterance is its own segment (median ~3 s) with the
  speaker label once per turn: the deterministic boundary material already exists.

---

## 2. Diagnosis

| # | Cause | Evidence | Share of pass-specific facts it explains |
|---|---|---|---|
| 1 | **Selective prompt at default sampling.** The model is asked to choose the best few per chunk; each pass chooses differently. | Prompt text (1.7); 40% of pass-specific facts have no counterpart passage; 25% overlap with different scope; identical transcripts give 217 vs 217 insights with only ~165 shared. | ~55–60% |
| 2 | **Embedding-only candidate retrieval in consolidation.** Same-passage facts phrased differently never meet in the judge. | 0 of 21 identical-quote splits reached the judge; 7 of 21 below any defensible floor; judge never sees quotes. | ~30% (the "same passage, never merged" third) |
| 3 | **Mid-sentence character cuts plus the "this chunk only" rule.** Facts spanning a cut are unsupported in both slices; the 200-character overlap is shorter than a quarter of the facts. | 91% of cuts mid-sentence; pass-specific facts over-represented at edges (37% vs 29%); 26% of quotes longer than the overlap. | ~8–10% directly; amplifies 1 across near-identical transcripts |
| 4 | **LLM hygiene before chunking.** `stripNonContent` removals differ run to run, shifting every boundary. | Code path; same-copy noise floor (E1) measures it together with 1. | Part of 3 |
| 5 | **Model tier.** Haiku 4.5 built the library; Opus 5.5 is now the decided model (PR #59, merged). | PR #59 measured fidelity: 8.9% of insights flagged on Opus 5.5 vs 33.5% on Haiku 4.5; recall not yet measured. | Unknown; E1b measures how much Opus alone closes |

Not a cause: the judge prompt (never given the chance). Not a lever on our backend:
temperature (section 5 costs the API route where it exists, as a diagnostic).

---

## 2b. What PR #59 (Merged 2026-11-08, `45d017a`) Already Covers

| Planned fix | Covered by PR #59? | Note |
|---|---|---|
| F. Model tier | **Yes.** Opus 5.5 is the default extraction model. | Decided by Paul. |
| Fidelity safety net (gate + repair) | **Yes.** `lib/extractionGate.ts` rejects invented numbers and dropped hedges with no model call; one repair call per chunk. | Lets fixes A, B1 and D err toward inclusion. |
| Harness base | **Partly.** `scripts/evalExtractionPrompt.ts` (fetch / extract / judge / report / gate-gold, file-only, resumable) is the pattern; `lib/quoteResolve.ts` resolves quotes. | `scripts/evalReproducibility.ts` adds chunking variants, two-pass matching and the metrics in 3.1. |
| Configuration switches | **Yes.** `extractionConfig()` with `EXTRACTION_PROMPT_VERSION`, `EXTRACTION_GATE`, `EXTRACTION_REPAIR`, `EXTRACTION_MODEL`, documented in `docs/EXTRACTION_RUNBOOK.md`. | Add `EXTRACTION_CHUNKING`, `EXTRACTION_CONTEXT_CHARS`, `EXTRACTION_HYGIENE`, `EXTRACTION_COMPLETENESS`. |
| A. Exhaustive prompt | **No.** v2 keeps "Prefer FEWER, FAITHFUL insights over many loose ones" (`lib/extractionPromptV2.ts:19`). | The largest cause is untouched. |
| B1. Context before/after | **No.** v2 keeps "Every insight must be fully supported by THIS chunk" (`:22`). | Boundary drop unchanged. |
| B2. Speaker-turn chunking, C. stable hygiene | **No.** `CHUNK_SIZE = 2400`, `CHUNK_OVERLAP = 200` and `forceSplit` are unchanged. | |
| D. Completeness second look; E and I. quote gate | **No.** | |

PR #59 measured fidelity (8.9% of insights flagged on Opus 5.5 vs 33.5% on Haiku 4.5 over 8
Attia episodes; inputs and reports copied at `scratchpad/extraction-compare-pr59/`). It did
not measure recall or reproducibility; E1b is the first measurement of `main` on that axis.

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
    through a line-up of the two texts, a diff anchored on 40-character windows),
    **and** statement embedding cosine ≥ 0.70 (OpenAI `text-embedding-3-small`, same as
    production, negligible cost) or, without network, a lexical similarity ≥ 0.5.
  - *Tier 3, judge (optional, costed separately):* remaining unmatched same-passage pairs
    go to the production adjudicator with both quotes shown; SAME at confidence ≥ 0.80
    counts as a match. Off by default so the headline number has no LLM in the loop.
- **Pass-specific rate** (headline 1). `unmatched / total` for each pass, reported in both
  directions (A→B and B→A) and as the mean. Paul's "nothing new on a second pass".
- **Passage coverage disagreement** (headline 2). Split the transcript into speaker turns
  (or 500-character windows when there are no labels). A turn is covered by a pass if any
  quote of that pass lands in it. Disagreement = turns covered by exactly one pass ÷ turns
  covered by either. Paul's "they shouldn't skip anything", independent of phrasing.
- **Same-passage miss rate.** Unmatched insights whose passage the other pass *did* quote
  (tier 2 passage test true, meaning test false) ÷ total. The consolidation misses; the
  quote gate (fix E) targets them.
- **Boundary share.** Share of unmatched insights whose quote lies within 300 characters
  of a chunk edge, against the same share for matched ones (1.5 is the baseline).
- **Secondary:** insights per chunk; share of insights whose quote failed to resolve
  (2–9% per copy today); within-pass duplicates (tier-1 matches inside one pass); fidelity
  flag rate from the PR #59 judge on a 40-insight sample, so an exhaustive prompt cannot
  pass by inventing.

### 3.2 Targets

| Metric | Baseline today | Release target | Stretch |
|---|---|---|---|
| Pass-specific rate, same copy twice | not yet measured (E1) | < 5% each direction | < 2% |
| Pass-specific rate, near-identical copies | 16–44% (post-consolidation, 1.2) | < 5% | < 2% |
| Passage coverage disagreement | ~40% of pass-specific facts have no counterpart | < 5% | < 2% |
| Same-passage misses surviving consolidation | 21 identical-quote splits / 84 pairs | 0 identical-quote splits; same-passage misses < 2% | 0 |
| Boundary share | 37% vs 29% | equal to matched facts' share (no edge excess) | — |
| Within-pass duplicates | not measured | < 3% | < 1% |
| Fidelity flag rate (PR #59 judge, 40-insight sample) | 8.9% (PR #59, Opus 5.5) | not more than 2 points above it (≤ 10.9%) | — |

### 3.3 The Script

`scripts/evalReproducibility.ts`, modelled on `scripts/evalExtractionPrompt.ts` (on `main`
since PR #59; same conventions: file-only, resumable per chunk, usage-guard check per pass,
`trackCliCost`, output under `scratchpad/extraction-compare/reproducibility/`).

```
npx tsx --env-file=.env.local scripts/evalReproducibility.ts <command>

fetch <id8> [<id8>…]       Read-only: the copies' transcript, timed_transcript, stored
                           chunks, stored insights and participant line → JSON.
chunk <id8> --mode chars|turns [--context N] [--hygiene live|cached|off]
                           Chunk locally; writes chunks.json with char offsets, the
                           before/after context windows and segment-derived timing.
                           Zero LLM cost unless hygiene=live.
extract <id8> --pass <n> [--prompt v1|v2|exhaustive] [--model …] [--backend cli|api]
        [--temperature 0] [--completeness] [--conc N]
                           One pass over the chunk file → pass-<n>.json. Resumable.
                           --temperature is accepted only with --backend api and a model
                           that still allows it (Haiku 4.5), otherwise refused.
topup <id8> [--model …]    The completeness call against the STORED insights of an
                           extracted episode → topup.json (what the library is missing).
match <id8>:<pass> <id8>:<pass> [--judge]
                           Tiers 1–2 (and 3 with --judge) → match-….json.
report                     REPORT.md + summary.json: every metric in 3.1 for every
                           pass pair, plus cost and wall-clock per pass.
baseline                   Read-only SQL (appendix A) → the numbers in section 1, so the
                           report always shows "before" next to "after".
```

Rules the script enforces: refuses to run `extract` or `topup` unless
`~/.claude/usage-guard/check.sh` exits 0; never imports `supabaseServer` write helpers
(`fetch` is the only DB access); concurrency default 8 and refuses 16 while a lane lock from
`lib/writerLock.ts` is held; every pass records model, backend, prompt version, chunk mode,
context size, hygiene mode, effort, temperature, start/end time and cost in its header.

Variant switches reuse `extractionConfig()` (on `main` since PR #59) (`EXTRACTION_PROMPT_VERSION`,
`EXTRACTION_GATE`, `EXTRACTION_REPAIR`, `EXTRACTION_MODEL`) and add
`EXTRACTION_CHUNKING=chars|turns`, `EXTRACTION_CONTEXT_CHARS`, `EXTRACTION_HYGIENE`,
`EXTRACTION_COMPLETENESS`. The harness lands as a PR against `main`, held until the parent window says "merge ok";
building it is roughly half a day and costs no LLM calls until `extract`
runs.

### 3.4 Baseline Without Re-Running

The `baseline` command re-issues the appendix A queries. The three doubled Drive pairs
stay the free test bed; the numbers in section 1 are the "before" column for every
report. They measure the *post-consolidation* view; E1/E2 add the pre-consolidation view
for the same episode.

---

## 4. Candidate Fixes (Recall First)

| Fix | What changes | Expected effect | Cost | Risk |
|---|---|---|---|---|
| **A. Exhaustive extraction prompt** | Replace the selectivity paragraphs with: list every distinct substantive claim in the text, one insight per claim, in the order spoken; completeness over brevity; never skip a claim because it seems minor, conversational or repeated (the library ranks, extraction does not); still one direct quote each; skip only greetings, logistics and ads. Keep PR #59's gate and repair; the fidelity judge remains the safety net. | Largest. Removes the "which few?" choice that produces the 40% recall gap and most scoping differences. Insights per chunk likely rise from ~3 to 6–9. | No extra extraction calls, ~2.5× output tokens. Consolidation (the expensive half, ≈ $3/episode of judge time today) scales with insight count: 2–3× judge calls per episode unless fix I trims them. | More low-value facts reach claims (mitigate: keep kind/importance fields and let synthesis rank); fidelity drift (mitigate: gate + judge; flag rate is a release criterion). |
| **B1. Context before and after (Paul's question)** | Each call receives three marked blocks: `CONTEXT BEFORE` (previous ~400 characters or the previous speaker turn), `TEXT TO ANALYZE` (the chunk), `CONTEXT AFTER` (next ~400 characters). Rule: extract every fact whose supporting words lie at least partly in `TEXT TO ANALYZE`; use the context to understand it and to complete a sentence that runs across the boundary; never extract a fact that lies entirely in a context block (the neighbouring chunk owns it). Quotes may extend into context; `resolveQuote` searches chunk plus context. | Removes the boundary drop directly: a fact spanning a cut is now fully visible to exactly one call. Expected to close the edge excess in 1.5 (37% → 29%). | ~800 extra input characters per call (≈ +10% input tokens), no extra calls. Prompt and `extractFromChunk` change; quote resolution gains a context span. | Double extraction of boundary facts by both neighbours if the ownership rule is ignored (mitigate: fix I catches it; measured as within-pass duplicates). |
| **B2. Speaker-turn chunking, deterministic, no overlap** | Build chunks from whole utterances in `timed_transcript`: group into turns, pack whole turns up to ~2,400 characters, split an over-long turn at sentence ends, no overlap (B1's context replaces it). Chunk timing = first/last segment, exact. Fallback to today's splitter when a source has no segments. | Boundaries land on conversational joints and depend only on who spoke when, so near-identical transcripts chunk alike; no sentence is cut; the double-extraction artefact disappears. | Code only; zero LLM cost. Chunk counts change, so runbook timings change. | Chunk size variance (long monologue → several chunks; many short turns → one chunk, fine). |
| **C. Hygiene made stable** | Cache `stripNonContent`'s removals per transcript hash (a `sources.hygiene_spans` column), or skip it for feeds whose ads are already cut. | Removes a hidden source of boundary drift and content loss between runs. | Cache: one column + one write per source. Skip: zero. | Skipping lets ads through on feeds that still carry them: decide per show. |
| **D. Completeness second look (two-pass union)** | After extracting a chunk, a second call sees the text, the context and the list already extracted and returns only claims not yet covered; union the two. Also usable as the *top-up* for already-extracted episodes (section 8). | Turns a one-shot list into a near-exhaustive set even if fix A under-delivers; the direct tool for Paul's "nothing new on a second pass". | Doubles extraction calls (the cheap half); see section 5 for both routes. | Second call may re-add near-duplicates or invent (mitigate: quote must resolve; tier-1 dedup against the first list; fidelity judge). |
| **E. Consolidation quote gate + quotes shown to the judge** | Beside `match_claims` (embedding), retrieve claims whose members' direct quotes overlap the new insight's quote (word 4-gram shingles or `pg_trgm` similarity on folded quotes, GIN-indexed) and send them to the judge regardless of embedding similarity. Show the judge both quotes. Note links as `quote-gate:judge:…`. | Fixes the "same passage, never merged" third: all 21 identical-quote splits would have reached the judge. | Migration (shingle column or trgm index) + ~60 lines in `consolidateSource`; a handful of extra judge calls per episode (≈ 4 s each). Backfill is a dry-run-then-apply sweep, no re-extraction. | The judge may still say DIFFERENT when one passage genuinely holds two facts; that is correct, the point is that the pair is judged. Coordinate with the dedup lane (88 groups, migration 038 not yet applied). |
| **F. Model tier (decided: Opus 5.5)** | PR #59 moved extraction from Haiku 4.5 to Opus 5.5 and Paul confirmed it (2026-11-08). The open question is the reverse: whether a cheaper model (Haiku 5.5, Sonnet 5.5) matches Opus on the recall bar, for the library top-up only. | Opus follows an "every fact" instruction most reliably; PR #59 measured 8.9% flagged vs 33.5% on Haiku 4.5. | Section 5, per pass and per library. | Newer models reason before answering, so run-to-run variance may not fall; E1b measures it. A cheaper model is used only if E4 shows parity. |
| **G. Smaller chunks** | ~1,200 characters (one or two turns). | "Everything in this text" is easier to honour in a small slice. | Doubles call count; on the subscription each call carries ~26k tokens of fixed context, the most expensive knob per fact. | Loses cross-sentence context (B1 mitigates). Try only if A+B+D fall short. |
| **H. Temperature 0** | Only on the API route, only on Haiku 4.5, only under the older API version (see section 5). | Reduces run-to-run variance on byte-identical input; does nothing for near-identical copies or for a selective prompt; the option is being removed from the API. | API credits, cheap (≈ $0.6–1.2 per #183 pass). | A dead end for production; worth one diagnostic run (E4c) to show how much of the noise floor is dice versus instructions. |
| **I. Within-source twin check** | During consolidation, insights from the same source whose quotes overlap are judged against each other first. | Removes the overlap/boundary double-extraction and gives fix A's longer lists a cheap first dedup. | Part of E. | None beyond E. |

**The fidelity judge is the safety net, not a filter at extraction time.** With A, B1 and D
the extractor is told to err toward inclusion; the PR #59 gate (quote must resolve, no
invented numbers) runs inline, and `extraction_fidelity` quarantines anything unfaithful
for review at `/admin/flags`. Omission is invisible; a quarantined fact is reviewable.

---

## 5. Two Billing Routes, Costed

Extraction runs today through `LLM_BACKEND=claude-code`: the local `claude -p` command line
on the subscription. The alternative is `LLM_BACKEND=api` with `ANTHROPIC_API_KEY`, billed in
credits. The judge and hygiene stay on the subscription in either case.

| | Route 1: subscription (`claude -p`) | Route 2: API credits |
|---|---|---|
| Models available for extraction | Haiku 4.5 (today), Haiku 5.5, Sonnet 5.5, Opus 5.5 | Same |
| Temperature control | None (the CLI has no flag) | Only Haiku 4.5, only under the older API version; rejected by Haiku 5.5, Sonnet 5.5, Opus 5.5 and by the current API version on every model |
| Billing | Plan usage, governed by the usage guard (stops at 90%) | Per token; no cap unless we add one |
| Fixed overhead per call | ~26k tokens of CLI context per call (mostly cache reads) | None |
| Shares capacity with | The judge, hygiene, the harness (16 in-flight slots) | Nothing on the subscription side |
| Code change | None | `apiText` gains an optional `temperature` for Haiku 4.5 and an API-version pin; one env switch |

**Unit assumptions.** Per call with the exhaustive prompt and context windows: ≈ 2.4k input
tokens, ≈ 3k output tokens (today: ≈ 2.1k in, ≈ 1.2k out). A #183 pass is 68 calls; an
average library episode is 50 chunks; the library is 21,952 chunks. A completeness top-up
call adds the stored insight list (≈ +0.5k input) and returns only what is missing (≈ 1.5k
output). API prices: Haiku 5.5 $0.10/$0.50, Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10, Opus 5.5
$4/$20 per million input/output tokens; Sonnet and Opus add ~30% output for reasoning at
low effort. Subscription "equivalents" scale PR #59's measured CLI cost ($2.72 Opus / $1.52
Sonnet per 55-chunk episode, Haiku estimated at a quarter of Opus) and are only a scale
for plan usage, not a bill.

### 5.1 One Pass of Episode #183 (68 Chunks)

| Model | API, today's output volume | API, exhaustive prompt | Subscription equivalent, exhaustive | Wall-clock (8–16 concurrent) |
|---|---|---|---|---|
| Haiku 4.5 (temperature 0 possible on API) | $0.6 | $1.2 | ≈ $1.4 plan-equivalent | 5–10 min |
| Haiku 5.5 | $0.06 | $0.12 | ≈ $0.3 | 3–5 min |
| Sonnet 5.5 | $1.2 | $3.0 | ≈ $3.0 | 5–10 min |
| **Opus 5.5 (decided)** | $2.3 | $6.0 | ≈ $5.5 (PR #59 measured $2.72 per 55 chunks at today's output) | ≈ 20 min (PR #59 measured 16.5 min per 55 chunks) |
| + completeness pass (fix D) | + same again | + same again | + same again | + 5–10 min |

### 5.2 One Average Episode in Production (50 Chunks, Extraction Only)

| Model | API, exhaustive | API, exhaustive + completeness | Subscription equivalent, exhaustive + completeness |
|---|---|---|---|
| Haiku 4.5 | $0.9 | $1.8 | ≈ $2 |
| Haiku 5.5 | $0.09 | $0.18 | ≈ $0.4 |
| Sonnet 5.5 | $2.2 | $4.4 | ≈ $4.4 |
| **Opus 5.5 (decided)** | $4.4 | $8.8 | ≈ $8 |

Consolidation (Opus judge on the subscription, ≈ $3/episode today) is unchanged by the route
and rises with insight count: budget 2–3× once extraction is exhaustive.

### 5.3 The Whole Library (440 Episodes, 21,952 Chunks)

| Model | Completeness top-up (one call per chunk, additive) | Full re-extraction (exhaustive) | Wall-clock |
|---|---|---|---|
| Haiku 5.5, API | **≈ $25** | ≈ $40 | ≈ 6 h at 16 concurrent |
| Haiku 4.5, API | ≈ $230 | ≈ $390 | ≈ 6 h |
| Sonnet 5.5, API | ≈ $550 | ≈ $900 | ≈ 6 h |
| **Opus 5.5, API (decided model)** | ≈ $1,100 | ≈ $1,800 | ≈ 6 h |
| Any model, subscription | plan usage (Haiku ≈ $300 equivalent, Opus ≈ $1,100) | roughly double | **≈ 49 h of lane time** (8 min per 60 calls) |

Plus consolidation of whatever the top-up adds (unknown until E5b measures it on #183;
if the recall gap is ~30%, expect ~20,000 new insights library-wide and ~$1,000–1,500 of
judge time on the subscription spread over the batches).

**Reading the tables.** Temperature 0 is the one thing only Route 2 offers, and it is
confined to the model we most want to move away from. The real reason to consider Route 2 is
capacity and isolation: the top-up of 440 episodes is 22,000 calls, two days of lane time on
the subscription against six hours on the API, without competing with the judge for the
CLI's slots. With Opus 5.5 decided, the library top-up costs about $1,100 of API credits or about
49 hours of subscription lane time; E4 tells us whether a cheaper model could take the
top-up without lowering the bar, and that is Paul's call.

---

## 6. Experiment Sequence on Episode #183

Episode #183 (68 chunks per copy, 28.5k words, copies differ by 30 characters) is the
cleanest pair. Everything below is **file-only** through the harness: no `raw_insights`,
`chunks`, `claims` or `jobs` writes; one read-only database fetch for the inputs (PR #59's
8-episode inputs at `scratchpad/extraction-compare-pr59/` are Attia episodes and do not
include the twins). Paul approved the spend on 2026-11-08; the lanes stay stopped throughout.
The runs happen in a Sonnet session ("LA/Extraction reproducibility experiments") and this
plan's author reviews the numbers. Concurrency 8; usage guard checked before every pass;
`caffeinate` on AC power; output under `scratchpad/extraction-compare/reproducibility/`.

| # | Experiment | Isolates | Passes | Decision rule | Content tokens | Wall-clock | Cost (plan-usage equiv. / API) |
|---|---|---|---|---|---|---|---|
| **E1a** | Copy A twice, the configuration that built the library (Haiku 4.5, v1 prompt, char chunks, live hygiene, CLI) | Noise floor of the old pipeline; proves the harness | 2 | Always first. Expect 15–25% pass-specific. Report to the parent window. | 0.5M | 20 min | ≈ $1.8 / — |
| **E1b** | Copy A twice, `main` today (Opus 5.5, v2 prompt, gate + repair, char chunks, live hygiene, CLI) | How much PR #59 already closed | 2 | Report to the parent window. If same-copy < 5%, run copy B once against E1b as the cross-copy check and skip E2. | 0.5M | 40 min | ≈ $6.7 / $4.6 |
| **E2** | Exhaustive prompt (fix A) on Opus 5.5, char chunks: A×2 + B×1 | The prompt alone | 3 | If same-copy and cross-copy < 5%, E3 runs as 2 passes to confirm B1/B2 do no harm. | 1.2M | 60 min | ≈ $18 / $18 |
| **E3** | E2 + context before/after + speaker-turn chunks + cached hygiene (fixes B1, B2, C): A×2 + B×1 | Boundaries and context | 3 | Boundary share should fall to the matched facts' share; coverage disagreement < 5%. | 1.2M | 60 min | ≈ $18 / $18 |
| **E4** | E3 configuration on cheaper models, CLI: Haiku 5.5 A×2, Sonnet 5.5 A×2 | Whether a cheaper model matches Opus (for the top-up only) | 4 | Informational: Opus 5.5 is decided. A model within 1 point of Opus on every metric becomes a top-up option for Paul. | 1.6M | 30 min | ≈ $7 / $6 |
| **E4c** (optional, API credits) | E3 configuration on Haiku 4.5, API route, temperature 0: A×2 | Dice versus instructions | 2 | Diagnostic only; needs the parent window's ok to spend API credits. | 0.8M | 10 min | — / $2.4 |
| **E5a** | Completeness second look (fix D) on the E3 configuration: A×2 + B×1 | Recall top-up | 3 (+3 completeness calls per chunk) | Only if E3 still ≥ 5%; tell the parent window first. | 2.4M | 120 min | ≈ $33 / $36 |
| **E5b** | `topup` against the STORED insights of copy A (the library's current facts for #183) | How much the library is missing today | 1 | Sizes section 8; tell the parent window first. | 0.4M | 20 min | ≈ $4 / $4.4 |
| **E6** | Quote-gate replay (fix E): the best configuration's unmatched same-passage pairs to the production judge with quotes shown, offline | Consolidation gate | 0 (60–120 judge calls) | Report how many surviving pass-specific facts the gate would merge. | 0.1M | 8 min | ≈ $1 / — |
| **E7** | Smaller chunks (fix G, ~1,200 characters) with context windows: A×2 | Last resort | 2 | Only if E5a still ≥ 5%; tell the parent window first. | 0.6M | 30 min | ≈ $7 / $7 |
| | **Likely path (E1a, E1b, E2, E3, E4, E6)** | | 14 passes | | **≈ 5M** | **≈ 3.6 h** | **≈ $52 / ≈ $47** |
| | **Everything** | | 22 passes (+3 completeness) | | **≈ 9.5M** | **≈ 6.5 h** | **≈ $100 / ≈ $100** |

Each experiment is reported where the table says so before the next starts; the "decision
rule" column says when to stop. Costs are extraction only; the harness's own matching uses
embeddings (cents) and no judge unless `--judge` is passed. Opus pass time is PR #59's
measured 16.5 minutes per 55 chunks scaled to 68 chunks; Haiku 4.5 passes are faster per
call but the CLI's fixed overhead dominates either way.

Preconditions for every run: lanes stopped (they are); usage guard green; AC power and
`caffeinate`; concurrency 8; output under `scratchpad/extraction-compare/reproducibility/`;
the final report posted as an artifact for Paul with the before/after table.
---

## 7. Criteria for Resuming the Lanes

Transcription continues throughout; nothing here touches it.

**Extraction lane resumes when all of these hold:**

1. On episode #183, same copy twice, pass-specific rate **< 5%** in both directions
   (stretch 2%).
2. On the #183 twin copies, pass-specific rate **< 5%** in both directions.
3. Passage coverage disagreement **< 5%** on both comparisons.
4. Boundary share of unmatched facts no higher than that of matched facts (the edge
   excess in 1.5 is gone).
5. Fidelity flag rate on a 40-insight sample **not more than 2 points above** PR #59's
   figure for Opus 5.5 (8.9%) (recall must not be bought with invention).
6. Within-pass duplicates **< 3%**, or fix I is live to absorb them.
7. One episode of a currently running show (FoundMyFitness or Huberman) extracted
   end-to-end in dry-run with the chosen configuration, and its report attached, so the
   bar is shown to hold off the test bed.
8. `docs/EXTRACTION_RUNBOOK.md` updated per section 9 and the reproducibility gate (new
   §15) in place.

**Consolidation lane resumes when:** the quote gate (fix E, with fix I) is merged, and its
dry run on the three twin pairs merges at least 20 of the 21 identical-quote splits with a
sample of 40 proposed merges reviewed by Paul at `/admin/reviews` and none judged wrong.
This can happen before the extraction lane resumes; consolidating insights already
extracted does not make the later top-up harder, because the top-up is additive.

**Not required to resume:** re-running the already-extracted episodes (section 8 is a
separate decision), or the model change (section 6 E4 decides it; the bar is the metric,
not the model).

---

## 8. Episodes Already Extracted

**Do they need a second pass? Yes, a targeted one.** All 440 were extracted under "prefer
fewer" with mid-sentence cuts, so each carries a recall gap the plan estimates at 20–40%
(E5b measures it exactly on #183). The 237 transcribed-but-not-extracted sources do not: they
will be extracted under the new configuration.

**Recommended: the completeness top-up, not re-extraction.** One call per chunk receives the
chunk, its context windows and the facts already stored for it, and returns only what is
missing. Everything Paul has reviewed stays; new facts are added and consolidated as any
new insight would be, through the quote gate. Costs are in 5.3: on Opus 5.5, about $1,100 via
the API or about 49 hours of lane time on the subscription; a cheaper model only if E4 shows
it matches Opus on the bar. Plus consolidation of what is added. Order: shows Paul publishes from first; one episode per show first as a
check; the twins last (they are also the measuring stick).

**Not recommended: full re-extraction.** It would create a second complete set of 69,417-plus
insights alongside the first (raw insights are immutable), roughly double the cost, and
re-open every reviewed claim.

**Cheap and safe now: the quote-gate sweep (fix E as a backfill).** A sweep over existing
claims whose members' quotes overlap (within a source, and across twin copies) sends only
those pairs to the judge; merges only, no insight writes. Dry run → counts and examples
for Paul → apply, together with the dedup lane (88 duplicate groups, migration 038).

**Twin copies.** Once the gate exists, the three Drive pairs should merge to a single set of
claims; the caption-retirement plan (`docs/caption-retirement-plan.md`) already covers
deleting the superseded copy.

---

## 9. Changes to `docs/EXTRACTION_RUNBOOK.md`

To be written when the fixes ship, not now:

1. **§2 "What proceed with extraction runs".** Document the switches
   (`EXTRACTION_PROMPT_VERSION`, `EXTRACTION_CHUNKING`, `EXTRACTION_CONTEXT_CHARS`,
   `EXTRACTION_HYGIENE`, `EXTRACTION_COMPLETENESS`, `EXTRACTION_MODEL`, `LLM_BACKEND`) and
   their production defaults; a batch is one configuration and the runner never changes
   them mid-batch.
2. **§8 "How long an episode takes".** Chunk counts change with speaker-turn chunking,
   insights per chunk roughly double or triple, the completeness pass doubles extraction
   calls, and the API route has no CLI overhead: re-measure and replace the 8 min / 17–30
   min figures. Consolidation grows with insight count; the quote gate adds judge calls.
3. **§9 lanes.** The consolidate lane gains the quote gate; note the `quote-gate:judge:…`
   link notes. Add the top-up as a lane variant (`--topup`) with the same locks.
4. **New §15 "Reproducibility gate".** After any change to prompt, model, chunking,
   context, hygiene or backend, and before a batch: run the harness on one episode per
   show (E1-style, same copy twice) and attach the report; the batch does not start if
   pass-specific ≥ 5%, coverage disagreement ≥ 5%, or the fidelity flag rate rose more
   than 2 points. The three Drive pairs remain the standing cross-copy check.
5. **§1 pre-flight.** Add "usage guard green and no harness run in progress" (the harness
   and a live run share the CLI's 16 slots); on the API route, add the credit balance.
6. **§5 reporting.** Add insights per chunk, boundary share and, when a twin exists, the
   reproducibility figure to the end-of-run report, so drift is seen early.

---

## 10. Decisions Paul Owns

1. ~~Approve E1 and the half-day harness build.~~ **Approved 2026-11-08** ("Let's do the
   experiment spend", relayed by the parent window). The likely path E1a → E1b → E2 → E3 →
   E4 → E6 runs in a Sonnet session; E5 and E7 only if the decision rules call for them,
   and the parent window hears before either starts.
2. Confirm the resume bar in section 7 (5% / 5% / +2 points), or set a different one.
3. Keep anecdotes and conversational facts under "capture everything" (kept as kind
   `Anecdote` for synthesis to rank) or still drop them at extraction.
4. ~~Model tier.~~ **Decided: Opus 5.5** (PR #59, confirmed 2026-11-08). Open: whether a
   cheaper model may run the library top-up if E4 shows it matches Opus on the bar.
5. Approve the library top-up (section 8) once E5b shows the size of the gap, and choose
   its route (API ≈ 6 hours and ≈ $1,100 on Opus, or subscription ≈ 49 hours of lane time).
6. "Merge ok" for the harness PR and for each fix PR (B1, B2, C, A, D, E) as it is ready.

Fixes B1, B2 and C (context windows, speaker-turn chunking, stable hygiene) cost no model
calls and should ship with the next extraction PR regardless of the experiments' outcome.

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

-- A5: boundary share (table 1.5): quote offsets are chunk-relative
with pairs(a,b) as (values ('291281d6-1ede-41dc-becd-deba77333d7c'::uuid,'3d6c7c5f-ba1b-4587-8b7d-30cc8e74cd2c'::uuid)),
mem as (select ri.id, ri.chunk_id, ri.quote_char_start qs, ri.quote_char_end qe, cm.claim_id,
          case when ri.source_id=p.a then 'A' else 'B' end side
        from pairs p join raw_insights ri on ri.source_id in (p.a,p.b)
        join claim_members cm on cm.raw_insight_id=ri.id),
cl as (select claim_id, bool_or(side='A') has_a, bool_or(side='B') has_b from mem group by 1),
x as (select m.*, length(c.content) clen, (cl.has_a and cl.has_b) shared
      from mem m join cl using (claim_id) join chunks c on c.id=m.chunk_id where m.qs is not null)
select shared, count(*) n,
  round(100.0*count(*) filter (where qs < 300 or qe > clen-300)/count(*),1) pct_in_edge_300,
  round(100.0*count(*) filter (where qs < 200 or qe > clen-200)/count(*),1) pct_in_overlap_200
from x group by 1;

-- A6: library-wide cut quality and quote length
select round(100.0*count(*) filter (where content ~ '[.!?]["”'')\]]*\s*$')/count(*),1) pct_chunks_end_at_sentence,
       round(100.0*count(*) filter (where content ~ '^[A-Z][a-z]+( [A-Z][a-z]+)*: ')/count(*),1) pct_chunks_start_on_turn
from chunks;
select percentile_cont(0.5) within group (order by length(direct_quote)) median_quote_chars,
       round(100.0*count(*) filter (where length(direct_quote) > 200)/count(*),1) pct_quotes_longer_than_overlap
from raw_insights where direct_quote is not null;
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
boundary_share(S)  = |{x in S : x.quote_start < 300 or x.quote_end > chunk_len - 300}| / |S|
```

## Appendix C. The Context-Window Call Shape (Fix B1)

```
Participants in this recording — <names>

CONTEXT BEFORE (for understanding only; do not extract facts that lie entirely here):
<previous ~400 characters, or the previous speaker turn>

TEXT TO ANALYZE (extract every fact whose supporting words lie at least partly here):
<chunk: whole speaker turns, ~2,400 characters, no overlap with its neighbours>

CONTEXT AFTER (for understanding only; do not extract facts that lie entirely here):
<next ~400 characters, or the next speaker turn>
```

The direct quote may run from the text into a context block; `resolveQuote` searches the
three blocks joined in order. A fact that lies entirely in a context block belongs to the
neighbouring chunk, which sees it as its own text.
